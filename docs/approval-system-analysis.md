# Permission System Analysis

Analysis of how the permission system works after migrating to Claude Code's native permission relay (2026-03-25). Replaces the old hook-based approval system (2026-03-23).

## Architecture

```
Claude calls a tool not in permissions.allow
  │
  ├─ Layer 1: permissions.deny (hard deny)
  │   Catastrophic commands: rm -rf /, dd, mkfs
  │   Claude sees: "Permission to use Bash with command X has been denied."
  │   No permission relay fires. No user override.
  │
  ├─ Layer 2: Permission relay (dual-path race)
  │   Claude Code sends permission_request to BOTH:
  │     Terminal → interactive Yes/No prompt
  │     Channel → MCP notification → IPC → Daemon → Telegram inline buttons
  │   First responder wins, other path cancelled.
  │     Allow → tool executes
  │     Deny → tool rejected
  │     120s timeout → deny
  │
  └─ Layer 3: Docker sandbox (if enabled)
      Command executes inside container regardless of which layer approved it
```

### skipPermissions mode

Meeting/debate instances use `skipPermissions: true`:
- `--dangerously-skip-permissions` CLI flag
- `permissions: { allow: ["*"], defaultMode: "bypassPermissions" }`
- No permission prompts at all — permission relay never fires

## What Claude sees

### On deny

| Scenario | Claude sees |
|----------|-----------|
| User denies via terminal | `"The user doesn't want to proceed with this tool use."` |
| User denies via Telegram | `"Denied via channel ccd-channel"` |
| Timeout (120s, no response) | `"Denied via channel ccd-channel"` + delayed `[System] timed out` channel message |
| Hard deny (permissions.deny) | `"Permission to use Bash with command X has been denied."` |

### On allow

| Scenario | Claude sees |
|----------|-----------|
| Tool in permissions.allow list | Tool output (no prompt shown) |
| User allows via terminal | Tool output |
| User allows via Telegram | Tool output |

Claude cannot distinguish auto-allowed from user-allowed. This is a Claude Code limitation.

## permissions.allow list

Tools that never trigger permission prompts:

```
Read, Edit, Write, Glob, Grep, Bash(*)
WebFetch, WebSearch, Agent, Skill
mcp__ccd-channel__reply, mcp__ccd-channel__react
mcp__ccd-channel__edit_message, mcp__ccd-channel__download_attachment
mcp__ccd-channel__create_schedule, mcp__ccd-channel__list_schedules
mcp__ccd-channel__update_schedule, mcp__ccd-channel__delete_schedule
```

Note: `Bash(*)` allows all Bash commands by default. Only commands matching `permissions.deny` patterns are hard-blocked. All other tools not in this list trigger the permission relay.

## permissions.deny list (hard deny)

```
Bash(rm -rf /), Bash(rm -rf /*)
Bash(rm -rf ~), Bash(rm -rf ~/*)
Bash(dd *), Bash(mkfs *)
```

## Changes from old system

| Aspect | Old (hook-based) | New (permission relay) |
|--------|------------------|----------------------|
| Mechanism | PreToolUse hook → curl → ApprovalServer HTTP | MCP notification → IPC → Daemon → MessageBus |
| Danger detection | Custom regex patterns in ApprovalServer | Claude Code's own permission settings |
| Tool allowlist | Self-managed `tool-allowlist.json` | Claude Code's native `permissions.allow` |
| Terminal prompts | Detected via tmux output polling | Native dual-path race (terminal + channel) |
| Buttons | Approve / Always / Deny | Allow / Deny |
| Port allocation | Each instance gets a dedicated HTTP port | No ports needed (IPC over Unix socket) |

## Known issues

1. **Timeout message ordering**: When a permission times out, the deny response arrives before the `[System] timed out` channel message because they travel different IPC paths. Claude can correlate them but ordering is not guaranteed.

2. **Dual-path race messages differ**: Terminal deny and channel deny produce different rejection messages from Claude Code. Not controllable by us.

3. **`Bash(*)` is broad**: The allow list permits all Bash commands. Only `permissions.deny` patterns are blocked. This means `rm file.txt` or `git push --force` will execute without any prompt. The old system had danger pattern detection for these; the new system relies on Claude Code's judgment.

## Test results (2026-03-25)

| Tool | Action | Path won | Claude sees | Timeout hint |
|------|--------|----------|-------------|-------------|
| puppeteer_navigate | Deny (terminal) | Terminal | "The user doesn't want to proceed..." | — |
| puppeteer_navigate | Timeout (terminal) | Terminal | "The user doesn't want to proceed..." | — |
| puppeteer_navigate | Timeout (channel) | Channel | "Denied via channel" | ✅ "[System] timed out" |
| puppeteer_screenshot | Deny (Telegram) | Channel | "Denied via channel" | — |
| puppeteer_screenshot | Timeout (channel) | Channel | "Denied via channel" | ✅ "[System] timed out" (delayed) |
