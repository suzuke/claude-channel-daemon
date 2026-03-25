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

Topic mode variant: Daemon → IPC → Fleet Manager → Adapter → User → reverse path.

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

2. Listen for `notifications/claude/channel/permission_request` from Claude Code:
   ```typescript
   // Notification params: { request_id, tool_name, description, input_preview? }
   ```

3. On receive: send IPC message to daemon, await response, send back permission notification.

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
- Remove `--dangerously-skip-permissions` flag (permission relay handles everything)
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

## Non-Goals

- No "See more" expandable button (keep it simple for now)
- No multi-adapter simultaneous permission request race (reuse existing MessageBus pattern)
- No custom danger pattern detection

## Testing

- Unit test: MCP server permission notification round-trip
- Unit test: Telegram adapter inline button rendering + callback
- Integration: end-to-end permission request → button tap → tool execution
