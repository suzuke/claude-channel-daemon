# Multi-Channel Architecture Design

## Problem

claude-channel-daemon 目前硬綁官方 `telegram@claude-plugins-official` plugin，存在三個問題：

1. **多專案需求** — 想用多個 Telegram bot 對應不同專案，各自獨立運行
2. **官方 plugin 風險** — 官方升級可能破壞流程，且分散在不同 plugin 中無法統一掌控
3. **多平台擴展** — 未來要接 Discord 等其他 channel，需要統一抽象層

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  Fleet Manager (ccd fleet start/stop/status) │
│  讀取 fleet.yaml，spawn N 個 daemon process  │
└──────┬──────────┬──────────┬────────────────┘
       ▼          ▼          ▼
   [daemon-A] [daemon-B] [daemon-C]  ← 各自獨立 process
```

每個 daemon instance 內部：

```
┌──────────────────────────────────────────┐
│           Channel Adapters               │
│  ┌──────────┐ ┌──────────┐ ┌─────────┐  │
│  │ Telegram  │ │ Telegram │ │ Discord │  │
│  │ (bot A)   │ │ (bot B)  │ │ (未來)  │  │
│  └─────┬─────┘ └────┬─────┘ └────┬────┘  │
│        └──────┬──────┘────────────┘       │
│               ▼                           │
│        Message Bus                        │
│    (匯流 inbound / 路由 outbound /        │
│     approval race)                        │
│               ▼                           │
│        MCP Channel Server                 │
│    (reply / react / edit / download)      │
│               ▼                           │
│        Daemon Core                        │
│    ┌──────────────────────────┐           │
│    │ Approval Server (HTTP)   │           │
│    │ PTY Detector             │           │
│    │ → channelBus.requestApproval()       │
│    ├──────────────────────────┤           │
│    │ Process Manager (node-pty)│          │
│    │ Context Guardian          │          │
│    │ Memory Layer → SQLite     │          │
│    └──────────────────────────┘           │
└──────────────────────────────────────────┘
```

## Decision: Multi-instance Model

每個 daemon instance = 1 個專案 + 1~N 個 channel adapter + 1 個 Claude session。

採用 **多 process** 而非單 process 管多專案：
- Claude Code 一次只能跑一個 session，多專案必然是多個 `claude` process
- 故障隔離 — 一個專案掛了不影響其他
- Fleet manager 只是啟停和監控的薄 wrapper

## Channel Abstraction Layer

### ChannelAdapter Interface

```typescript
interface ChannelAdapter {
  readonly type: string;         // "telegram" | "discord" | ...
  readonly id: string;           // unique adapter ID within instance

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Inbound — adapter 收到訊息時 emit
  on(event: 'message', handler: (msg: InboundMessage) => void): void;

  // Outbound
  sendText(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage>;
  sendFile(chatId: string, filePath: string): Promise<SentMessage>;
  editMessage(chatId: string, messageId: string, text: string): Promise<void>;
  react(chatId: string, messageId: string, emoji: string): Promise<void>;

  // Approval — 送審批按鈕，callback 回傳結果
  sendApproval(chatId: string, prompt: string,
    callback: (decision: 'approve' | 'deny') => void): void;

  // Attachment
  downloadAttachment(fileId: string): Promise<string>;

  // Access control
  handlePairing(chatId: string, userId: string): Promise<string>;
  confirmPairing(code: string): Promise<boolean>;
}
```

### InboundMessage

```typescript
interface InboundMessage {
  source: string;              // adapter type
  adapterId: string;           // which adapter instance
  chatId: string;
  messageId: string;
  userId: string;
  username: string;
  text: string;
  timestamp: Date;
  attachments?: Attachment[];
  replyTo?: string;
}
```

### Attachment

```typescript
interface Attachment {
  kind: 'photo' | 'document' | 'audio' | 'voice' | 'video' | 'sticker';
  fileId: string;
  localPath?: string;          // photo/voice 自動下載
  mime?: string;
  size?: number;
  filename?: string;
  transcription?: string;      // voice → STT result
}
```

Multimedia strategy:
- **Photo** — adapter 自動下載到 inbox，`localPath` 直接可用
- **Voice** — 自動下載 + 語音轉文字（Groq/Whisper），結果放 `transcription`
- **Document/Video/Audio** — 不自動下載，Claude 需要時透過 `download_attachment` 拉取
- **Sticker** — 下載 webp 或轉 description

### MessageBus

匯流多個 adapter 的 inbound，路由 outbound，處理 approval race。

```typescript
class MessageBus {
  private adapters: ChannelAdapter[] = [];

  register(adapter: ChannelAdapter): void;
  unregister(adapterId: string): void;

  // Inbound: 所有 adapter 的訊息匯流
  on(event: 'message', handler: (msg: InboundMessage) => void): void;

  // Outbound: 指定 target adapter+chat 或 broadcast
  send(target: Target, msg: OutboundMessage): Promise<void>;

  // Approval: 發到所有 channel，先回的算數
  requestApproval(prompt: string): Promise<ApprovalResponse>;
}

interface ApprovalResponse {
  decision: 'approve' | 'deny';
  respondedBy: { channelType: string; userId: string };
}

interface Target {
  adapterId?: string;          // 指定 adapter，省略則 broadcast
  chatId: string;
}
```

Approval race: `requestApproval` 同時呼叫所有 adapter 的 `sendApproval`，任一回應即 resolve，其餘取消。Timeout 2 分鐘 auto-deny。

## Built-in MCP Channel Server

Daemon 內建 MCP server，取代官方 telegram plugin。Claude Code 透過 `--channels` 連接。

### MCP Tools (channel-agnostic)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `reply` | `chat_id`, `text`, `files?`, `reply_to?` | Send message |
| `react` | `chat_id`, `message_id`, `emoji` | Add reaction |
| `edit_message` | `chat_id`, `message_id`, `text` | Edit message |
| `download_attachment` | `file_id` | Download and return local path |

Tool interface 與官方 plugin 一致 — Claude 端無需學習新 API。底層改為透過 MessageBus → ChannelAdapter。

### Inbound Message Injection

Adapter 收到使用者訊息 → MessageBus → MCP server 透過 channel protocol 推送給 Claude。格式沿用 `<channel source="..." chat_id="..." ...>` tag。

### Approval Integration

- PreToolUse hook POST 到 approval server endpoint
- Approval server 呼叫 `messageBus.requestApproval()` 而非直接呼叫 Telegram API
- PTY prompt detector 也呼叫 `messageBus.requestApproval()`
- 統一的 approval 路徑，消除 daemon/plugin 間的邏輯分裂

## Access Control

每個 adapter 獨立管理自己的 access：

```typescript
interface AccessConfig {
  mode: 'pairing' | 'locked';
  allowed_users: number[];
  max_pending_codes: number;      // default 3
  code_expiry_minutes: number;    // default 60
}
```

State machine:
- `pairing` — 新用戶 DM 時發 pairing code，確認後加入 `allowed_users`
- `locked` — 只有 `allowed_users` 能用，unknown sender 直接丟棄

Management:
```
ccd access <instance> lock
ccd access <instance> unlock
ccd access <instance> list
ccd access <instance> remove <uid>
ccd access <instance> pair <code>
```

Security: channel 內訊息要求改 access 一律拒絕（防 prompt injection）。

## Fleet Management

### Fleet Config: `~/.claude-channel-daemon/fleet.yaml`

```yaml
defaults:
  restart_policy:
    max_retries: 10
    backoff: exponential
    reset_after: 300
  context_guardian:
    threshold_percentage: 80
    max_age_hours: 4
    strategy: hybrid
  memory:
    watch_memory_dir: true
    backup_to_sqlite: true
  log_level: info

instances:
  project-a:
    working_directory: /path/to/project-a
    channels:
      - type: telegram
        bot_token_env: PROJECT_A_BOT_TOKEN
        access:
          mode: pairing
          allowed_users: [123456789]
    # override defaults
    context_guardian:
      threshold_percentage: 60

  project-b:
    working_directory: /path/to/project-b
    channels:
      - type: telegram
        bot_token_env: PROJECT_B_BOT_TOKEN
        access:
          mode: locked
          allowed_users: [123456789, 987654321]
```

Design decisions:
- Bot token 不直接寫 yaml — `bot_token_env` 指向環境變數，安全性更好
- `defaults` + per-instance override via deep merge
- 一個 instance 可以有多個 channels（同類型或不同類型皆可）

### CLI Commands

```
# Fleet management
ccd fleet start                  # Start all instances
ccd fleet stop                   # Stop all instances
ccd fleet start <instance>       # Start single instance
ccd fleet stop <instance>        # Stop single instance
ccd fleet status                 # List all instance states
ccd fleet logs <instance>        # Tail specific instance log

# Single-instance mode (backward compatible)
ccd start                        # Uses config.yaml, old behavior
```

### Process Management

- 每個 instance 是獨立 child process (fork)
- Data directory: `~/.claude-channel-daemon/instances/<name>/`
  - `daemon.pid`
  - `daemon.log`
  - `session-id`
  - `statusline.json`

### Service Installation

`ccd fleet install` 產生一個 launchd plist / systemd service，執行 `ccd fleet start`。一個 service 管整個 fleet，加新專案只改 `fleet.yaml`。

## Module Structure

```
src/
├── cli.ts                     # CLI entry (ccd start/stop/fleet/access)
├── fleet-manager.ts           # fleet start/stop/status, spawn child processes
├── daemon.ts                  # Single instance main logic
├── process-manager.ts         # PTY management, session resume (existing, adapted)
├── context-guardian.ts        # Context rotation (existing, unchanged)
├── memory-layer.ts            # Memory backup (existing, unchanged)
├── db.ts                      # SQLite (existing, unchanged)
├── config.ts                  # Read fleet.yaml + deep merge defaults
├── logger.ts                  # Pino logging (existing, unchanged)
│
├── channel/
│   ├── types.ts               # ChannelAdapter interface, InboundMessage, Attachment
│   ├── message-bus.ts         # MessageBus — merge inbound / route outbound / approval race
│   ├── mcp-server.ts          # Built-in MCP server, bridges Claude ↔ MessageBus
│   ├── access-manager.ts      # Pairing / locked state machine, allowlist
│   └── adapters/
│       └── telegram.ts        # TelegramAdapter implements ChannelAdapter
│
├── approval/
│   ├── approval-server.ts     # HTTP server (PreToolUse hook endpoint)
│   └── pty-detector.ts        # PTY prompt detection (extracted from cli.ts)
│
└── types.ts                   # Global types (config schema, etc.)
```

### Dependency Changes

- **Add**: `@modelcontextprotocol/sdk` (build MCP server), `grammy` (Telegram Bot API)
- **Remove**: dependency on `telegram@claude-plugins-official` plugin

### Existing Code Impact

| Current File | Change |
|-------------|--------|
| `cli.ts` | Split → `cli.ts` (pure CLI) + `daemon.ts` (instance logic) + `fleet-manager.ts` |
| `process-manager.ts` | Keep, remove Telegram hardcoding, use `messageBus` |
| `context-guardian.ts` | Unchanged |
| `memory-layer.ts` | Unchanged |
| `db.ts` | Unchanged |
| `config.ts` | Extend for `fleet.yaml` format |
| `types.ts` | Extend |
| `setup-wizard.ts` | Adapt for fleet init + channel type selection |

## Scope

### In Scope (this iteration)
- Channel abstraction layer (interface + MessageBus)
- Telegram adapter (replaces official plugin)
- Built-in MCP channel server
- Unified approval system
- Fleet management (fleet.yaml + CLI)
- Access control with pairing + locked modes
- Multimedia support (photo, voice, document)

### Out of Scope (future)
- Discord adapter
- Cross-channel message forwarding
- Adapter hot-plug (runtime add/remove without restart)
- Slack / other platform adapters
