# Multi-Channel Architecture Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the official Telegram plugin with a self-built channel abstraction layer using tmux for process management, topic-based routing for multi-project support, and fleet management for orchestrating multiple daemon instances.

**Architecture:** Fleet manager owns a shared Telegram adapter (single bot poller) and routes messages by Forum Topic threadId to daemon instances via Unix socket IPC. Each daemon runs Claude in a tmux window, connects to an MCP channel server (local plugin), and monitors the JSONL transcript with byte-offset polling. Tool calls are tracked and displayed as in-place-edited status messages to reduce notification spam.

**Tech Stack:** TypeScript, Node.js 20+, tmux, `@modelcontextprotocol/sdk`, `grammy`, `better-sqlite3`, `vitest`

**Spec:** `docs/superpowers/specs/2026-03-21-multi-channel-architecture-design.md`

**Import path convention:** Tests in `tests/<dir>/` import from `../../src/<dir>/...`. Tests in `tests/<dir>/<subdir>/` import from `../../../src/<dir>/<subdir>/...`.

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/channel/types.ts` | ChannelAdapter interface, InboundMessage, Attachment, SendOpts, SentMessage, OutboundMessage, ApprovalHandle, Target, ApprovalResponse, QueuedMessage |
| `src/channel/access-manager.ts` | Pairing/locked state machine, code generation/validation, mode persistence, allowlist persistence |
| `src/channel/message-queue.ts` | Per-chat FIFO queue, message merging, rate limit backoff, flood control |
| `src/channel/adapters/telegram.ts` | TelegramAdapter: Grammy bot, polling, message handling, approval buttons, file download, internal MessageQueue |
| `src/channel/message-bus.ts` | MessageBus: adapter registry, inbound merge, outbound routing, approval race with AbortController |
| `src/channel/ipc-bridge.ts` | Unix socket server (daemon side) + client (MCP server side), newline-delimited JSON, reconnection with backoff |
| `src/channel/tool-tracker.ts` | Track tool_use → tool_result pairs, in-place edit status messages via adapter |
| `src/channel/mcp-server.ts` | MCP channel server entry point (runs as Claude child process): reply/react/edit/download tools via IPC |
| `src/tmux-manager.ts` | Tmux session/window lifecycle, send-keys, pipe-pane, capture-pane |
| `src/transcript-monitor.ts` | Byte-offset JSONL polling, emit tool_use/tool_result/assistant_text events |
| `src/approval/approval-server.ts` | HTTP server for PreToolUse hook, danger detection, calls messageBus.requestApproval() |
| `src/approval/tmux-prompt-detector.ts` | Tail pipe-pane output.log, detect "1.Yes"+"3.No" pattern, trigger approval |
| `src/daemon.ts` | Single-instance orchestrator: wires all components, lifecycle management |
| `src/daemon-entry.ts` | Thin CLI entry for fleet-forked child processes |
| `src/fleet-manager.ts` | Fleet start/stop/status, shared adapter ownership, topic routing, tmux session management, port allocation |
| `src/plugin/ccd-channel/.claude-plugin/plugin.json` | Local plugin manifest |
| `src/plugin/ccd-channel/.mcp.json` | MCP server definition |

### Modified Files

| File | Change |
|------|--------|
| `src/types.ts` | Add FleetConfig, InstanceConfig, ChannelConfig, AccessConfig; keep DaemonConfig for backward compat |
| `src/config.ts` | Add `loadFleetConfig()`, generic deep merge, fleet.yaml validation |
| `src/context-guardian.ts` | Already parameterized — no changes needed |
| `src/cli.ts` | Add `fleet`, `access`, `topic` command groups; refactor `start` to delegate to daemon.ts |
| `package.json` | Remove `node-pty`, add `grammy` + `@modelcontextprotocol/sdk` |

### Unchanged Files

`src/memory-layer.ts`, `src/db.ts`, `src/logger.ts`

---

## Phase 1: Foundation (Tasks 1-4)

### Task 1: Global Types + Config

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing test for FleetConfig loading**

Add to `tests/config.test.ts`:

```typescript
import { loadFleetConfig } from "../src/config.js";

describe("loadFleetConfig", () => {
  it("loads fleet.yaml with defaults merged into instances", () => {
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
defaults:
  restart_policy:
    max_retries: 5
    backoff: exponential
    reset_after: 300
  log_level: info
channel:
  type: telegram
  mode: topic
  bot_token_env: BOT_TOKEN
  group_id: -100123
  access:
    mode: locked
    allowed_users: [111]
instances:
  project-a:
    working_directory: /tmp/a
    topic_id: 42
    context_guardian:
      threshold_percentage: 60
      max_age_hours: 2
      strategy: hybrid
`);
    const fleet = loadFleetConfig(configPath);
    expect(fleet.instances["project-a"].restart_policy.max_retries).toBe(5);
    expect(fleet.instances["project-a"].context_guardian.threshold_percentage).toBe(60);
    expect(fleet.instances["project-a"].topic_id).toBe(42);
    expect(fleet.channel?.mode).toBe("topic");
  });

  it("validates required fields", () => {
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
instances:
  bad:
    topic_id: 1
`);
    expect(() => loadFleetConfig(configPath)).toThrow(/working_directory/);
  });

  it("returns empty instances when no fleet.yaml exists", () => {
    const fleet = loadFleetConfig(join(tmpDir, "nonexistent.yaml"));
    expect(fleet.instances).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `loadFleetConfig` not found

- [ ] **Step 3: Add new types to src/types.ts**

Add after existing types:

```typescript
export interface AccessConfig {
  mode: "pairing" | "locked";
  allowed_users: number[];
  max_pending_codes: number;
  code_expiry_minutes: number;
}

export interface ChannelConfig {
  type: "telegram";
  mode: "topic" | "dm";
  bot_token_env: string;
  group_id?: number;
  access: AccessConfig;
  options?: Record<string, unknown>;
}

export interface InstanceConfig {
  working_directory: string;
  topic_id?: number;
  channel?: ChannelConfig;
  restart_policy: DaemonConfig["restart_policy"];
  context_guardian: DaemonConfig["context_guardian"];
  memory: DaemonConfig["memory"];
  memory_directory?: string;
  log_level: DaemonConfig["log_level"];
  approval_port?: number;
  /** @deprecated backward compat */
  channel_plugin?: string;
}

export interface FleetConfig {
  channel?: ChannelConfig;
  defaults: Partial<InstanceConfig>;
  instances: Record<string, InstanceConfig>;
}
```

- [ ] **Step 4: Implement loadFleetConfig in src/config.ts**

Add generic deep merge (arrays replaced, objects merged) and `loadFleetConfig` that merges defaults into each instance, validates `working_directory` exists.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/config.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat: add FleetConfig types and loadFleetConfig"
```

---

### Task 2: Channel Abstraction Types

**Files:**
- Create: `src/channel/types.ts`

- [ ] **Step 1: Create channel types file**

Write all interfaces from the spec: `ChannelAdapter` (extends EventEmitter), `ApprovalHandle`, `SendOpts`, `SentMessage`, `OutboundMessage`, `InboundMessage`, `Attachment`, `ApprovalResponse`, `Target`, `QueuedMessage`. Note `sendApproval` returns `Promise<ApprovalHandle>`.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/channel/types.ts
git commit -m "feat: add channel abstraction type definitions"
```

---

### Task 3: IPC Bridge

**Files:**
- Create: `src/channel/ipc-bridge.ts`
- Create: `tests/channel/ipc-bridge.test.ts`

- [ ] **Step 1: Write failing tests**

Test bidirectional messaging over Unix socket, stale socket cleanup, and client reconnection:

```typescript
// tests/channel/ipc-bridge.test.ts
import { IpcServer, IpcClient } from "../../src/channel/ipc-bridge.js";

describe("IPC Bridge", () => {
  it("sends messages bidirectionally", async () => { ... });
  it("cleans up stale socket on start", async () => { ... });
  it("client reconnects after server restart", async () => { ... });
});
```

- [ ] **Step 2: Run tests — verify fail**

Run: `npx vitest run tests/channel/ipc-bridge.test.ts`

- [ ] **Step 3: Implement IpcServer + IpcClient**

Newline-delimited JSON over Unix domain socket. `IpcServer`: listen, broadcast, send to specific client, close with socket cleanup. `IpcClient`: connect with retry/backoff (1s → 2s → 4s, max 30s), send, emit "message" events, heartbeat ping/pong every 10s.

- [ ] **Step 4: Run tests — verify pass**

Run: `npx vitest run tests/channel/ipc-bridge.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/channel/ipc-bridge.ts tests/channel/ipc-bridge.test.ts
git commit -m "feat: add Unix socket IPC bridge with reconnection"
```

---

### Task 4: TmuxManager

**Files:**
- Create: `src/tmux-manager.ts`
- Create: `tests/tmux-manager.test.ts`
- Modify: `package.json` (remove `node-pty`)

- [ ] **Step 1: Write failing tests**

```typescript
// tests/tmux-manager.test.ts
import { TmuxManager } from "../src/tmux-manager.js";

describe("TmuxManager", () => {
  const session = `ccd-test-${Date.now()}`;

  afterAll(async () => {
    await TmuxManager.killSession(session).catch(() => {});
  });

  it("creates and detects session", async () => {
    await TmuxManager.ensureSession(session);
    expect(await TmuxManager.sessionExists(session)).toBe(true);
  });

  it("creates window and checks alive", async () => {
    const tm = new TmuxManager(session, "");
    const windowId = await tm.createWindow("sleep 60", "/tmp");
    expect(windowId).toMatch(/@\d+/);
    expect(await tm.isWindowAlive()).toBe(true);
  });

  it("sends keys and captures pane", async () => {
    const tm = new TmuxManager(session, "");
    await tm.createWindow("cat", "/tmp"); // cat echoes input
    await tm.sendKeys("hello world");
    await tm.sendSpecialKey("Enter");
    await new Promise(r => setTimeout(r, 500));
    const output = await tm.capturePane();
    expect(output).toContain("hello world");
  });

  it("kills window", async () => {
    const tm = new TmuxManager(session, "");
    await tm.createWindow("sleep 60", "/tmp");
    await tm.killWindow();
    expect(await tm.isWindowAlive()).toBe(false);
  });
});
```

Note: These tests require `tmux` installed. Skip in CI if unavailable.

- [ ] **Step 2: Run tests — verify fail**

Run: `npx vitest run tests/tmux-manager.test.ts`

- [ ] **Step 3: Implement TmuxManager**

All methods use `child_process.execFile("tmux", [...args])`. Static session methods + per-instance window methods. Key tmux commands:
- `tmux new-session -d -s <name>` — create session
- `tmux has-session -t <name>` — check session exists
- `tmux new-window -t <session> -n <name> -c <cwd> <command>` — create window
- `tmux send-keys -t <session>:<window> <text> Enter` — send input
- `tmux capture-pane -t <session>:<window> -p` — snapshot output
- `tmux pipe-pane -t <session>:<window> 'cat >> <logPath>'` — stream output

- [ ] **Step 4: Remove node-pty and old process-manager**

Run: `npm uninstall node-pty`
Run: `git rm src/process-manager.ts tests/process-manager.test.ts`

Remove the `import { ProcessManager } from "./process-manager.js"` and `import { STATUSLINE_FILE } from "./process-manager.js"` from `src/cli.ts` (will be fully refactored in Task 15, but remove imports now to avoid compile errors).

- [ ] **Step 5: Run tests — verify pass**

Run: `npx vitest run tests/tmux-manager.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/tmux-manager.ts tests/tmux-manager.test.ts package.json package-lock.json
git commit -m "feat: add TmuxManager, remove node-pty"
```

---

## Phase 2: Channel Layer (Tasks 5-8)

### Task 5: Access Manager

**Files:**
- Create: `src/channel/access-manager.ts`
- Create: `tests/channel/access-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Test: isAllowed, generateCode, confirmCode, setMode persistence, per-user quota, max pending codes, state persistence across instances.

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement AccessManager**

State machine with `mode` in persisted state (not just config). `generateCode` produces 6-char hex, `confirmCode` validates and adds to allowlist. `saveState` writes JSON including `mode`, `allowed_users`, `pending_codes`.

- [ ] **Step 4: Run tests — verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/channel/access-manager.ts tests/channel/access-manager.test.ts
git commit -m "feat: add AccessManager with pairing/locked state machine"
```

---

### Task 6: Message Queue

**Files:**
- Create: `src/channel/message-queue.ts`
- Create: `tests/channel/message-queue.test.ts`

- [ ] **Step 1: Write failing tests**

Test: enqueue + dequeue ordering, adjacent content message merging (respecting 4096 char limit), status_update editing (not creating new messages), flood control (drop status_update when backoff > 10s).

```typescript
// tests/channel/message-queue.test.ts
import { MessageQueue } from "../../src/channel/message-queue.js";

describe("MessageQueue", () => {
  it("merges adjacent content messages", async () => {
    const sent: string[] = [];
    const queue = new MessageQueue({
      send: async (text) => { sent.push(text); return { messageId: "1", chatId: "c" }; },
      edit: async () => {},
    });
    queue.enqueue("c1", undefined, { type: "content", text: "hello " });
    queue.enqueue("c1", undefined, { type: "content", text: "world" });
    queue.start();
    await new Promise(r => setTimeout(r, 100));
    queue.stop();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe("hello world");
  });

  it("edits status messages in-place", async () => { ... });
  it("drops status_update during flood", async () => { ... });
});
```

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement MessageQueue**

Per-chat/thread FIFO with worker loop. `enqueue()` adds to queue. Worker pops items, merges adjacent content, sends via provided `send` callback. On 429 error: exponential backoff. During flood (backoff > 10s): drop `status_update` items.

- [ ] **Step 4: Run tests — verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/channel/message-queue.ts tests/channel/message-queue.test.ts
git commit -m "feat: add MessageQueue with merging, rate limiting, flood control"
```

---

### Task 7: Telegram Adapter

**Files:**
- Create: `src/channel/adapters/telegram.ts`
- Create: `tests/channel/adapters/telegram.test.ts`
- Modify: `package.json` (add `grammy`)

- [ ] **Step 1: Install grammy**

Run: `npm install grammy`

- [ ] **Step 2: Write failing tests**

Mock Grammy's Bot class. Test: adapter type/id, message emission with threadId, sendText with chunking, sendApproval with inline keyboard + callback, downloadAttachment, access control delegation.

- [ ] **Step 3: Run tests — verify fail**

- [ ] **Step 4: Implement TelegramAdapter**

Implements `ChannelAdapter`. Uses Grammy for bot polling. Message handler extracts `message_thread_id` as `threadId`. Internal `MessageQueue` for all outbound. `sendApproval` creates inline keyboard with approve/deny buttons, registers callback query handler. Photo/voice auto-download to inbox directory.

Key: adapter's `sendText`/`editMessage`/etc. go through internal `MessageQueue`. The queue's `send` callback calls Grammy's `bot.api.sendMessage`/`bot.api.editMessageText`.

Important: `sendApproval` must implement `signal?: AbortSignal` from the spec. When `signal.aborted`, clean up the inline keyboard callback query handler (ignore late clicks).

~250-350 lines. Reference the official plugin's `server.ts` for Telegram API patterns.

- [ ] **Step 5: Run tests — verify pass**

- [ ] **Step 6: Commit**

```bash
git add src/channel/adapters/telegram.ts tests/channel/adapters/telegram.test.ts package.json package-lock.json
git commit -m "feat: add TelegramAdapter with MessageQueue and approval buttons"
```

---

### Task 8: MessageBus

**Files:**
- Create: `src/channel/message-bus.ts`
- Create: `tests/channel/message-bus.test.ts`

- [ ] **Step 1: Write failing tests**

Test with mock adapters: inbound message merge, outbound routing (specific adapter vs broadcast), approval race (first response wins, others cancelled), approval timeout auto-deny.

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement MessageBus**

Register/unregister adapters. Inbound: listen to all adapters' 'message' events, re-emit. Outbound: route by `target.adapterId` or broadcast. Approval race: AbortController + Promise.race pattern, 2-min timeout.

- [ ] **Step 4: Run tests — verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/channel/message-bus.ts tests/channel/message-bus.test.ts
git commit -m "feat: add MessageBus with routing and approval race"
```

---

## Phase 3: Monitoring + Approval (Tasks 9-11)

### Task 9: Transcript Monitor

**Files:**
- Create: `src/transcript-monitor.ts`
- Create: `tests/transcript-monitor.test.ts`

- [ ] **Step 1: Write failing tests**

Create a temp JSONL file, write entries, verify byte-offset polling emits correct events (tool_use, tool_result, assistant_text). Verify it only reads new content on subsequent polls.

```typescript
// tests/transcript-monitor.test.ts
import { TranscriptMonitor } from "../src/transcript-monitor.js";

describe("TranscriptMonitor", () => {
  it("emits tool_use events from JSONL", async () => {
    // Write a JSONL entry with tool_use content block
    // Start monitor, poll, verify event emitted
  });

  it("reads only incremental content on second poll", async () => {
    // Write content, poll (sets offset), write more, poll again
    // Verify second poll only sees new content
  });

  it("emits assistant_text for text blocks", async () => { ... });
});
```

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement TranscriptMonitor**

Extends EventEmitter. `resolveTranscriptPath()` reads `statusline.json` for `transcript_path` or scans project dir for newest `.jsonl`. `pollIncrement()` uses `fs.open` + `fs.read(fd, buffer, 0, size, byteOffset)` to read only new bytes. Parse each JSONL line, extract message content blocks, emit typed events.

- [ ] **Step 4: Run tests — verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/transcript-monitor.ts tests/transcript-monitor.test.ts
git commit -m "feat: add TranscriptMonitor with byte-offset JSONL polling"
```

---

### Task 10: Tool Tracker

**Files:**
- Create: `src/channel/tool-tracker.ts`
- Create: `tests/channel/tool-tracker.test.ts`

- [ ] **Step 1: Write failing tests**

Test: first tool_use sends new status message, subsequent tool_use edits same message, tool_result updates status with checkmark, assistant_text resets tracker (new status message for next batch).

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement ToolTracker**

Takes adapter reference + chatId + threadId. Maintains `statusMessageId`. `onToolUse`: if no statusMessageId → `adapter.sendText()` to create status message, save ID; else → `adapter.editMessage()` to append line. `onToolResult`: edit message to update line with ✅/❌. Expose `reset()` for when assistant_text arrives (start fresh for next tool batch).

- [ ] **Step 4: Run tests — verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/channel/tool-tracker.ts tests/channel/tool-tracker.test.ts
git commit -m "feat: add ToolTracker with in-place status message editing"
```

---

### Task 11: Approval System

**Files:**
- Create: `src/approval/approval-server.ts`
- Create: `src/approval/tmux-prompt-detector.ts`
- Create: `tests/approval/approval-server.test.ts`
- Create: `tests/approval/tmux-prompt-detector.test.ts`

- [ ] **Step 1: Write failing tests for ApprovalServer**

Test: auto-approve safe tools (Read, Edit, Glob, etc.), hard-deny destructive patterns, forward dangerous tools to messageBus.requestApproval().

- [ ] **Step 2: Write failing tests for TmuxPromptDetector**

Test: detect "1.Yes" + "3.No" pattern in raw output, ignore normal output, trigger approval callback.

- [ ] **Step 3: Run all tests — verify fail**

- [ ] **Step 4: Implement ApprovalServer**

HTTP server on configurable port. Parses PreToolUse hook JSON. Safe tool list: Read, Edit, Write, Glob, Grep, Bash(*), WebFetch, WebSearch, Agent, Skill + MCP channel tools (`mcp__plugin_ccd-channel_ccd-channel__*`). Danger patterns: rm -rf, git push --force, etc. Returns `hookSpecificOutput` JSON with `permissionDecision`.

- [ ] **Step 5: Implement TmuxPromptDetector**

Tails `output.log` (pipe-pane output) with byte-offset. Detects permission prompt pattern. Calls `approvalFn(promptText)`, then `tmux.sendKeys("1")` or `tmux.sendKeys("3")` based on decision.

- [ ] **Step 6: Run tests — verify pass**

- [ ] **Step 7: Commit**

```bash
git add src/approval/ tests/approval/
git commit -m "feat: add ApprovalServer and TmuxPromptDetector"
```

---

## Phase 4: MCP Server + Plugin (Task 12)

### Task 12: MCP Channel Server + Local Plugin

**Files:**
- Create: `src/channel/mcp-server.ts`
- Create: `src/plugin/ccd-channel/.claude-plugin/plugin.json`
- Create: `src/plugin/ccd-channel/.mcp.json`
- Modify: `package.json` (add `@modelcontextprotocol/sdk`)

- [ ] **Step 1: Install MCP SDK**

Run: `npm install @modelcontextprotocol/sdk`

- [ ] **Step 2: Research MCP channel push mechanism**

Read the official telegram plugin source at `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/server.ts` to determine the exact channel message push API. Document: which SDK class, what notification method, what message format Claude expects. If the high-level `McpServer` doesn't support channel push, use the low-level `Server` class.

- [ ] **Step 3: Create local plugin structure**

```json
// src/plugin/ccd-channel/.claude-plugin/plugin.json
{ "name": "ccd-channel", "version": "0.1.0", "description": "Built-in channel server for claude-channel-daemon" }
```

```json
// src/plugin/ccd-channel/.mcp.json
{
  "ccd-channel": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"],
    "env": { "CCD_SOCKET_PATH": "${CCD_SOCKET_PATH}" }
  }
}
```

- [ ] **Step 4: Implement MCP server entry**

`src/channel/mcp-server.ts` — runs as separate process (Claude's child). Connects to daemon via IPC client (with reconnection). Exposes 4 MCP tools: reply, react, edit_message, download_attachment. Each tool forwards to daemon via IPC request-response (with 30s timeout). Handles inbound channel messages from daemon IPC → pushes to Claude via channel protocol (using mechanism found in Step 2).

- [ ] **Step 5: Add build configuration**

Ensure `tsc` compiles `mcp-server.ts` to `dist/channel/mcp-server.js`. Add a `"postbuild"` script in `package.json`:

```json
"postbuild": "cp -r src/plugin dist/ && ln -sf ../channel/mcp-server.js dist/plugin/ccd-channel/server.js"
```

This copies `plugin.json` and `.mcp.json` to `dist/plugin/` and symlinks `server.js` to the compiled MCP server.

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: `dist/plugin/ccd-channel/server.js` exists and is executable

- [ ] **Step 7: Commit**

```bash
git add src/channel/mcp-server.ts src/plugin/ package.json package-lock.json
git commit -m "feat: add MCP channel server + local plugin structure"
```

---

## Phase 5: Orchestration (Tasks 13-15)

### Task 13: Daemon Orchestrator

**Files:**
- Create: `src/daemon.ts`
- Create: `src/daemon-entry.ts`
- Create: `tests/daemon.test.ts`

- [ ] **Step 1: Write failing test**

Test Daemon construction with valid InstanceConfig, verify it creates data directories.

- [ ] **Step 2: Run test — verify fail**

- [ ] **Step 3: Implement Daemon**

Single-instance orchestrator. `constructor(name, config, instanceDir)`. `start()`:
1. Create instance data directory
2. Write PID file
3. Start IPC server (channel.sock)
4. Create/attach tmux window via TmuxManager
5. Start pipe-pane for prompt detection
6. Generate claude-settings.json (approval port, tool allow-list with `mcp__plugin_ccd-channel_ccd-channel__*` — NOT the old `mcp__plugin_telegram_telegram__*` names)
7. Launch Claude in tmux window (if not already running)
8. Start TranscriptMonitor → wire to ToolTracker
9. Start TmuxPromptDetector
10. Start ApprovalServer
11. Start ContextGuardian → handle rotation
12. Start MemoryLayer

`stop()`: reverse order, graceful shutdown.

Wire the data flow per spec's "Data Flow — Wiring" section.

- [ ] **Step 4: Implement daemon-entry.ts**

Thin CLI: parse `--instance`, `--instance-dir`, `--port`, `--config` args, instantiate Daemon, call `start()`.

- [ ] **Step 5: Run tests — verify pass**

- [ ] **Step 6: Commit**

```bash
git add src/daemon.ts src/daemon-entry.ts tests/daemon.test.ts
git commit -m "feat: add Daemon orchestrator and daemon-entry"
```

---

### Task 14: Fleet Manager

**Files:**
- Create: `src/fleet-manager.ts`
- Create: `tests/fleet-manager.test.ts`

- [ ] **Step 1: Write failing tests**

Test: port allocation (auto + manual override), instance status detection (running/stopped/crashed), topic routing table construction from instance configs.

- [ ] **Step 2: Run tests — verify fail**

- [ ] **Step 3: Implement FleetManager**

**Topic mode responsibilities:**
1. Load fleet.yaml via `loadFleetConfig()`
2. Build topic routing table: `{ topicId → instanceName }`
3. Ensure tmux session "ccd" exists
4. Start shared TelegramAdapter (single bot poller) — **only the fleet manager creates the adapter**
5. On inbound message: route by `msg.threadId` → find instance → forward to instance's IPC socket
6. For each instance: fork child process (daemon-entry.ts), allocate approval port
7. Daemon instances in topic mode receive NO adapter — they get messages only via IPC from the fleet manager's shared adapter. Pass `topicMode: true` to daemon so it skips adapter creation.

**Instance lifecycle:** `startInstance(name)`, `stopInstance(name)`, `getInstanceStatus(name)`.

**Port allocation:** base 18321 + instance index, with manual `approval_port` override.

- [ ] **Step 4: Run tests — verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/fleet-manager.ts tests/fleet-manager.test.ts
git commit -m "feat: add FleetManager with topic routing and shared adapter"
```

---

### Task 15: CLI Refactor

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add fleet commands**

`ccd fleet start [instance]`, `ccd fleet stop [instance]`, `ccd fleet status`, `ccd fleet logs <instance>`, `ccd fleet install/uninstall`.

- [ ] **Step 2: Add topic commands**

`ccd topic list`, `ccd topic bind <instance> <id>`, `ccd topic unbind <instance>`.

- [ ] **Step 3: Add access commands**

`ccd access <instance> lock/unlock/list/remove/pair`.

- [ ] **Step 4: Refactor single-instance start**

`ccd start` loads old `config.yaml`, maps `DaemonConfig` → `InstanceConfig`, creates single Daemon with tmux. If `channel_plugin` present → legacy mode (external plugin).

- [ ] **Step 5: Manual smoke test**

Run: `npx tsx src/cli.ts fleet status`
Expected: Shows empty table or "no fleet.yaml found"

Run: `npx tsx src/cli.ts --help`
Expected: Shows fleet, topic, access commands

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add fleet/topic/access CLI commands"
```

---

## Phase 6: Integration (Task 16)

### Task 16: Integration Testing + Build Verification

**Files:**
- Modify existing tests as needed

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Fix any broken imports, type errors, or test failures from refactoring.

- [ ] **Step 2: Build verification**

Run: `npm run build`
Verify: clean build, `dist/plugin/ccd-channel/` exists with server.js + plugin.json + .mcp.json.

- [ ] **Step 3: Backward compat test**

Verify that a legacy `config.yaml` (with `channel_plugin: telegram@...`) can be loaded, mapped to `InstanceConfig`, and a Daemon constructed from it.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration test fixes and build verification"
```

---

## Implementation Order + Dependencies

```
Task 1:  Types + Config              ─┐
Task 2:  Channel Types                │ Foundation
Task 3:  IPC Bridge                   │ (can parallel 3+4)
Task 4:  TmuxManager                 ─┘
Task 5:  Access Manager              ─┐
Task 6:  Message Queue                │ Channel Layer
Task 7:  Telegram Adapter (→ 5, 6)    │ (5+6 can parallel)
Task 8:  MessageBus (→ 2)            ─┘
Task 9:  Transcript Monitor          ─┐
Task 10: Tool Tracker (→ 9)           │ Monitoring
Task 11: Approval System (→ 8)       ─┘ (9+11 can parallel)
Task 12: MCP Server + Plugin (→ 3)    ─ MCP
Task 13: Daemon (→ all above)         ─┐
Task 14: Fleet Manager (→ 7, 13)       │ Orchestration
Task 15: CLI (→ 13, 14)              ─┘
Task 16: Integration (→ all)           ─ Final
```

Parallelizable groups: {3,4}, {5,6}, {9,11}
