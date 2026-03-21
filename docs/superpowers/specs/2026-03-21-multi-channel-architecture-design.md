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
┌──────────────────────────────────────────────┐
│         Channel Adapter (共用 bot)            │
│  ┌───────────────────────────────────────┐   │
│  │ Telegram Forum Group                  │   │
│  │  ├─ Topic "project-a" → daemon-A     │   │
│  │  ├─ Topic "project-b" → daemon-B     │   │
│  │  └─ Topic "project-c" → daemon-C     │   │
│  └───────────────────────────────────────┘   │
│               ▼                              │
│  Message Bus + Message Queue                 │
│  (匯流 inbound / 路由 outbound /             │
│   approval race / rate limiting /            │
│   tool tracking + in-place edit)             │
│               ▼                              │
│  MCP Channel Server (local plugin)           │
│  (reply / react / edit / download)           │
│               ▼                              │
│  Daemon Core                                 │
│  ┌─────────────────────────────────┐         │
│  │ Approval Server (HTTP)          │         │
│  │ Tmux Prompt Detector            │         │
│  │ → messageBus.requestApproval()  │         │
│  ├─────────────────────────────────┤         │
│  │ Tmux Manager (replaces node-pty)│         │
│  │ Context Guardian                │         │
│  │ Transcript Monitor (byte-offset)│         │
│  │ Memory Layer → SQLite           │         │
│  └─────────────────────────────────┘         │
└──────────────────────────────────────────────┘
```

## Decision: Multi-instance Model

每個 daemon instance = 1 個專案 + 1 個 Claude session。多個 instance 可共用同一個 channel adapter（透過 Topic/Thread routing）。

採用 **多 process** 而非單 process 管多專案：
- Claude Code 一次只能跑一個 session，多專案必然是多個 `claude` process
- 故障隔離 — 一個專案掛了不影響其他
- Fleet manager 只是啟停和監控的薄 wrapper

## Topic Mode: Thread-Based Routing

### 核心概念

一個 bot + 一個 Forum Group，每個 Topic/Thread 對應一個 daemon instance。

**跨平台 thread 映射：**

| 平台 | Thread 概念 | 識別符 |
|------|-----------|--------|
| Telegram | Forum Topic | `message_thread_id` |
| Discord | Text Channel / Forum Channel | `channel_id` |
| Slack | Channel | `channel` |
| Matrix | Room in Space | `room_id` |

**優勢：**
- 新增專案只要在 Group 裡開新 Topic — 秒級，不需要再建 bot
- 所有專案在同一個地方，像 Slack channels 一樣組織
- 通知管理更方便（mute 單一 topic 或整個 group）
- 團隊共享只要加入 group

### Topic-Instance 綁定

```yaml
# fleet.yaml — Topic mode
channel:
  type: telegram
  mode: topic                          # "topic" | "dm"
  bot_token_env: CCD_BOT_TOKEN
  group_id: -1001234567890             # Forum Group ID
  topic_bindings:
    project-a: 42                      # topic_id → instance name
    project-b: 87
  access:
    mode: locked
    allowed_users: [123456789]
```

也支援傳統 DM mode（`mode: dm`）：每個 instance 用獨立 bot，訊息走 DM chat。向下相容。

### 新 Topic 綁定流程

1. 使用者在 Group 裡建新 Topic「project-c」
2. 在 Topic 裡發訊息
3. Bot 偵測到未綁定的 topic → 回覆「此 topic 尚未綁定任何專案」
4. Operator 執行 `ccd topic bind project-c <topic_id>` 或透過 inline keyboard 選擇
5. Fleet manager 更新 config，啟動對應 daemon instance

## Channel Abstraction Layer

### ChannelAdapter Interface

```typescript
interface ChannelAdapter {
  readonly type: string;         // "telegram" | "discord" | ...
  readonly id: string;           // unique adapter ID

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Inbound — adapter 收到訊息時 emit
  on(event: 'message', handler: (msg: InboundMessage) => void): void;

  // Outbound
  sendText(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage>;
  sendFile(chatId: string, filePath: string, opts?: SendOpts): Promise<SentMessage>;
  editMessage(chatId: string, messageId: string, text: string): Promise<void>;
  react(chatId: string, messageId: string, emoji: string): Promise<void>;

  // Approval — adapter 內部決定送到哪個 chat/thread
  sendApproval(prompt: string,
    callback: (decision: 'approve' | 'deny') => void,
    signal?: AbortSignal): ApprovalHandle;

  // Attachment
  downloadAttachment(fileId: string): Promise<string>;

  // Access control
  handlePairing(chatId: string, userId: string): Promise<string>;
  confirmPairing(code: string): Promise<boolean>;
}

interface ApprovalHandle {
  cancel(): void;
}

interface SendOpts {
  threadId?: string;        // topic/thread ID for routing
  replyTo?: string;
  format?: 'text' | 'markdown';
  chunkLimit?: number;      // default 4096 for Telegram
}

interface SentMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
}

interface OutboundMessage {
  text?: string;
  filePath?: string;
  threadId?: string;
  replyTo?: string;
  format?: 'text' | 'markdown';
}
```

### InboundMessage

```typescript
interface InboundMessage {
  source: string;              // adapter type
  adapterId: string;           // which adapter instance
  chatId: string;
  threadId?: string;           // topic/channel/room ID
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

  // Inbound: 所有 adapter 的訊息匯流（按 threadId 路由到對應 instance）
  on(event: 'message', handler: (msg: InboundMessage) => void): void;

  // Outbound: 指定 target adapter+chat+thread 或 broadcast
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
  threadId?: string;           // topic/channel routing
}
```

**Approval race 機制：**
1. `requestApproval` 建立一個 `AbortController`
2. 同時呼叫所有 adapter 的 `sendApproval()`，傳入 `AbortSignal`
3. 任一 adapter 的 callback 觸發 → resolve Promise + abort 其餘
4. 被 abort 的 adapter 呼叫自身 `ApprovalHandle.cancel()` 撤回按鈕
5. Abort 後的 late click 靜默忽略（adapter 檢查 signal.aborted）
6. Timeout 2 分鐘 → abort all + auto-deny

## Message Queue + Rate Limiting

每個 adapter 內建 per-chat/thread 訊息佇列，解決密集操作時的 Telegram API rate limit 問題。

### 設計

```typescript
interface MessageQueue {
  // 入隊一條訊息（不立即發送）
  enqueue(chatId: string, threadId: string | undefined, msg: QueuedMessage): void;
  // 啟動 worker — 每個 chat/thread 一個 FIFO consumer
  start(): void;
  stop(): void;
}

interface QueuedMessage {
  type: 'content' | 'status_update' | 'status_clear';
  text?: string;
  filePath?: string;
  editMessageId?: string;    // 如果是 edit 而非 send
}
```

**行為：**
- **合併相鄰 content 訊息** — 如果 queue 裡連續多條 content，合併成一條（上限 4096 字元）再發送
- **Status message editing** — status_update 類型不新發訊息，而是 edit 上一條 status 訊息（減少通知）
- **Rate limit 退避** — 收到 429 時指數退避（1s → 2s → 4s），暫停該 chat 的 queue
- **Flood control** — 當退避超過 10 秒，丟棄 status_update 類型（只保留 content）

## Tool Tracking + In-Place Edit

Claude 密集操作時（連續 Read/Edit/Bash），不再每個 tool call 發一條 Telegram 訊息。

### 設計

Transcript monitor 追蹤 tool_use → tool_result 配對：

```typescript
interface ToolTracker {
  // 收到 tool_use → 建立 pending entry + 發送/更新 status 訊息
  onToolUse(toolName: string, input: unknown): void;
  // 收到 tool_result → 更新 status 訊息（edit_message），標記完成
  onToolResult(toolName: string, output: unknown): void;
}
```

**行為：**
- 第一個 tool_use → 發送一條 status 訊息「🔧 Read: /path/to/file...」
- 後續 tool_use → **edit** 同一條訊息，追加新行「🔧 Edit: /path/to/file...」
- tool_result → 更新對應行的狀態（✅ 或 ❌）
- Claude 的最終文字回覆 → 新訊息（觸發 push notification）

**效果：** 20 個 tool call 只產生 1 條不斷更新的 status 訊息 + 1 條最終回覆，而非 21 條通知。

## Process Management: Tmux (replaces node-pty)

### 為什麼換

node-pty 的 PTY 生命週期綁定 daemon process — daemon crash = Claude 死 = session 丟失。

Tmux 將 Claude 運行在獨立的 terminal session 中，daemon crash 後 Claude 繼續跑，daemon 重啟後 reattach。

### 架構

```
daemon process                    tmux session "ccd"
  ├── TmuxManager                   ├── window @0: claude (project-a)
  │   ├── send-keys                 ├── window @1: claude (project-b)
  │   ├── pipe-pane (output)        └── window @2: claude (project-c)
  │   └── capture-pane (screenshot)
  ├── MessageBus
  ├── IPC server (channel.sock)
  └── Approval server
```

**每個 daemon instance 對應一個 tmux window。** Fleet manager 用一個 tmux session（名稱 `ccd`），每個 instance 一個 window。

### TmuxManager Interface

```typescript
class TmuxManager {
  constructor(private sessionName: string, private windowId: string) {}

  // Lifecycle
  async createWindow(command: string, cwd: string): Promise<string>;  // returns window ID
  async killWindow(): Promise<void>;
  async isWindowAlive(): Promise<boolean>;

  // I/O
  async sendKeys(text: string): Promise<void>;       // tmux send-keys
  async sendSpecialKey(key: 'Enter' | 'Escape' | 'Up' | 'Down'): Promise<void>;
  async pipeOutput(logPath: string): Promise<void>;   // tmux pipe-pane → file
  async capturePane(): Promise<string>;               // tmux capture-pane -p (snapshot)

  // Session resume
  async getSessionId(): Promise<string | null>;       // parse from output
}
```

**Claude 啟動指令（在 tmux window 內執行）：**
```bash
claude --plugin-dir dist/plugin \
       --channels plugin:ccd-channel \
       --settings <instance-dir>/claude-settings.json \
       --resume <session-id>
```

### 優勢

- **Daemon crash resilience** — Claude 在 tmux 裡繼續跑，daemon 重啟後 reattach
- **移除 node-pty 原生模組** — 不再需要 C++ compiler 做 `npm install`
- **Terminal 可存取** — `tmux attach -t ccd:@0` 隨時看 Claude 的 terminal
- **截圖能力** — `capture-pane -p` 可用於 debug（未來 nice-to-have）
- **輸出串流** — `pipe-pane` 將輸出寫到檔案，daemon 用 byte-offset tail 讀取

### 依賴

- 系統需預裝 tmux（macOS: `brew install tmux`，Linux: `apt install tmux`）
- Node.js 透過 `child_process.execFile` 呼叫 tmux CLI，不需要額外 npm package

## Transcript Monitor (Byte-Offset Polling)

替代現有的 `readFileSync` 整檔讀取，改為只讀增量。

```typescript
class TranscriptMonitor {
  private fd: number | null = null;
  private byteOffset: number = 0;

  constructor(private instanceDir: string, private logger: Logger) {}

  // 找到 transcript JSONL 路徑（從 statusline 或 project dir）
  async resolveTranscriptPath(): Promise<string | null>;

  // 讀取新增內容（從 byteOffset 開始）
  async pollIncrement(): Promise<string>;

  // 解析 JSONL 行，emit events
  on(event: 'tool_use', handler: (name: string, input: unknown) => void): void;
  on(event: 'tool_result', handler: (name: string, output: unknown) => void): void;
  on(event: 'assistant_text', handler: (text: string) => void): void;
  on(event: 'channel_message', handler: (user: string, text: string) => void): void;
}
```

**行為：**
- 用 `fs.open` + `fs.read(fd, buffer, 0, length, byteOffset)` 只讀新增 bytes
- 不讀整個檔案，長時間 session 也不會 I/O 爆炸
- 每 2 秒 poll 一次（可配置）

## Built-in MCP Channel Server

Daemon 內建 MCP server，取代官方 telegram plugin。

### 連接機制：Local Plugin via --plugin-dir

Claude Code 的 `--channels` 只接受 `plugin:<name>@<registry>` 格式。解決方案：將 MCP channel server 打包為 local plugin，透過 `--plugin-dir` 載入。

**Plugin 目錄結構（daemon build output 的一部分）：**

```
dist/plugin/ccd-channel/
├── .claude-plugin/
│   └── plugin.json          # { "name": "ccd-channel", "version": "..." }
├── .mcp.json                # MCP server 定義
└── server.js                # MCP channel server entry point
```

`.mcp.json`:
```json
{
  "ccd-channel": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"],
    "env": {
      "CCD_SOCKET_PATH": "${CCD_SOCKET_PATH}"
    }
  }
}
```

**MCP server 與 daemon 的通訊：**

MCP server（`server.js`）作為 Claude Code 的 child process 運行，透過 stdin/stdout 走 MCP protocol。
它透過 Unix domain socket 與 daemon 的 MessageBus 通訊：

```
daemon process                    tmux → Claude Code process
  │                                   │
  ├── MessageBus                      ├── MCP channel server (server.js)
  │     ↕ (Unix socket)               │     ↕ (MCP stdio)
  │     IPC bridge ←──────────────────┤     Claude
  │                                   │
```

Daemon 啟動時建立 IPC server（Unix socket at `<instance-dir>/channel.sock`）。
MCP server.js 啟動時連接此 socket，雙向傳遞 inbound messages 和 outbound tool calls。

### MCP Tools (channel-agnostic)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `reply` | `chat_id`, `text`, `files?`, `reply_to?` | Send message |
| `react` | `chat_id`, `message_id`, `emoji` | Add reaction |
| `edit_message` | `chat_id`, `message_id`, `text` | Edit message |
| `download_attachment` | `file_id` | Download and return local path |

Tool interface 與官方 plugin 一致 — Claude 端無需學習新 API。底層改為透過 IPC → MessageBus → MessageQueue → ChannelAdapter。

**MCP tool 命名：** `mcp__plugin_ccd-channel_ccd-channel__reply` 等。Settings 中的 tool allow-list 需對應更新。

### Inbound Message Injection

Adapter 收到使用者訊息 → MessageBus（按 threadId 路由到對應 instance）→ IPC → MCP server 透過 channel protocol 推送給 Claude。格式沿用 `<channel source="..." chat_id="..." ...>` tag。

### Approval Integration

- PreToolUse hook POST 到 approval server endpoint
- Approval server 呼叫 `messageBus.requestApproval()` 而非直接呼叫 Telegram API
- Tmux prompt detector 也呼叫 `messageBus.requestApproval()`
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

**Pairing 流程（端到端）：**
1. 新用戶 DM bot 或在 Group 裡發訊息 → adapter 收到訊息，userId 不在 `allowed_users`
2. Adapter 呼叫 `accessManager.generateCode(userId)` → 產生 6 字元 hex code
3. Bot 回覆用戶：「Pairing code: `A3F7B2`，請在終端機執行 `ccd access <instance> pair A3F7B2`」
4. Max 2 次 pairing 回覆/sender，之後靜默丟棄（防濫用）
5. Code 有效期 60 分鐘，最多 3 個 pending codes
6. Operator 在終端執行 `ccd access <instance> pair A3F7B2`
7. AccessManager 驗證 code → 將 userId 加入 `allowed_users` → 持久化到 access state file
8. Bot 通知用戶：「Paired successfully」

Management:
```
ccd access <instance> lock          # 切到 locked mode
ccd access <instance> unlock        # 切回 pairing mode
ccd access <instance> list          # 列出 allowed_users
ccd access <instance> remove <uid>  # 移除用戶
ccd access <instance> pair <code>   # 確認 pairing
```

Security: channel 內訊息要求改 access 一律拒絕（防 prompt injection）。

## Fleet Management

### Fleet Config: `~/.claude-channel-daemon/fleet.yaml`

```yaml
# 共用 channel — Topic mode（推薦）
channel:
  type: telegram
  mode: topic
  bot_token_env: CCD_BOT_TOKEN
  group_id: -1001234567890
  access:
    mode: locked
    allowed_users: [123456789]

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
    topic_id: 42                         # Telegram Forum Topic ID
    context_guardian:
      threshold_percentage: 60

  project-b:
    working_directory: /path/to/project-b
    topic_id: 87

  # DM mode 也仍支援（per-instance channel override）
  project-c:
    working_directory: /path/to/project-c
    channel:
      type: telegram
      mode: dm
      bot_token_env: PROJECT_C_BOT_TOKEN
      access:
        mode: pairing
        allowed_users: []
```

**Config merge 規則：**
- `defaults` 中的 object fields 透過 deep merge 與 per-instance override 合併
- `channel` 在頂層定義共用，instance 可 override 自己的 `channel`
- `topic_id` 是 topic mode 下 instance 的路由標識

**Backward compatibility：** 單機模式 `ccd start` 仍讀取 `config.yaml`（舊格式）。

### Config Types

```typescript
interface FleetConfig {
  channel?: ChannelConfig;               // 共用 channel（topic mode）
  defaults: Partial<InstanceConfig>;
  instances: Record<string, InstanceConfig>;
}

interface InstanceConfig {
  working_directory: string;
  topic_id?: number;                     // topic mode: 對應的 topic ID
  channel?: ChannelConfig;               // per-instance channel override（DM mode）
  restart_policy: RestartPolicy;
  context_guardian: ContextGuardianConfig;
  memory: MemoryConfig;
  log_level: string;
  approval_port?: number;
  /** @deprecated backward compat with old config.yaml */
  channel_plugin?: string;
}

interface ChannelConfig {
  type: 'telegram';                      // | 'discord' | ... (future)
  mode: 'topic' | 'dm';                 // topic = Forum Group, dm = direct message
  bot_token_env: string;
  group_id?: number;                     // topic mode: Forum Group ID
  access: AccessConfig;
  options?: Record<string, unknown>;
}
```

### CLI Commands

```
# Fleet management
ccd fleet start                  # Start all instances
ccd fleet stop                   # Stop all instances
ccd fleet start <instance>       # Start single instance
ccd fleet stop <instance>        # Stop single instance
ccd fleet status                 # List all instance states
ccd fleet logs <instance>        # Tail specific instance log

# Topic management
ccd topic list                   # List topic bindings
ccd topic bind <instance> <id>   # Bind topic to instance
ccd topic unbind <instance>      # Unbind topic

# Access management
ccd access <instance> lock
ccd access <instance> unlock
ccd access <instance> list
ccd access <instance> remove <uid>
ccd access <instance> pair <code>

# Single-instance mode (backward compatible)
ccd start                        # Uses config.yaml, old behavior
```

### Process Management

- 每個 instance 對應一個 tmux window
- Fleet 使用一個 tmux session（名稱 `ccd`）
- **Instance-scoped data directory**: `~/.claude-channel-daemon/instances/<name>/`
  - `daemon.pid` — process ID
  - `daemon.log` — structured JSON logs
  - `session-id` — Claude session UUID for --resume
  - `statusline.json` — Claude status JSON
  - `claude-settings.json` — per-instance settings (unique approval port, tool allow-list)
  - `channel.sock` — Unix domain socket for MCP ↔ daemon IPC
  - `output.log` — tmux pipe-pane 輸出（transcript monitor 的讀取來源）
  - `access/` — per-adapter access state files

### Approval Server Port Allocation

每個 instance 需要獨立的 approval server port。

**策略：**
- 自動分配：base port 18321 + instance index
- Fleet config 可選指定 `approval_port` 手動 override
- 單機模式沿用 18321

### Fleet Status Output

```
ccd fleet status

Instance     Status      Uptime    Context   Topic
─────────────────────────────────────────────────────
project-a    running     2h 15m    42%       #project-a
project-b    running     0h 30m    12%       #project-b
project-c    crashed     -         -         (DM mode)
```

Status 判斷：
- `running` — tmux window alive + daemon PID alive
- `stopped` — tmux window not found
- `crashed` — tmux window alive but daemon PID dead（Claude 還在跑，daemon 需重啟）

### Service Installation

`ccd fleet install` 產生一個 launchd plist / systemd service，執行 `ccd fleet start`。

## Module Structure

```
src/
├── cli.ts                     # CLI entry (ccd start/stop/fleet/access/topic)
├── fleet-manager.ts           # fleet start/stop/status, tmux session management
├── daemon.ts                  # Single instance main logic
├── daemon-entry.ts            # Entry point for fleet-forked child processes
├── tmux-manager.ts            # Tmux operations (replaces process-manager.ts)
├── transcript-monitor.ts      # Byte-offset JSONL polling + tool tracking
├── context-guardian.ts        # Context rotation (existing, path-parameterized)
├── memory-layer.ts            # Memory backup (existing, unchanged)
├── db.ts                      # SQLite (existing, unchanged)
├── config.ts                  # Read fleet.yaml + deep merge defaults
├── logger.ts                  # Pino logging (existing, unchanged)
│
├── channel/
│   ├── types.ts               # ChannelAdapter, InboundMessage, Attachment, etc.
│   ├── message-bus.ts         # MessageBus — merge inbound / route outbound / approval race
│   ├── message-queue.ts       # Per-chat message queue + rate limiting + merge
│   ├── tool-tracker.ts        # Tool use/result tracking + in-place edit
│   ├── mcp-server.ts          # Built-in MCP server entry (runs as Claude child process)
│   ├── ipc-bridge.ts          # Unix socket IPC between daemon ↔ MCP server
│   ├── access-manager.ts      # Pairing / locked state machine, allowlist
│   └── adapters/
│       └── telegram.ts        # TelegramAdapter implements ChannelAdapter
│
├── approval/
│   ├── approval-server.ts     # HTTP server (PreToolUse hook endpoint)
│   └── tmux-prompt-detector.ts # Tmux prompt detection (replaces pty-detector)
│
├── types.ts                   # Global types (FleetConfig, InstanceConfig, ChannelConfig)
│
└── plugin/                    # Local plugin structure (built output)
    └── ccd-channel/
        ├── .claude-plugin/
        │   └── plugin.json
        ├── .mcp.json
        └── server.js          # → compiled from channel/mcp-server.ts
```

### Dependency Changes

- **Add**: `@modelcontextprotocol/sdk` (build MCP server), `grammy` (Telegram Bot API)
- **Remove**: `node-pty` (replaced by tmux), dependency on `telegram@claude-plugins-official` plugin
- **System requirement**: `tmux` must be installed

### Existing Code Impact

| Current File | Change |
|-------------|--------|
| `cli.ts` | Split → `cli.ts` (pure CLI) + `daemon.ts` + `fleet-manager.ts`; add topic/access commands |
| `process-manager.ts` | **Replace** with `tmux-manager.ts` — tmux-based process management |
| `context-guardian.ts` | Minor: accept instance-scoped `statusline.json` path |
| `memory-layer.ts` | Unchanged |
| `db.ts` | Unchanged |
| `config.ts` | Major: support `fleet.yaml` + `InstanceConfig` + topic bindings |
| `types.ts` | Major: add `FleetConfig`, `InstanceConfig`, `ChannelConfig` with topic support |
| `setup-wizard.ts` | Adapt for fleet init + topic mode setup |
| `package.json` | Remove `node-pty`, add `grammy` + `@modelcontextprotocol/sdk` |

## Scope

### In Scope (this iteration)
- Channel abstraction layer (interface + MessageBus + IPC bridge)
- Topic mode with threadId routing
- Telegram adapter with message queue + rate limiting
- Tool tracking + in-place edit
- Local plugin structure + MCP channel server
- Tmux-based process management (replaces node-pty)
- Transcript monitor with byte-offset polling
- Unified approval system with approval race
- Fleet management (fleet.yaml + CLI)
- Instance-scoped data directories
- Access control with pairing + locked modes
- Multimedia support (photo, voice, document)
- Backward compatible single-instance mode

### Out of Scope (future)
- Discord adapter
- Terminal screenshot rendering (PNG)
- Cross-channel message forwarding
- Adapter hot-plug (runtime add/remove without restart)
- Slack / other platform adapters
