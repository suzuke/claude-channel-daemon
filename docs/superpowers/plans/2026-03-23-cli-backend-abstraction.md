> **PARTIALLY SUPERSEDED** — Task 2 (HookBasedApproval) and approval-related portions replaced by permission relay as of 2026-03-25.

# CLI Backend Abstraction Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Claude Code-specific logic from `daemon.ts` into a `CliBackend` interface + `ClaudeCodeBackend` implementation, enabling future support for alternative AI CLI backends.

**Architecture:** Introduce `CliBackend` and `ApprovalStrategy` interfaces in `src/backend/`. Move spawn command assembly, settings generation, statusline reading, auto-confirm, and cleanup logic from `Daemon` class into `ClaudeCodeBackend`. Wrap existing `ApprovalServer` in `HookBasedApproval`. Daemon delegates to the backend via dependency injection.

**Tech Stack:** TypeScript, Vitest, MCP SDK (unchanged)

**Spec:** `docs/superpowers/specs/2026-03-23-cli-backend-abstraction-design.md`

---

### Task 1: Create CliBackend and ApprovalStrategy interfaces

**Files:**
- Create: `src/backend/types.ts`
- Create: `src/backend/approval-strategy.ts`

- [ ] **Step 1: Write the CliBackend interface**

```typescript
// src/backend/types.ts
import type { TmuxManager } from "../tmux-manager.js";
import type { ContainerManager } from "../container-manager.js";
import type { ApprovalStrategy } from "./approval-strategy.js";

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
  /** Build the shell command string to launch the CLI in a tmux window. */
  buildCommand(config: CliBackendConfig): string;

  /** Write all config files the CLI needs before launch. */
  writeConfig(config: CliBackendConfig): void;

  /** Read context window usage percentage (0-100). Returns 0 if unavailable. */
  getContextUsage(): number;

  /** Read session ID for resume capability. Returns null if unavailable. */
  getSessionId(): string | null;

  /** Post-launch setup (e.g., auto-confirm prompts). Called after CLI spawns in tmux. */
  postLaunch?(tmux: TmuxManager, windowId: string): Promise<void>;

  /** Clean up config files on shutdown. */
  cleanup?(config: CliBackendConfig): void;
}
```

- [ ] **Step 2: Write the ApprovalStrategy interface**

```typescript
// src/backend/approval-strategy.ts
export interface ApprovalStrategy {
  /**
   * Return hook definitions to merge into CLI settings.
   * Hook-based: returns { hooks: { PreToolUse: [...] } }
   * Shell-wrapper: returns {} (no hooks needed)
   */
  setup(port: number): { hooks?: Record<string, unknown> };

  /** Start the approval service */
  start(): Promise<number>;

  /** Stop the approval service */
  stop(): Promise<void>;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx tsc --noEmit`
Expected: No new errors from these two files

- [ ] **Step 4: Commit**

```bash
git add src/backend/types.ts src/backend/approval-strategy.ts
git commit -m "feat: add CliBackend and ApprovalStrategy interfaces"
```

---

### Task 2: Create HookBasedApproval wrapping existing ApprovalServer

**Files:**
- Create: `src/backend/hook-based-approval.ts`
- Create: `tests/backend/hook-based-approval.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/backend/hook-based-approval.test.ts
import { describe, it, expect } from "vitest";
import { HookBasedApproval } from "../../src/backend/hook-based-approval.js";
import { MessageBus } from "../../src/channel/message-bus.js";

describe("HookBasedApproval", () => {
  it("setup() returns PreToolUse hook with correct port", () => {
    const bus = new MessageBus();
    const approval = new HookBasedApproval({ messageBus: bus, port: 18400 });
    const result = approval.setup(18400);

    expect(result.hooks).toBeDefined();
    expect(result.hooks!.PreToolUse).toBeDefined();
    const hooks = result.hooks!.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(hooks[0].matcher).toBe("Bash");
    expect(hooks[0].hooks[0].command).toContain("18400");
  });

  it("setup() hook command includes fail-closed deny on unreachable", () => {
    const bus = new MessageBus();
    const approval = new HookBasedApproval({ messageBus: bus, port: 18321 });
    const result = approval.setup(18321);
    const hooks = result.hooks!.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(hooks[0].hooks[0].command).toContain("permissionDecision");
    expect(hooks[0].hooks[0].command).toContain("deny");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/backend/hook-based-approval.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write HookBasedApproval implementation**

```typescript
// src/backend/hook-based-approval.ts
import type { ApprovalStrategy } from "./approval-strategy.js";
import { ApprovalServer } from "../approval/approval-server.js";
import type { MessageBus } from "../channel/message-bus.js";
import type { IpcServer } from "../channel/ipc-bridge.js";

export interface HookBasedApprovalOptions {
  messageBus: MessageBus;
  port: number;
  ipcServer?: IpcServer | null;
  topicMode?: boolean;
  instanceName?: string;
}

export class HookBasedApproval implements ApprovalStrategy {
  private server: ApprovalServer;

  constructor(private opts: HookBasedApprovalOptions) {
    this.server = new ApprovalServer({
      messageBus: opts.messageBus,
      port: opts.port,
      ipcServer: opts.ipcServer,
      topicMode: opts.topicMode,
      instanceName: opts.instanceName,
    });
  }

  setup(port: number): { hooks: Record<string, unknown> } {
    return {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `curl -s -X POST http://127.0.0.1:${port}/approve -H 'Content-Type: application/json' -d @- --max-time 130 --connect-timeout 1 || echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"approval server unreachable"}}'`,
                timeout: 135000,
              },
            ],
          },
        ],
      },
    };
  }

  async start(): Promise<number> {
    return this.server.start();
  }

  async stop(): Promise<void> {
    return this.server.stop();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/backend/hook-based-approval.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/backend/hook-based-approval.ts tests/backend/hook-based-approval.test.ts
git commit -m "feat: add HookBasedApproval wrapping ApprovalServer"
```

---

### Task 3: Create ClaudeCodeBackend

**Files:**
- Create: `src/backend/claude-code.ts`
- Create: `tests/backend/claude-code.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/backend/claude-code.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../../src/backend/claude-code.js";
import { MessageBus } from "../../src/channel/message-bus.js";
import { HookBasedApproval } from "../../src/backend/hook-based-approval.js";
import type { CliBackendConfig } from "../../src/backend/types.js";

const TEST_DIR = "/tmp/ccd-test-claude-backend";
const WORK_DIR = "/tmp/ccd-test-workdir";

function makeConfig(overrides?: Partial<CliBackendConfig>): CliBackendConfig {
  const bus = new MessageBus();
  return {
    workingDirectory: WORK_DIR,
    instanceDir: TEST_DIR,
    instanceName: "test",
    approvalPort: 18400,
    mcpServers: {
      "ccd-channel": {
        command: "node",
        args: ["/path/to/mcp-server.js"],
        env: { CCD_SOCKET_PATH: "/tmp/test.sock" },
      },
    },
    approvalStrategy: new HookBasedApproval({ messageBus: bus, port: 18400 }),
    ...overrides,
  };
}

describe("ClaudeCodeBackend", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(WORK_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  describe("buildCommand", () => {
    it("includes claude with --settings flag", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("claude");
      expect(cmd).toContain("--settings");
      expect(cmd).toContain("claude-settings.json");
    });

    it("includes --resume when session-id file exists", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "sess-123");
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--resume sess-123");
    });

    it("does not include --resume when no session-id", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).not.toContain("--resume");
    });

    it("includes CMUX_CLAUDE_HOOKS_DISABLED=1", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("CMUX_CLAUDE_HOOKS_DISABLED=1");
    });

    it("includes --dangerously-load-development-channels", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--dangerously-load-development-channels server:ccd-channel");
    });
  });

  describe("writeConfig", () => {
    it("writes .mcp.json with ccd-channel entry", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const mcpConfig = JSON.parse(readFileSync(join(WORK_DIR, ".mcp.json"), "utf-8"));
      expect(mcpConfig.mcpServers["ccd-channel"]).toBeDefined();
      expect(mcpConfig.mcpServers["ccd-channel"].command).toBe("node");
    });

    it("preserves existing .mcp.json entries", () => {
      writeFileSync(join(WORK_DIR, ".mcp.json"), JSON.stringify({
        mcpServers: { other: { command: "other-cmd", args: [], env: {} } },
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const mcpConfig = JSON.parse(readFileSync(join(WORK_DIR, ".mcp.json"), "utf-8"));
      expect(mcpConfig.mcpServers["other"]).toBeDefined();
      expect(mcpConfig.mcpServers["ccd-channel"]).toBeDefined();
    });

    it("writes claude-settings.json with hooks and permissions", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const settings = JSON.parse(readFileSync(join(TEST_DIR, "claude-settings.json"), "utf-8"));
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.permissions.allow).toContain("Read");
      expect(settings.permissions.allow).toContain("Bash(*)");
      expect(settings.statusLine).toBeDefined();
    });

    it("writes statusline script", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      expect(existsSync(join(TEST_DIR, "statusline.sh"))).toBe(true);
    });
  });

  describe("getContextUsage", () => {
    it("returns percentage from statusline.json", () => {
      writeFileSync(join(TEST_DIR, "statusline.json"), JSON.stringify({
        context_window: { used_percentage: 42 },
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.getContextUsage()).toBe(42);
    });

    it("returns 0 when file missing", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.getContextUsage()).toBe(0);
    });
  });

  describe("getSessionId", () => {
    it("returns session_id from statusline.json", () => {
      writeFileSync(join(TEST_DIR, "statusline.json"), JSON.stringify({
        session_id: "sess-abc",
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.getSessionId()).toBe("sess-abc");
    });

    it("returns null when file missing", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.getSessionId()).toBeNull();
    });
  });

  describe("cleanup", () => {
    it("removes ccd-channel from .mcp.json", () => {
      writeFileSync(join(WORK_DIR, ".mcp.json"), JSON.stringify({
        mcpServers: {
          "ccd-channel": { command: "node", args: [], env: {} },
          "other": { command: "x", args: [], env: {} },
        },
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.cleanup!(makeConfig());
      const mcpConfig = JSON.parse(readFileSync(join(WORK_DIR, ".mcp.json"), "utf-8"));
      expect(mcpConfig.mcpServers["ccd-channel"]).toBeUndefined();
      expect(mcpConfig.mcpServers["other"]).toBeDefined();
    });

    it("deletes .mcp.json if ccd-channel was the only entry", () => {
      writeFileSync(join(WORK_DIR, ".mcp.json"), JSON.stringify({
        mcpServers: { "ccd-channel": { command: "node", args: [], env: {} } },
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.cleanup!(makeConfig());
      expect(existsSync(join(WORK_DIR, ".mcp.json"))).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/backend/claude-code.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write ClaudeCodeBackend implementation**

Extract logic from `daemon.ts` lines 604-796 into `src/backend/claude-code.ts`:

```typescript
// src/backend/claude-code.ts
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { CliBackend, CliBackendConfig } from "./types.js";
import type { TmuxManager } from "../tmux-manager.js";
import { loadToolAllowlist } from "../approval/tmux-prompt-detector.js";

export class ClaudeCodeBackend implements CliBackend {
  constructor(private instanceDir: string) {}

  buildCommand(config: CliBackendConfig): string {
    const settingsPath = join(this.instanceDir, "claude-settings.json");
    let cmd = `CMUX_CLAUDE_HOOKS_DISABLED=1 claude --settings ${settingsPath} --dangerously-load-development-channels server:ccd-channel`;

    const sessionIdFile = join(this.instanceDir, "session-id");
    if (existsSync(sessionIdFile)) {
      const sid = readFileSync(sessionIdFile, "utf-8").trim();
      if (sid) cmd += ` --resume ${sid}`;
    }

    // NOTE: sandbox shell (CLAUDE_CODE_SHELL) is handled by the daemon,
    // not the backend — it's shared across backends.
    // Daemon prepends CLAUDE_CODE_SHELL={path} if containerManager is set.

    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // 1. Write .mcp.json
    const mcpConfigPath = join(config.workingDirectory, ".mcp.json");
    let mcpConfig: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(mcpConfigPath)) {
      try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch {}
    }
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      mcpConfig.mcpServers[name] = entry;
    }
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // 2. Get hooks from approval strategy
    const approvalResult = config.approvalStrategy.setup(config.approvalPort);

    // 3. Write statusline script
    const statusLineCommand = this.writeStatusLineScript();

    // 4. Write claude-settings.json
    const settings: Record<string, unknown> = {
      hooks: approvalResult.hooks ?? {},
      permissions: {
        allow: [
          "Read", "Edit", "Write", "Glob", "Grep", "Bash(*)",
          "WebFetch", "WebSearch", "Agent", "Skill",
          "mcp__ccd-channel__reply", "mcp__ccd-channel__react",
          "mcp__ccd-channel__edit_message", "mcp__ccd-channel__download_attachment",
          "mcp__ccd-channel__create_schedule", "mcp__ccd-channel__list_schedules",
          "mcp__ccd-channel__update_schedule", "mcp__ccd-channel__delete_schedule",
          // Merge user-approved "always allow" tools from persistent allowlist
          ...loadToolAllowlist(this.instanceDir),
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
    writeFileSync(
      join(this.instanceDir, "claude-settings.json"),
      JSON.stringify(settings),
    );
  }

  getContextUsage(): number {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      const data = JSON.parse(readFileSync(sf, "utf-8"));
      return data.context_window?.used_percentage ?? 0;
    } catch {
      return 0;
    }
  }

  getSessionId(): string | null {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      const data = JSON.parse(readFileSync(sf, "utf-8"));
      return data.session_id ?? null;
    } catch {
      return null;
    }
  }

  async postLaunch(tmux: TmuxManager, windowId: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const pane = await tmux.capturePane();
        if (pane.includes("I am using this for local development")) {
          await tmux.sendSpecialKey("Enter");
          continue;
        }
        if (pane.includes("New MCP server found") || pane.includes("Use this and all future MCP servers")) {
          await tmux.sendSpecialKey("Enter");
          continue;
        }
        if (pane.includes("Listening for channel messages")) {
          return;
        }
        if (pane.includes("$") || pane.includes("%") || pane.includes(">")) {
          return;
        }
      } catch {}
    }
  }

  cleanup(config: CliBackendConfig): void {
    // Remove ccd-channel from .mcp.json
    try {
      const mcpConfigPath = join(config.workingDirectory, ".mcp.json");
      if (existsSync(mcpConfigPath)) {
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
        if (mcpConfig.mcpServers?.["ccd-channel"]) {
          delete mcpConfig.mcpServers["ccd-channel"];
          if (Object.keys(mcpConfig.mcpServers).length === 0) {
            unlinkSync(mcpConfigPath);
          } else {
            writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
          }
        }
      }
    } catch {}
  }

  // NOTE: writeSandboxShell() stays in daemon.ts (shared across backends)

  private writeStatusLineScript(): string {
    const statusFile = join(this.instanceDir, "statusline.json");
    const script = `#!/bin/bash\nINPUT=$(cat)\necho "$INPUT" > "${statusFile}"\necho "ok"`;
    const scriptPath = join(this.instanceDir, "statusline.sh");
    writeFileSync(scriptPath, script, { mode: 0o755 });
    return scriptPath;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/backend/claude-code.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/backend/claude-code.ts tests/backend/claude-code.test.ts
git commit -m "feat: add ClaudeCodeBackend extracted from daemon.ts"
```

---

### Task 4: Create backend factory

**Files:**
- Create: `src/backend/factory.ts`
- Create: `src/backend/index.ts`

- [ ] **Step 1: Write factory**

```typescript
// src/backend/factory.ts
import type { CliBackend } from "./types.js";
import { ClaudeCodeBackend } from "./claude-code.js";

export function createBackend(name: string, instanceDir: string): CliBackend {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeBackend(instanceDir);
    default:
      throw new Error(`Unknown backend: ${name}. Available: claude-code`);
  }
}
```

- [ ] **Step 2: Write barrel export**

```typescript
// src/backend/index.ts
export type { CliBackend, CliBackendConfig, McpServerEntry } from "./types.js";
export type { ApprovalStrategy } from "./approval-strategy.js";
export { ClaudeCodeBackend } from "./claude-code.js";
export { HookBasedApproval } from "./hook-based-approval.js";
export { createBackend } from "./factory.js";
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/backend/factory.ts src/backend/index.ts
git commit -m "feat: add backend factory and barrel exports"
```

---

### Task 5: Refactor Daemon to use CliBackend

**Files:**
- Modify: `src/daemon.ts`
- Modify: `tests/daemon.test.ts`

This is the core refactoring task. Replace direct Claude Code logic in `Daemon` with backend delegation.

- [ ] **Step 1: Update Daemon constructor to accept CliBackend**

In `src/daemon.ts`, change the constructor to accept a `CliBackend` parameter and store it. Add the import.

```typescript
// Add import at top of daemon.ts
import type { CliBackend, CliBackendConfig } from "./backend/types.js";
import type { ApprovalStrategy } from "./backend/approval-strategy.js";

// Update constructor (currently lines 46-55)
constructor(
  private name: string,
  private config: InstanceConfig,
  private instanceDir: string,
  private topicMode = false,
  private containerManager?: ContainerManager,
  private backend?: CliBackend,
  private approvalStrategyInstance?: ApprovalStrategy,
) {
  this.logger = createLogger(config.log_level);
  this.messageBus = new MessageBus();
}
```

- [ ] **Step 2: Add helper method to build CliBackendConfig**

```typescript
// Add to Daemon class
private buildBackendConfig(): CliBackendConfig {
  const sockPath = join(this.instanceDir, "channel.sock");
  let serverJs = join(__dirname, "channel", "mcp-server.js");
  if (!existsSync(serverJs)) {
    serverJs = join(__dirname, "..", "dist", "channel", "mcp-server.js");
  }
  return {
    workingDirectory: this.config.working_directory,
    instanceDir: this.instanceDir,
    instanceName: this.name,
    approvalPort: this.config.approval_port ?? 18321,
    mcpServers: {
      "ccd-channel": {
        command: "node",
        args: [serverJs],
        env: { CCD_SOCKET_PATH: sockPath },
      },
    },
    approvalStrategy: this.approvalStrategyInstance!,
    containerManager: this.containerManager,
  };
}
```

- [ ] **Step 3: Replace spawnClaudeWindow() body**

Replace the body of `spawnClaudeWindow()` (lines 605-657) with backend delegation:

```typescript
private async spawnClaudeWindow(): Promise<void> {
  const backendConfig = this.buildBackendConfig();
  this.backend!.writeConfig(backendConfig);
  let claudeCmd = this.backend!.buildCommand(backendConfig);

  // Sandbox shell is shared across backends — daemon handles it
  if (this.containerManager) {
    const shellPath = this.writeSandboxShell();
    claudeCmd = `CLAUDE_CODE_SHELL=${shellPath} ${claudeCmd}`;
  }

  const windowId = await this.tmux!.createWindow(claudeCmd, this.config.working_directory);
  const windowIdFile = join(this.instanceDir, "window-id");
  writeFileSync(windowIdFile, windowId);

  // Post-launch setup (auto-confirm prompts for Claude Code)
  if (this.backend!.postLaunch) {
    this.backend!.postLaunch(this.tmux!, windowId).catch(err => {
      this.logger.warn({ err }, "Post-launch setup failed");
    });
  }
}
```

- [ ] **Step 4: Replace readContextPercentage() and saveSessionId()**

Replace `readContextPercentage()` (lines 670-678):
```typescript
private readContextPercentage(): number {
  return this.backend?.getContextUsage() ?? 0;
}
```

Replace `saveSessionId()` (lines 660-668):
```typescript
private saveSessionId(): void {
  const sid = this.backend?.getSessionId();
  if (sid) {
    writeFileSync(join(this.instanceDir, "session-id"), sid);
  }
}
```

- [ ] **Step 5: Replace stop() cleanup with backend.cleanup()**

In `stop()` (lines 332-346), replace the `.mcp.json` cleanup block with:
```typescript
// Clean up backend config files
if (this.backend?.cleanup) {
  this.backend.cleanup(this.buildBackendConfig());
}
```

- [ ] **Step 6: Replace approval server setup with ApprovalStrategy**

In `start()`, find where `ApprovalServer` is created and started. Replace with:
```typescript
// Instead of: this.approvalServer = new ApprovalServer({...}); await this.approvalServer.start();
if (this.approvalStrategyInstance) {
  const port = await this.approvalStrategyInstance.start();
  this.logger.debug({ port }, "Approval strategy started");
}
```

And in `stop()`, replace `await this.approvalServer?.stop()` with:
```typescript
await this.approvalStrategyInstance?.stop();
```

- [ ] **Step 7: Remove extracted methods**

Delete these methods from `daemon.ts` (they now live in `ClaudeCodeBackend`):
- `writeSettings()` (lines 709-775)
- `writeStatusLineScript()` (lines 789-795)
- `autoConfirmDevChannels()` (lines 577-602)

Keep in daemon (shared across backends):
- `writeSandboxShell()` (lines 777-787)

Remove the now-unused `ApprovalServer` import.

- [ ] **Step 8: Update existing tests**

Update `tests/daemon.test.ts` to pass a backend:

```typescript
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { HookBasedApproval } from "../src/backend/hook-based-approval.js";
import { MessageBus } from "../src/channel/message-bus.js";

// In each test:
const backend = new ClaudeCodeBackend("/tmp/ccd-test-instance");
const approval = new HookBasedApproval({ messageBus: new MessageBus(), port: 18321 });
const daemon = new Daemon("test", config, "/tmp/ccd-test-instance", false, undefined, backend, approval);
```

- [ ] **Step 9: Run all tests**

Run: `npx vitest run`
Expected: All tests pass — zero behavior change

- [ ] **Step 10: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 11: Commit**

```bash
git add src/daemon.ts tests/daemon.test.ts
git commit -m "refactor: delegate CLI-specific logic to CliBackend in daemon.ts"
```

---

### Task 6: Update FleetManager to wire backend

**Files:**
- Modify: `src/fleet-manager.ts`
- Modify: `tests/fleet-manager.test.ts` (if backend wiring affects tests)

- [ ] **Step 1: Read fleet-manager.ts to find Daemon instantiation**

Locate where `Daemon` is created and update to pass backend + approval strategy.

- [ ] **Step 2: Add backend wiring to fleet-manager**

```typescript
// Add imports
import { createBackend } from "./backend/factory.js";
import { HookBasedApproval } from "./backend/hook-based-approval.js";

// At instance creation (where new Daemon(...) is called):
const backendName = "claude-code"; // future: instanceConfig.backend ?? "claude-code"
const backend = createBackend(backendName, instanceDir);
const approval = new HookBasedApproval({
  messageBus: daemon.getMessageBus(),
  port: instanceConfig.approval_port ?? BASE_PORT + index,
  ipcServer: ipcClient, // topic mode IPC
  topicMode: true,
  instanceName: name,
});
// Pass backend and approval to Daemon constructor
```

- [ ] **Step 3: Run all tests**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/fleet-manager.ts tests/fleet-manager.test.ts
git commit -m "refactor: wire CliBackend into FleetManager"
```

---

### Task 7: Add backend config to InstanceConfig type

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts` (if defaults need updating)

- [ ] **Step 1: Add backend field to InstanceConfig**

```typescript
// In src/types.ts, add to InstanceConfig:
export interface InstanceConfig {
  // ... existing fields ...
  /** CLI backend to use. Default: "claude-code" */
  backend?: string;
}
```

- [ ] **Step 2: Add backend field to FleetDefaults**

```typescript
// In src/types.ts, add to FleetDefaults:
export interface FleetDefaults extends Partial<InstanceConfig> {
  // ... existing fields ...
  backend?: string;
}
```

- [ ] **Step 3: Update FleetManager to read backend from config**

In fleet-manager.ts, change the hardcoded `"claude-code"` to:
```typescript
const backendName = instanceConfig.backend ?? fleetConfig.defaults?.backend ?? "claude-code";
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/config.ts src/fleet-manager.ts
git commit -m "feat: add backend config field to InstanceConfig"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: TypeScript strict compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Verify file structure**

```
src/backend/
├── types.ts
├── approval-strategy.ts
├── claude-code.ts
├── hook-based-approval.ts
├── factory.ts
└── index.ts
tests/backend/
├── claude-code.test.ts
└── hook-based-approval.test.ts
```

- [ ] **Step 5: Final commit (if any cleanup needed)**

```bash
git commit -m "chore: CLI backend abstraction complete"
```
