> **PARTIALLY SUPERSEDED** — Approval-related sections (ApprovalStrategy, HookBasedApproval) replaced by permission relay as of 2026-03-25.

# CLI Backend Abstraction Layer Design

## Problem

`claude-channel-daemon` is tightly coupled to Claude Code. The spawn command, settings injection, hook-based approval, context monitoring, and session resumption all depend on Claude Code-specific APIs. This makes it impossible to use alternative AI CLI tools (OpenCode, Gemini CLI) without rewriting core daemon logic.

## Goals

1. **Avoid vendor lock-in** — decouple daemon logic from any specific CLI tool
2. **Enable model flexibility** — allow different instances to use different backends/models
3. **Reduce cost** — ability to route simple tasks to cheaper models via alternative CLIs
4. **Preserve behavior** — zero functional change for existing Claude Code users

## Non-Goals

- Implementing OpenCode or Gemini CLI backends (future work)
- Hot-swapping backends during a running session
- Abstracting the MCP server layer (all three CLIs support standard MCP)

## Strategy

Phase 1 (this spec): Extract Claude Code-specific logic from `daemon.ts` into a `ClaudeCodeBackend` class behind a `CliBackend` interface. The approval mechanism is kept as-is (`ApprovalServer` class unchanged) but wrapped in an `ApprovalStrategy` interface to isolate the hook-format coupling. This interface is speculative — it may change in Phase 2 when a second approval strategy exists. Validate the interface design with the existing Claude Code implementation.

Phase 2 (future): Implement a second backend (likely OpenCode) to prove the abstraction works. May require a POC to determine the best approval strategy for backends without Claude Code's `PreToolUse` hooks.

## Architecture

### CliBackend Interface

```typescript
// src/backend/types.ts

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CliBackendConfig {
  workingDirectory: string;
  instanceDir: string;
  instanceName: string;
  approvalPort: number;
  mcpServers: Record<string, McpServerEntry>;
  approvalStrategy: ApprovalStrategy;
  containerManager?: ContainerManager;
}

export interface CliBackend {
  /**
   * Build the shell command string to launch the CLI in a tmux window.
   * Includes all flags, env vars, and session resume logic.
   */
  buildCommand(config: CliBackendConfig): string;

  /**
   * Write all config files the CLI needs before launch.
   * For Claude Code: .mcp.json + claude-settings.json (hooks, permissions, statusLine).
   * Merges approval hooks from config.approvalStrategy.setup().
   */
  writeConfig(config: CliBackendConfig): void;

  /**
   * Read context window usage percentage (0-100).
   * Returns 0 if not supported or unavailable.
   */
  getContextUsage(): number;

  /**
   * Read session ID for resume capability.
   * Returns null if not supported or unavailable.
   */
  getSessionId(): string | null;

  /**
   * Post-launch setup (e.g., auto-confirm development channel prompts).
   * Called after the CLI process is spawned in tmux.
   * No-op by default for backends that don't need it.
   */
  postLaunch?(tmux: TmuxManager, windowId: string): Promise<void>;

  /**
   * Clean up config files written by writeConfig() on shutdown.
   * E.g., remove ccd-channel entry from .mcp.json.
   */
  cleanup?(config: CliBackendConfig): void;
}
```

### ApprovalStrategy Interface

```typescript
// src/backend/approval-strategy.ts

export interface ApprovalStrategy {
  /**
   * Configure the approval mechanism.
   * Returns hook definitions to merge into CLI settings (if applicable).
   * For hook-based approval: returns { hooks: { PreToolUse: [...] } }
   * For shell-wrapper approval: returns {} (no hooks needed)
   */
  setup(port: number): { hooks?: Record<string, unknown> };

  /** Start the approval service (e.g., HTTP server). Returns the actual port. */
  start(): Promise<number>;

  /** Stop the approval service */
  stop(): Promise<void>;
}
```

### ClaudeCodeBackend Implementation

```typescript
// src/backend/claude-code.ts

export class ClaudeCodeBackend implements CliBackend {
  private instanceDir: string;

  constructor(instanceDir: string) {
    this.instanceDir = instanceDir;
  }

  buildCommand(config: CliBackendConfig): string {
    // Moved from daemon.ts spawnClaudeWindow():
    // - CMUX_CLAUDE_HOOKS_DISABLED=1
    // - claude --settings {settingsPath}
    // - --dangerously-load-development-channels server:ccd-channel
    // - --resume {sessionId} (if available)
    // - CLAUDE_CODE_SHELL={sandboxShell} (if containerManager present)
  }

  writeConfig(config: CliBackendConfig): void {
    // Moved from daemon.ts writeSettings() + writeStatusLineScript() + .mcp.json writing:
    // 1. Write .mcp.json with config.mcpServers
    // 2. Get hooks from config.approvalStrategy.setup(port)
    // 3. Generate statusline script (writeStatusLineScript() — Claude Code-specific)
    // 4. Write claude-settings.json with:
    //    - hooks (from approval strategy)
    //    - permissions (allow/deny lists)
    //    - statusLine command (path to generated script)
  }

  getContextUsage(): number {
    // Moved from daemon.ts readContextPercentage():
    // Read {instanceDir}/statusline.json → context_window.used_percentage
  }

  getSessionId(): string | null {
    // Moved from daemon.ts saveSessionId():
    // Read {instanceDir}/statusline.json → session_id
  }

  async postLaunch(tmux: TmuxManager, windowId: string): Promise<void> {
    // Moved from daemon.ts autoConfirmDevChannels():
    // Auto-confirm "I am using this for local development" and
    // "New MCP server found" prompts in Claude Code.
  }

  cleanup(config: CliBackendConfig): void {
    // Moved from daemon.ts stop():
    // Remove ccd-channel entry from .mcp.json
    // Delete claude-settings.json
  }
}
```

### HookBasedApproval Implementation

```typescript
// src/backend/hook-based-approval.ts

export class HookBasedApproval implements ApprovalStrategy {
  // Wraps the existing ApprovalServer class.
  // ApprovalServer itself stays unchanged.

  private server: ApprovalServer;

  constructor(opts: { messageBus: MessageBus; ipcServer?: IpcServer; ... }) {
    this.server = new ApprovalServer(opts);
  }

  setup(port: number): { hooks: Record<string, unknown> } {
    return {
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{
            type: "command",
            command: `curl -s -X POST http://127.0.0.1:${port}/approve ...`,
            timeout: 135000,
          }],
        }],
      },
    };
  }

  start(): Promise<number> { return this.server.start(); }
  stop(): Promise<void> { return this.server.stop(); }
}
```

### Backend Factory

```typescript
// src/backend/factory.ts

export function createBackend(name: string, instanceDir: string): CliBackend {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeBackend(instanceDir);
    default:
      throw new Error(`Unknown backend: ${name}`);
  }
}
```

### Configuration

```yaml
# config.yaml — new field
backend: claude-code          # global default

instances:
  coding-bot:
    working_directory: /path/to/project
    # backend: opencode       # future: per-instance override
```

## Changes to Existing Code

### daemon.ts

| Current code | Change |
|---|---|
| `spawnClaudeWindow()` — builds claude command, writes .mcp.json | Delegates to `backend.buildCommand()` + `backend.writeConfig()`. tmux window creation stays in daemon. Calls `backend.postLaunch()` after spawn. |
| `writeSettings()` — writes claude-settings.json with hooks/permissions | Moved into `ClaudeCodeBackend.writeConfig()` |
| `writeStatusLineScript()` — generates shell script for statusline.json | Moved into `ClaudeCodeBackend.writeConfig()` (Claude Code-specific telemetry) |
| `readContextPercentage()` | Replaced by `backend.getContextUsage()` |
| `saveSessionId()` | Replaced by `backend.getSessionId()` |
| `autoConfirmDevChannels()` — auto-confirms Claude Code startup prompts | Moved into `ClaudeCodeBackend.postLaunch()` |
| `stop()` — removes ccd-channel from .mcp.json | Delegates cleanup to `backend.cleanup()` |
| `writeSandboxShell()` | Stays in daemon (shared across backends — any CLI that supports shell override can use it) |

### fleet-manager.ts

```typescript
// Instance creation — inject backend and approval strategy
const backendName = instanceConfig.backend ?? globalConfig.backend ?? "claude-code";
const backend = createBackend(backendName, instanceDir);
const approvalStrategy = new HookBasedApproval({
  messageBus,
  port: config.approval_port ?? 18321,
  ipcServer: topicMode ? ipcServer : null,
  topicMode,
  instanceName: config.name,
});
const daemon = new InstanceDaemon(config, backend, approvalStrategy);
```

### approval-server.ts

**No changes.** The existing `ApprovalServer` class is wrapped by `HookBasedApproval` without modification.

### mcp-server.ts

**No changes.** MCP is supported by all target CLIs. The MCP server communicates with the daemon via IPC, not directly with the CLI.

### context-guardian.ts

**Minimal change.** Data source changes from direct file read to `backend.getContextUsage()` / `backend.getSessionId()`, passed through daemon.

## File Structure

```
src/backend/
├── types.ts                # CliBackend, CliBackendConfig, McpServerEntry
├── approval-strategy.ts    # ApprovalStrategy interface
├── claude-code.ts          # ClaudeCodeBackend
├── hook-based-approval.ts  # HookBasedApproval (wraps ApprovalServer)
└── factory.ts              # createBackend()
```

## What Stays Unchanged

- `mcp-server.ts` — standard MCP, works with all CLIs
- `ipc-bridge.ts` — daemon ↔ MCP communication
- `context-guardian.ts` — state machine logic (only data source changes)
- `transcript-monitor.ts` — reads `statusline.json` for transcript path. **Note:** depends on Claude Code's statusline format; may need a `backend.getTranscriptPath()` method in Phase 2 if other backends don't produce this file.
- `message-bus.ts` — channel message routing
- `adapters/telegram.ts` — Telegram integration
- `scheduler/` — cron scheduling
- `tmux-manager.ts` — tmux session management
- `memory-layer.ts` — memory directory watching

## Testing Strategy

- Extract → run existing integration tests → verify zero behavior change
- Unit test `ClaudeCodeBackend.buildCommand()` with various config combinations
- Unit test `HookBasedApproval.setup()` output format
- Verify `backend.getContextUsage()` reads statusline.json correctly

## Future Work

- **OpenCode backend POC** — validate MCP push notifications work, determine approval strategy
- **Gemini CLI backend POC** — same validation, assess Gemini model quality for target use cases
- **Per-instance backend selection** — config.yaml `backend` field per instance
- **Shell-wrapper approval** — generic approval strategy for CLIs without hook support
