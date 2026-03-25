# Permission Relay Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hook-based approval and tmux prompt detector with Claude Code's native permission relay protocol, using inline Telegram buttons for user interaction.

**Architecture:** MCP server declares `claude/channel/permission` capability and handles the full permission relay lifecycle. Permission requests flow through existing IPC bridge to the daemon, which routes to the Telegram adapter via MessageBus. The adapter displays inline keyboard buttons (Allow/Deny).

**Tech Stack:** TypeScript, MCP SDK (`@modelcontextprotocol/sdk`), Grammy (Telegram), Vitest

**Spec:** `docs/superpowers/specs/2026-03-25-permission-relay-design.md`

---

## File Structure

### Files to Create
- (none — all changes are modifications or deletions)

### Files to Modify
| File | Change |
|------|--------|
| `src/channel/types.ts` | Update `sendApproval` signature, `ApprovalResponse`, add `PermissionPrompt` |
| `src/channel/message-bus.ts` | Update `requestApproval` to accept `PermissionPrompt` |
| `src/channel/adapters/telegram.ts` | Update `sendApproval` for new signature + inline buttons |
| `src/channel/mcp-server.ts` | Add permission capability + notification handler |
| `src/daemon.ts` | Handle `permission_request` IPC, remove approval/prompt code |
| `src/backend/types.ts` | Remove `approvalStrategy` and `approvalPort` from `CliBackendConfig` |
| `src/backend/claude-code.ts` | Remove hooks, allowlist, `--dangerously-skip-permissions`, simplify settings |
| `src/backend/index.ts` | Remove approval-related exports |
| `src/types.ts` | Remove `approval_port` from `InstanceConfig` |
| `src/fleet-manager.ts` | Remove `HookBasedApproval`, port allocation, update fleet approval IPC |
| `src/daemon-entry.ts` | Remove `--port` arg and `approval_port` |
| `tests/fleet-manager.test.ts` | Update approval tests for `PermissionPrompt` |
| `tests/channel/message-bus.test.ts` | Update mock adapter and approval tests |
| `tests/channel/adapters/telegram.test.ts` | Update sendApproval tests |
| `tests/backend/claude-code.test.ts` | Update settings tests (no hooks) |

### Files to Delete
| File | Reason |
|------|--------|
| `src/approval/approval-server.ts` | Replaced by permission relay |
| `src/approval/tmux-prompt-detector.ts` | Replaced by permission relay |
| `src/backend/hook-based-approval.ts` | Replaced by permission relay |
| `src/backend/approval-strategy.ts` | Interface no longer needed |
| `tests/approval/approval-server.test.ts` | Tests for deleted code |
| `tests/approval/tmux-prompt-detector.test.ts` | Tests for deleted code |
| `tests/backend/hook-based-approval.test.ts` | Tests for deleted code |

---

### Task 1: Update Channel Types

**Files:**
- Modify: `src/channel/types.ts`

- [ ] **Step 1: Update types**

Replace the approval-related types in `src/channel/types.ts`:

```typescript
// Add new PermissionPrompt interface (after Attachment interface)
export interface PermissionPrompt {
  tool_name: string;
  description: string;
  input_preview?: string;
}

// Update sendApproval in ChannelAdapter interface:
sendApproval(
  prompt: PermissionPrompt,
  callback: (decision: "approve" | "deny") => void,
  signal?: AbortSignal,
  threadId?: string,
): Promise<ApprovalHandle>;

// Update ApprovalResponse:
export interface ApprovalResponse {
  decision: "approve" | "deny";
  respondedBy?: { channelType: string; userId: string };
  reason?: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles (expect errors in downstream files — that's expected)**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: Errors in telegram.ts, message-bus.ts, daemon.ts etc. (will fix in subsequent tasks)

- [ ] **Step 3: Commit**

```bash
git add src/channel/types.ts
git commit -m "refactor(types): update sendApproval to use PermissionPrompt, remove always_allow"
```

---

### Task 2: Update MessageBus

**Files:**
- Modify: `src/channel/message-bus.ts`
- Test: `tests/channel/message-bus.test.ts`

- [ ] **Step 1: Update test to use new signature**

In `tests/channel/message-bus.test.ts`, update the mock adapter's `sendApproval`:

```typescript
emitter.sendApproval = vi.fn(async (_prompt: PermissionPrompt, _cb: (d: "approve" | "deny") => void, _signal?: AbortSignal): Promise<ApprovalHandle> => {
  return { cancel: vi.fn() };
});
```

Add `import type { PermissionPrompt } from "../../src/channel/types.js";` to imports.

Update any existing `requestApproval` test calls to pass a `PermissionPrompt` object instead of a string:

```typescript
const prompt: PermissionPrompt = { tool_name: "Bash", description: "Run command" };
bus.requestApproval(prompt);
```

- [ ] **Step 2: Update MessageBus implementation**

In `src/channel/message-bus.ts`:
- Add `import type { PermissionPrompt } from "./types.js";` (add to existing import)
- Change `requestApproval(prompt: string)` to `requestApproval(prompt: PermissionPrompt)`

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/channel/message-bus.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/channel/message-bus.ts tests/channel/message-bus.test.ts
git commit -m "refactor(message-bus): update requestApproval to accept PermissionPrompt"
```

---

### Task 3: Update Telegram Adapter

**Files:**
- Modify: `src/channel/adapters/telegram.ts`
- Test: `tests/channel/adapters/telegram.test.ts`

- [ ] **Step 1: Update sendApproval tests**

In `tests/channel/adapters/telegram.test.ts`, update any tests that call `sendApproval` to pass `PermissionPrompt` instead of a string. The callback type changes from `"approve" | "always_allow" | "deny"` to `"approve" | "deny"`.

- [ ] **Step 2: Update sendApproval implementation**

In `src/channel/adapters/telegram.ts`, update the `sendApproval` method:

```typescript
async sendApproval(
  prompt: PermissionPrompt,
  callback: (decision: "approve" | "deny") => void,
  signal?: AbortSignal,
  threadId?: string,
): Promise<ApprovalHandle> {
  const nonce = Math.random().toString(36).slice(2, 10);
  const approveData = `approval:approve:${nonce}`;
  const denyData = `approval:deny:${nonce}`;

  const keyboard = new InlineKeyboard()
    .text("✅ Allow", approveData)
    .text("❌ Deny", denyData);

  // Format the permission message
  let text = `⚠️ *Permission Request*\nTool: \`${prompt.tool_name}\``;
  if (prompt.input_preview) {
    const preview = prompt.input_preview.length > 200
      ? prompt.input_preview.slice(0, 200) + "…"
      : prompt.input_preview;
    text += `\n\`\`\`\n${preview}\n\`\`\``;
  } else if (prompt.description) {
    text += `\n${prompt.description}`;
  }

  const cleanup = () => {
    this.off("callback_query", handler);
  };

  const handler = (query: { callbackData?: string; chatId?: string; messageId?: string }) => {
    if (!query.callbackData) return;
    const isApprove = query.callbackData === approveData;
    const isDeny = query.callbackData === denyData;
    if (!isApprove && !isDeny) return;

    cleanup();
    if (query.chatId && query.messageId) {
      const label = isApprove ? "✅ Allowed" : "❌ Denied";
      this.bot.api.editMessageText(
        Number(query.chatId), Number(query.messageId),
        `${label}\nTool: \`${prompt.tool_name}\``,
      ).catch(() => { /* UI update only */ });
    }
    callback(isApprove ? "approve" : "deny");
  };

  this.on("callback_query", handler);

  if (signal) {
    signal.addEventListener("abort", () => cleanup());
  }

  if (threadId) {
    const chatId = this.getLastChatId();
    if (chatId) {
      await this.bot.api.sendMessage(Number(chatId), text, {
        message_thread_id: Number(threadId),
        reply_markup: keyboard,
        parse_mode: "Markdown",
      }).catch(() => {
        return this.bot.api.sendMessage(Number(chatId), text, {
          message_thread_id: Number(threadId),
          reply_markup: keyboard,
        });
      });
    }
  } else {
    this.emit("approval_request", { prompt: text, keyboard, nonce });
  }

  return { cancel: cleanup };
}
```

Add `import type { PermissionPrompt } from "../types.js";` to existing import line.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/channel/adapters/telegram.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/channel/adapters/telegram.ts tests/channel/adapters/telegram.test.ts
git commit -m "refactor(telegram): update sendApproval with PermissionPrompt + simplified buttons"
```

---

### Task 4: Add Permission Relay to MCP Server

**Files:**
- Modify: `src/channel/mcp-server.ts`

- [ ] **Step 1: Add permission capability**

Update the MCP Server constructor capabilities:

```typescript
capabilities: {
  tools: {},
  experimental: {
    "claude/channel": {},
    "claude/channel/permission": {},
  },
},
```

- [ ] **Step 2: Add permission timeout constant**

After `IPC_TIMEOUT_MS`:

```typescript
const PERMISSION_TIMEOUT_MS = 120_000;
```

- [ ] **Step 3: Add permission request IPC function**

Add a new function that sends permission requests with the longer timeout:

```typescript
function ipcPermissionRequest(
  request_id: string,
  tool_name: string,
  description: string,
  input_preview?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ipcConnected || !ipc) {
      reject(new Error("Not connected to daemon IPC"));
      return;
    }

    const requestId = ++requestCounter;
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Permission request timed out after ${PERMISSION_TIMEOUT_MS}ms`));
    }, PERMISSION_TIMEOUT_MS);

    pendingRequests.set(requestId, { resolve, reject, timer });

    try {
      ipc.send({
        type: "permission_request",
        requestId,
        request_id,
        tool_name,
        description,
        input_preview,
      });
    } catch (err) {
      pendingRequests.delete(requestId);
      clearTimeout(timer);
      ipcConnected = false;
      reject(new Error(`IPC send failed: ${err}`));
    }
  });
}
```

- [ ] **Step 4: Add notification handler for permission requests**

After the tool call handler, add a notification handler. Note: verify the MCP SDK's `setNotificationHandler` API accepts a `{ method: string }` schema object. If it requires a Zod schema, create one with `z.object({ method: z.literal("notifications/claude/channel/permission_request") })`. The official Telegram plugin uses the inline `{ method }` form, so this should work:

```typescript
mcp.setNotificationHandler(
  { method: "notifications/claude/channel/permission_request" },
  async (notification) => {
    const params = notification.params as {
      request_id: string;
      tool_name: string;
      description: string;
      input_preview?: string;
    };

    try {
      const result = await ipcPermissionRequest(
        params.request_id,
        params.tool_name,
        params.description,
        params.input_preview,
      ) as { request_id: string; behavior: "allow" | "deny" };

      await mcp.notification({
        method: "notifications/claude/channel/permission",
        params: {
          request_id: result.request_id,
          behavior: result.behavior,
        },
      });
    } catch (err) {
      process.stderr.write(
        `ccd-channel: permission relay error: ${err}\n`,
      );
      // On error, deny permission (fail-safe)
      await mcp.notification({
        method: "notifications/claude/channel/permission",
        params: {
          request_id: params.request_id,
          behavior: "deny",
        },
      });
    }
  },
);
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit 2>&1 | grep mcp-server`
Expected: No errors in mcp-server.ts (may have errors elsewhere still)

- [ ] **Step 6: Commit**

```bash
git add src/channel/mcp-server.ts
git commit -m "feat(mcp): add permission relay capability and notification handler"
```

---

### Task 5: Update Daemon to Handle Permission Requests via IPC

**Files:**
- Modify: `src/daemon.ts`

- [ ] **Step 1: Remove old imports**

Remove these imports from `src/daemon.ts`:
- `import { TmuxPromptDetector } from "./approval/tmux-prompt-detector.js";`
- `import type { ApprovalStrategy } from "./backend/approval-strategy.js";`

Add to existing types import:
- `PermissionPrompt` to the import from `"./channel/types.js"`

- [ ] **Step 2: Remove approvalStrategyInstance from constructor**

Change constructor signature from:
```typescript
constructor(
  private name: string,
  private config: InstanceConfig,
  private instanceDir: string,
  private topicMode = false,
  private backend?: CliBackend,
  private approvalStrategyInstance?: ApprovalStrategy,
)
```
to:
```typescript
constructor(
  private name: string,
  private config: InstanceConfig,
  private instanceDir: string,
  private topicMode = false,
  private backend?: CliBackend,
)
```

Remove the `promptDetector` field declaration.

- [ ] **Step 3: Add permission_request IPC handler**

In the IPC message handler (around line 94, where `msg.type === "tool_call"` is handled), add a new case:

```typescript
} else if (msg.type === "permission_request") {
  this.handlePermissionRequest(msg, socket);
}
```

Add the handler method:

```typescript
private async handlePermissionRequest(msg: Record<string, unknown>, socket: import("node:net").Socket): void {
  const requestId = msg.requestId as number;
  const request_id = msg.request_id as string;
  const prompt: PermissionPrompt = {
    tool_name: msg.tool_name as string,
    description: msg.description as string,
    input_preview: msg.input_preview as string | undefined,
  };

  try {
    let result: ApprovalResponse;
    if (this.topicMode && this.ipcServer) {
      result = await this.requestApprovalViaIpc(prompt);
    } else {
      result = await this.messageBus.requestApproval(prompt);
    }

    const behavior = result.decision === "approve" ? "allow" : "deny";
    this.ipcServer?.send(socket, {
      requestId,
      result: { request_id, behavior },
    });
  } catch (err) {
    this.ipcServer?.send(socket, {
      requestId,
      result: { request_id, behavior: "deny" },
    });
  }
}
```

- [ ] **Step 4: Update requestApprovalViaIpc**

Change the `requestApprovalViaIpc` method signature from `(prompt: string)` to `(prompt: PermissionPrompt)`. Update both the broadcast message and the response handler:

```typescript
private requestApprovalViaIpc(prompt: PermissionPrompt): Promise<ApprovalResponse> {
  return new Promise((resolve) => {
    const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const timeout = setTimeout(() => {
      this.pendingIpcRequests.delete(approvalId);
      resolve({ decision: "deny", respondedBy: { channelType: "timeout", userId: "" } });
    }, 120_000);

    this.pendingIpcRequests.set(approvalId, (msg) => {
      clearTimeout(timeout);
      const decision = msg.decision === "approve" ? "approve" as const : "deny" as const;
      resolve({ decision, respondedBy: { channelType: "fleet", userId: "" } });
    });

    this.ipcServer?.broadcast({
      type: "fleet_approval_request",
      approvalId,
      instanceName: this.name,
      prompt,  // now PermissionPrompt object instead of string
    });
  });
}
```

- [ ] **Step 5: Remove old approval code from start()**

In the `start()` method, remove:
- Section "6. Approval server" (lines ~270-274): `if (this.approvalStrategyInstance) { ... }`
- Section "7. Prompt detector" (lines ~276-291): the entire `requestApproval` closure and `this.promptDetector = new TmuxPromptDetector(...)` + `this.promptDetector.startPolling()`

- [ ] **Step 6: Remove from stop()**

Remove from `stop()`:
- `this.promptDetector?.stop();`
- `await this.approvalStrategyInstance?.stop();`

- [ ] **Step 7: Update buildBackendConfig()**

Remove `approvalPort` and `approvalStrategy` from the returned config object.

- [ ] **Step 8: Verify build**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Errors only in files not yet updated (fleet-manager, backend/types, etc.)

- [ ] **Step 9: Commit**

```bash
git add src/daemon.ts
git commit -m "feat(daemon): handle permission_request IPC, remove hook-based approval and prompt detector"
```

---

### Task 6: Update Backend Types and ClaudeCodeBackend

**Files:**
- Modify: `src/backend/types.ts`
- Modify: `src/backend/claude-code.ts`
- Modify: `src/backend/index.ts`
- Test: `tests/backend/claude-code.test.ts`

- [ ] **Step 1: Update backend types**

In `src/backend/types.ts`:
- Remove the import of `ApprovalStrategy`
- Remove `approvalPort` and `approvalStrategy` from `CliBackendConfig`

```typescript
import type { TmuxManager } from "../tmux-manager.js";

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CliBackendConfig {
  workingDirectory: string;
  instanceDir: string;
  instanceName: string;
  mcpServers: Record<string, McpServerEntry>;
  systemPrompt?: string;
  skipPermissions?: boolean;
}
```

- [ ] **Step 2: Update ClaudeCodeBackend**

In `src/backend/claude-code.ts`:
- Remove `import { loadToolAllowlist } from "../approval/tmux-prompt-detector.js";`
- In `buildCommand()`: remove the `--dangerously-skip-permissions` flag block. The `skipPermissions` config option is no longer needed — permission relay handles unapproved tools, and the `allow` list handles auto-approved ones.
- In `writeConfig()`:
  - Remove the `if (config.skipPermissions)` early return block that wrote a bypass settings file
  - Remove `const approvalResult = config.approvalStrategy.setup(config.approvalPort);`
  - Remove `hooks: approvalResult.hooks ?? {},` from settings
  - Remove `...loadToolAllowlist(this.instanceDir),` from permissions.allow
  - Keep the `permissions.allow` and `permissions.deny` lists as-is (minus the allowlist merge)
  - Use the same settings for all instances (no more skipPermissions branch)

The non-skipPermissions settings become:
```typescript
const settings: Record<string, unknown> = {
  permissions: {
    allow: [
      "Read", "Edit", "Write", "Glob", "Grep", "Bash(*)",
      "WebFetch", "WebSearch", "Agent", "Skill",
      "mcp__ccd-channel__reply", "mcp__ccd-channel__react",
      "mcp__ccd-channel__edit_message", "mcp__ccd-channel__download_attachment",
      "mcp__ccd-channel__create_schedule", "mcp__ccd-channel__list_schedules",
      "mcp__ccd-channel__update_schedule", "mcp__ccd-channel__delete_schedule",
    ],
    deny: [
      "Bash(rm -rf /)", "Bash(rm -rf /*)",
      "Bash(rm -rf ~)", "Bash(rm -rf ~/*)",
      "Bash(dd *)", "Bash(mkfs *)",
    ],
    defaultMode: "default",
  },
  statusLine: {
    type: "command",
    command: statusLineCommand,
  },
};
```

- [ ] **Step 3: Update backend index**

In `src/backend/index.ts`, remove:
```typescript
export type { ApprovalStrategy } from "./approval-strategy.js";
export { HookBasedApproval } from "./hook-based-approval.js";
```

- [ ] **Step 4: Update tests**

In `tests/backend/claude-code.test.ts`, remove any references to `approvalStrategy`, `approvalPort`, `hooks`, `loadToolAllowlist`, or `tool-allowlist.json`. Update the `CliBackendConfig` fixture to match the new shape.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/backend/claude-code.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/backend/types.ts src/backend/claude-code.ts src/backend/index.ts tests/backend/claude-code.test.ts
git commit -m "refactor(backend): remove approval strategy, hooks, and allowlist from settings"
```

---

### Task 7: Update Fleet Manager and InstanceConfig

**Files:**
- Modify: `src/fleet-manager.ts`
- Modify: `src/types.ts`
- Test: `tests/fleet-manager.test.ts`

- [ ] **Step 1: Remove `approval_port` from InstanceConfig**

In `src/types.ts`, remove `approval_port?: number` from the `InstanceConfig` interface.

- [ ] **Step 2: Remove HookBasedApproval and port allocation from fleet manager**

In `src/fleet-manager.ts`, in the `startInstance` method (around line 120-135):
- Remove `const { HookBasedApproval } = await import("./backend/hook-based-approval.js");`
- Remove the `HookBasedApproval` instantiation block
- Remove the `port` parameter from the `startInstance` method signature
- Remove all port allocation logic (`BASE_PORT`, port maps, `config.approval_port = port`)
- Update `new Daemon(...)` to remove the `approval` argument:

```typescript
const daemon = new Daemon(name, config, instanceDir, topicMode, backend);
```

- [ ] **Step 2: Update handleApprovalFromInstance**

Update `handleApprovalFromInstance` to handle `PermissionPrompt` object:

```typescript
private handleApprovalFromInstance(instanceName: string, msg: Record<string, unknown>): void {
  if (!this.adapter) {
    this.sendApprovalResponse(instanceName, msg.approvalId as string, "deny");
    return;
  }

  const prompt = msg.prompt as { tool_name: string; description: string; input_preview?: string };
  const approvalId = msg.approvalId as string;
  const instanceConfig = this.fleetConfig?.instances[instanceName];
  const threadId = instanceConfig?.topic_id ? String(instanceConfig.topic_id) : undefined;

  this.adapter.sendApproval(prompt, (decision) => {
    this.sendApprovalResponse(instanceName, approvalId, decision);
  }, undefined, threadId).catch((err) => {
    this.logger.warn({ instanceName, err: (err as Error).message }, "Failed to send approval");
    this.sendApprovalResponse(instanceName, approvalId, "deny");
  });
}
```

- [ ] **Step 3: Update sendApprovalResponse signature**

Change from `"approve" | "always_allow" | "deny"` to `"approve" | "deny"`.

- [ ] **Step 4: Update fleet manager tests**

In `tests/fleet-manager.test.ts`, update any approval-related tests to use `PermissionPrompt` and the new decision types.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/fleet-manager.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/fleet-manager.ts tests/fleet-manager.test.ts
git commit -m "refactor(fleet): remove HookBasedApproval, update approval IPC for PermissionPrompt"
```

---

### Task 8: Update daemon-entry.ts

**Files:**
- Modify: `src/daemon-entry.ts`

- [ ] **Step 1: Remove port arg**

Remove the `--port` argument parsing and `config.approval_port = port;` line. The daemon no longer needs an approval port.

```typescript
import { Daemon } from "./daemon.js";
import type { InstanceConfig } from "./types.js";

const args = process.argv.slice(2);

function getArg(name: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : "";
}

const name = getArg("--instance");
const instanceDir = getArg("--instance-dir");
const config: InstanceConfig = JSON.parse(getArg("--config"));

const topicMode = args.includes("--topic-mode");
const daemon = new Daemon(name, config, instanceDir, topicMode);
```

- [ ] **Step 2: Commit**

```bash
git add src/daemon-entry.ts
git commit -m "refactor(daemon-entry): remove approval port argument"
```

---

### Task 9: Delete Old Approval Files

**Files:**
- Delete: `src/approval/approval-server.ts`
- Delete: `src/approval/tmux-prompt-detector.ts`
- Delete: `src/backend/hook-based-approval.ts`
- Delete: `src/backend/approval-strategy.ts`
- Delete: `tests/approval/approval-server.test.ts`
- Delete: `tests/approval/tmux-prompt-detector.test.ts`
- Delete: `tests/backend/hook-based-approval.test.ts`

- [ ] **Step 1: Delete files**

```bash
git rm src/approval/approval-server.ts
git rm src/approval/tmux-prompt-detector.ts
git rm src/backend/hook-based-approval.ts
git rm src/backend/approval-strategy.ts
git rm tests/approval/approval-server.test.ts
git rm tests/approval/tmux-prompt-detector.test.ts
git rm tests/backend/hook-based-approval.test.ts
```

- [ ] **Step 2: Check for remaining references**

Run: `grep -r "approval-server\|tmux-prompt-detector\|hook-based-approval\|approval-strategy" src/ tests/ --include="*.ts" -l`
Expected: No results (all references removed in previous tasks)

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: delete old approval system files (replaced by permission relay)"
```

---

### Task 10: Full Build and Test Verification

- [ ] **Step 1: TypeScript build check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Fix any remaining issues**

If any tests fail or type errors remain, fix them.

- [ ] **Step 4: Final commit (if fixes needed)**

```bash
git add -A
git commit -m "fix: resolve remaining type errors and test failures from permission relay migration"
```
