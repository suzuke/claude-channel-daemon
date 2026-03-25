# Design: Permission Relay Integration

## Purpose

Replace the two existing approval mechanisms (hook-based approval server + tmux prompt detector) with Claude Code's native permission relay protocol. This simplifies the codebase, eliminates terminal polling, and provides a cleaner, more reliable permission flow.

## Decisions

- **Full replacement**: remove both hook-based approval and tmux prompt detector
- **No danger pattern detection**: Claude Code's own permission settings determine what needs approval
- **No self-maintained allowlist**: Claude Code's native permission settings handle this
- **Inline buttons**: Telegram adapter uses inline keyboard buttons (Allow / Deny) for permission prompts

## Architecture

### Current Flow (to be removed)

```
Hook-based:  Claude Code → PreToolUse hook → curl → ApprovalServer → MessageBus → Adapter → User
Tmux-based:  Claude terminal → output.log → TmuxPromptDetector → sendApproval → User → tmux sendKeys
```

### New Flow

```
Claude Code → permission_request notification → MCP Server
MCP Server → IPC (permission_request) → Daemon → MessageBus.requestApproval() → Adapter (inline buttons)
User taps button → Adapter callback → Daemon → IPC (permission_response) → MCP Server
MCP Server → permission notification (allow/deny) → Claude Code
```

Topic mode variant: Daemon → IPC (`fleet_approval_request` with `PermissionPrompt` payload) → Fleet Manager → Adapter → User → reverse path (`fleet_approval_response`).

## Changes

### MCP Server (`src/channel/mcp-server.ts`)

1. Add `claude/channel/permission` to capabilities:
   ```typescript
   capabilities: {
     tools: {},
     experimental: {
       "claude/channel": {},
       "claude/channel/permission": {},
     },
   }
   ```

2. Register a notification handler via `mcp.setNotificationHandler()` (new pattern — existing code only sends notifications, never receives them):
   ```typescript
   mcp.setNotificationHandler(PermissionRequestSchema, async (notification) => {
     // notification.params: { request_id, tool_name, description, input_preview? }
   });
   ```

3. On receive: send IPC message to daemon, await response, send back permission notification via `mcp.notification()`.

4. **Timeout**: permission IPC requests need a 120s timeout (not the default 30s used for tool calls), since they require human interaction. Use a separate timeout constant `PERMISSION_TIMEOUT_MS = 120_000`.

### IPC Protocol (new message types)

```typescript
// MCP Server → Daemon
{
  type: "permission_request",
  requestId: number,          // IPC correlation ID
  request_id: string,         // Claude Code's 5-char ID
  tool_name: string,
  description: string,
  input_preview?: string,
}

// Daemon → MCP Server (via IPC response)
{
  requestId: number,
  result: { request_id: string, behavior: "allow" | "deny" },
}
```

This reuses the existing `ipcRequest` / `pendingRequests` pattern — the daemon responds on the same `requestId`, just like tool calls.

### Daemon (`src/daemon.ts`)

Handle `permission_request` IPC messages in the existing tool_call handler area:

- DM mode: `messageBus.requestApproval(prompt)` with structured prompt data
- Topic mode: forward via `fleet_approval_request` IPC (existing pattern)
- Return result as IPC response

### Channel Types (`src/channel/types.ts`)

Update `sendApproval` signature to accept structured data:

```typescript
interface PermissionPrompt {
  tool_name: string;
  description: string;
  input_preview?: string;
}

sendApproval(
  prompt: PermissionPrompt,
  callback: (decision: "approve" | "deny") => void,
  signal?: AbortSignal,
  threadId?: string,
): Promise<ApprovalHandle>;
```

Note: `always_allow` removed from decision type — no longer self-managed.

Also update `ApprovalResponse` to match:
```typescript
interface ApprovalResponse {
  decision: "approve" | "deny";  // was "approve" | "always_allow" | "deny"
  respondedBy?: { channelType: string; userId: string };
  reason?: string;
}
```

**Vocabulary mapping**: adapter uses `"approve"` / `"deny"`, MCP protocol uses `"allow"` / `"deny"`. The MCP server translates: `"approve"` → `"allow"` when sending the permission notification back to Claude Code.

### MessageBus (`src/channel/message-bus.ts`)

Update `requestApproval` to accept `PermissionPrompt` instead of `string`.

### Telegram Adapter

Update `sendApproval` to render inline keyboard buttons:

```
⚠️ Permission Request
Tool: Bash
> rm -rf dist/

[Allow]  [Deny]
```

- `tool_name` as header
- `input_preview` in code block (if present, truncated to ~200 chars)
- `description` as secondary text if no `input_preview`
- Grammy `InlineKeyboard` with Allow/Deny callback buttons
- `callbackQuery` handler resolves the callback

### ClaudeCodeBackend (`src/backend/claude-code.ts`)

- Remove `hooks` from settings generation (no more PreToolUse hook)
- Remove `loadToolAllowlist` import and usage
- Remove `--dangerously-skip-permissions` flag — the `permissions.allow` / `permissions.deny` lists in claude-settings.json now serve as the sole permission configuration. Tools in the `allow` list (Read, Edit, etc.) never trigger permission prompts; tools not in the list trigger the permission relay flow.
- Keep permission `allow` list for tools that should never prompt (Read, Edit, etc.)
- Keep permission `deny` list for catastrophic commands

### Files to Delete

- `src/approval/approval-server.ts`
- `src/approval/tmux-prompt-detector.ts`
- `src/backend/hook-based-approval.ts`
- `src/backend/approval-strategy.ts`

### Files to Modify

- `src/channel/mcp-server.ts` — add permission capability + notification handler
- `src/channel/types.ts` — update `sendApproval` signature
- `src/channel/message-bus.ts` — update `requestApproval` param type
- `src/channel/adapters/telegram.ts` — inline buttons for approval
- `src/daemon.ts` — handle permission_request IPC, remove promptDetector/approvalStrategy
- `src/backend/claude-code.ts` — remove hooks, allowlist
- `src/daemon-entry.ts` — remove ApprovalStrategy instantiation (if present)
- `src/backend/types.ts` — remove `approvalStrategy` and `approvalPort` from `CliBackendConfig`
- `src/fleet-manager.ts` — update `fleet_approval_request` IPC to carry `PermissionPrompt` instead of string prompt

## Non-Goals

- No "See more" expandable button (keep it simple for now)
- No multi-adapter simultaneous permission request race (reuse existing MessageBus pattern)
- No custom danger pattern detection

## Known Issues

### Timeout vs explicit deny ordering (2026-03-25)

When a permission request times out, the daemon sends two things:
1. `deny` IPC response → MCP server → Claude (direct response, fast)
2. `[System] timed out` channel message → IPC broadcast → MCP server → Claude (extra hop, slower)

The channel message may arrive after Claude has already processed the deny. In practice Claude correlates both messages within the same context, but the ordering is not guaranteed.

Possible improvement: send the channel message before the deny response with a small delay. Trade-off: adds latency to every timeout.

### Dual-path race behavior

Permission relay uses a dual-path race: terminal prompt and channel (Telegram) run simultaneously, first responder wins. Claude Code generates different rejection messages depending on which path responds:
- Terminal wins → `"The user doesn't want to proceed with this tool use."`
- Channel wins → `"Denied via channel ccd-channel"`

This is Claude Code's native behavior, not controllable by us.

## Testing

- Unit test: MCP server permission notification round-trip
- Unit test: Telegram adapter inline button rendering + callback
- Integration: end-to-end permission request → button tap → tool execution
