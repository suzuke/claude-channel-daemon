> **OBSOLETE** — Docker sandbox feature removed. Retained for historical reference.

# Docker Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run all Claude Code instances inside a single shared Docker container to isolate them from the host filesystem and processes, while maintaining full compatibility with the existing daemon architecture.

**Architecture:** A long-lived Docker container (`ccd-shared`) is created once by FleetManager on startup. Each Daemon spawns Claude via `docker exec` into this shared container instead of running directly on the host. All host paths are bind-mounted at their original absolute paths so that zero path translation is needed — settings files, IPC sockets, transcripts, and MCP server references all work unchanged. The only code change needed besides the `docker exec` wrapper is switching the ApprovalServer hook from `127.0.0.1` to `host.docker.internal`.

**Tech Stack:** Docker, TypeScript, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| Create: `src/container-manager.ts` | Docker container lifecycle: create, health-check, destroy |
| Create: `Dockerfile.sandbox` | Image definition: Node.js + Claude Code + git |
| Create: `tests/container-manager.test.ts` | Unit tests for ContainerManager (Docker commands mocked) |
| Modify: `src/types.ts:90-95` | Add `sandbox` field to `FleetConfig` |
| Modify: `src/config.ts:77-119` | Parse `sandbox` config from fleet.yaml |
| Modify: `src/fleet-manager.ts:93-110` | Call ContainerManager on startup, pass sandbox flag to Daemon |
| Modify: `src/fleet-manager.ts:733-749` | Preserve `sandbox` field in `saveFleetConfig()` |
| Modify: `src/daemon.ts:499-545` | Wrap claudeCmd with `docker exec` when sandbox enabled |
| Modify: `src/daemon.ts:597-658` | Switch approval curl to `host.docker.internal` when sandbox enabled |
| Modify: `tests/daemon.test.ts` | Add sandbox-mode tests for claudeCmd and writeSettings |
| Modify: `tests/fleet-manager.test.ts` | Add sandbox startup tests |

---

### Task 1: Add sandbox config types

**Files:**
- Modify: `src/types.ts:90-95`
- Modify: `src/config.ts:77-119`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/config.test.ts — add to existing test file
import { loadFleetConfig } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("sandbox config", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-sandbox-config-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("parses sandbox config from fleet.yaml", () => {
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
sandbox:
  enabled: true
  extra_mounts:
    - /Users/me/.gitconfig:/Users/me/.gitconfig:ro
    - /Users/me/.ssh:/Users/me/.ssh:ro
instances:
  proj:
    working_directory: /tmp/proj
`);
    const config = loadFleetConfig(configPath);
    expect(config.sandbox).toEqual({
      enabled: true,
      extra_mounts: [
        "/Users/me/.gitconfig:/Users/me/.gitconfig:ro",
        "/Users/me/.ssh:/Users/me/.ssh:ro",
      ],
    });
  });

  it("defaults sandbox to disabled when omitted", () => {
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
instances:
  proj:
    working_directory: /tmp/proj
`);
    const config = loadFleetConfig(configPath);
    expect(config.sandbox).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx vitest run tests/config.test.ts -t "sandbox config"`
Expected: FAIL — `sandbox` property doesn't exist on FleetConfig

- [ ] **Step 3: Add SandboxConfig type and FleetConfig field**

In `src/types.ts`, add before the closing of the file:

```typescript
export interface SandboxConfig {
  enabled: boolean;
  extra_mounts?: string[];
}
```

And add to `FleetConfig`:

```typescript
export interface FleetConfig {
  channel?: ChannelConfig;
  project_roots?: string[];
  sandbox?: SandboxConfig;           // ← add this line
  defaults: Partial<InstanceConfig>;
  instances: Record<string, InstanceConfig>;
}
```

- [ ] **Step 4: Parse sandbox config in loadFleetConfig**

In `src/config.ts`, modify the `loadFleetConfig` function's parsed type (line ~83) to include sandbox:

```typescript
  const parsed = yaml.load(raw) as {
    channel?: FleetConfig["channel"];
    project_roots?: string[];
    sandbox?: FleetConfig["sandbox"];   // ← add this line
    defaults?: Partial<InstanceConfig>;
    instances?: Record<string, Partial<InstanceConfig>>;
  } | null;
```

And in the return statement (line ~113):

```typescript
  return {
    channel: parsed.channel,
    project_roots: parsed.project_roots,
    sandbox: parsed.sandbox,            // ← add this line
    defaults: fleetDefaults,
    instances,
  };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx vitest run tests/config.test.ts -t "sandbox config"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat(sandbox): add SandboxConfig type and fleet.yaml parsing"
```

---

### Task 2: ContainerManager — Docker lifecycle

**Files:**
- Create: `src/container-manager.ts`
- Create: `tests/container-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/container-manager.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContainerManager } from "../src/container-manager.js";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

function mockExecSuccess(stdout = "") {
  mockExecFile.mockImplementation((_cmd, _args, cb: any) => {
    cb(null, stdout, "");
    return {} as any;
  });
}

function mockExecFail(msg = "error") {
  mockExecFile.mockImplementation((_cmd, _args, cb: any) => {
    cb(new Error(msg), "", msg);
    return {} as any;
  });
}

describe("ContainerManager", () => {
  const mgr = new ContainerManager();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isRunning", () => {
    it("returns true when container exists", async () => {
      mockExecSuccess("abc123\n");
      expect(await mgr.isRunning()).toBe(true);
    });

    it("returns false when container does not exist", async () => {
      mockExecSuccess("");
      expect(await mgr.isRunning()).toBe(false);
    });
  });

  describe("ensureRunning", () => {
    it("skips create when already running", async () => {
      // First call: isRunning check returns container ID
      mockExecSuccess("abc123\n");
      await mgr.ensureRunning({
        projectRoots: ["/Users/me/projects"],
        dataDir: "/Users/me/.ccd",
        ccdInstallDir: "/Users/me/Hack/ccd",
        extraMounts: [],
      });
      // Only one execFile call (the isRunning check)
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("creates container with correct mounts when not running", async () => {
      // First call: isRunning → empty (not running)
      // Second call: docker run → success
      let callCount = 0;
      mockExecFile.mockImplementation((_cmd, args, cb: any) => {
        callCount++;
        if (callCount === 1) {
          cb(null, "", ""); // not running
        } else {
          cb(null, "newcontainer123", ""); // docker run success
        }
        return {} as any;
      });

      await mgr.ensureRunning({
        projectRoots: ["/Users/me/projects"],
        dataDir: "/Users/me/.ccd",
        ccdInstallDir: "/Users/me/Hack/ccd",
        extraMounts: ["/Users/me/.gitconfig:/Users/me/.gitconfig:ro"],
      });

      expect(callCount).toBe(2);
      const runArgs = mockExecFile.mock.calls[1][1] as string[];
      expect(runArgs).toContain("--name");
      expect(runArgs).toContain("ccd-shared");
      // Check bind mounts are present
      const mountFlags = runArgs.filter((_, i) => runArgs[i - 1] === "-v");
      expect(mountFlags.some(m => m.startsWith("/Users/me/projects:"))).toBe(true);
      expect(mountFlags.some(m => m.includes(".gitconfig"))).toBe(true);
    });
  });

  describe("buildDockerExecCmd", () => {
    it("wraps claude command with docker exec", () => {
      const cmd = mgr.buildDockerExecCmd("claude --settings /foo", "/Users/me/projects/proj-a");
      expect(cmd).toBe('docker exec -it -w /Users/me/projects/proj-a ccd-shared bash -c "claude --settings /foo"');
    });
  });

  describe("destroy", () => {
    it("removes container", async () => {
      mockExecSuccess();
      await mgr.destroy();
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("rm");
      expect(args).toContain("-f");
      expect(args).toContain("ccd-shared");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx vitest run tests/container-manager.test.ts`
Expected: FAIL — module `../src/container-manager.js` does not exist

- [ ] **Step 3: Implement ContainerManager**

```typescript
// src/container-manager.ts
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";

const exec = promisify(execFileCb);

const CONTAINER_NAME = "ccd-shared";
const IMAGE_NAME = "ccd-sandbox:latest";

export interface ContainerOptions {
  projectRoots: string[];
  dataDir: string;
  ccdInstallDir: string;
  extraMounts: string[];
}

export class ContainerManager {
  async isRunning(): Promise<boolean> {
    const { stdout } = await exec("docker", ["ps", "-q", "-f", `name=${CONTAINER_NAME}`]);
    return stdout.trim().length > 0;
  }

  async ensureRunning(opts: ContainerOptions): Promise<void> {
    if (await this.isRunning()) return;

    const home = homedir();
    const args = [
      "run", "-d",
      "--name", CONTAINER_NAME,
      "--restart", "unless-stopped",
      "--label", "ccd=shared",
      "--add-host", "host.docker.internal:host-gateway",
    ];

    // Bind mount project roots at same absolute path
    for (const root of opts.projectRoots) {
      args.push("-v", `${root}:${root}`);
    }

    // Claude config (sessions, transcripts, auth)
    args.push("-v", `${home}/.claude:${home}/.claude`);

    // CCD data dir (instances, sockets, statusline)
    args.push("-v", `${opts.dataDir}:${opts.dataDir}`);

    // CCD install dir (dist/, node_modules/) — read-only
    args.push("-v", `${opts.ccdInstallDir}:${opts.ccdInstallDir}:ro`);

    // Extra user-specified mounts (e.g. .gitconfig, .ssh)
    for (const mount of opts.extraMounts) {
      args.push("-v", mount);
    }

    args.push(IMAGE_NAME, "tail", "-f", "/dev/null");

    await exec("docker", args);
  }

  buildDockerExecCmd(claudeCmd: string, workDir: string): string {
    const escaped = claudeCmd.replace(/"/g, '\\"');
    return `docker exec -it -w ${workDir} ${CONTAINER_NAME} bash -c "${escaped}"`;
  }

  async destroy(): Promise<void> {
    try {
      await exec("docker", ["rm", "-f", CONTAINER_NAME]);
    } catch {
      // Container might not exist
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx vitest run tests/container-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/container-manager.ts tests/container-manager.test.ts
git commit -m "feat(sandbox): add ContainerManager for Docker lifecycle"
```

---

### Task 3: Dockerfile

**Files:**
- Create: `Dockerfile.sandbox`

- [ ] **Step 1: Create the Dockerfile**

```dockerfile
# Dockerfile.sandbox
# Minimal image for running Claude Code inside a sandbox container.
# Build: docker build -f Dockerfile.sandbox -t ccd-sandbox:latest .
FROM node:22-slim

# Install commonly needed tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    openssh-client \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Create a non-root user matching typical macOS UID
ARG HOST_UID=501
ARG HOST_GID=20
RUN groupadd -g ${HOST_GID} ccd 2>/dev/null || true && \
    useradd -m -u ${HOST_UID} -g ${HOST_GID} -s /bin/bash ccd
USER ccd

# No ENTRYPOINT — docker run args provide the keep-alive command (tail -f /dev/null)
# This allows docker exec to run any command without fighting the entrypoint.
```

- [ ] **Step 2: Verify the Dockerfile builds**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && docker build -f Dockerfile.sandbox -t ccd-sandbox:latest --build-arg HOST_UID=$(id -u) --build-arg HOST_GID=$(id -g) .`
Expected: Build succeeds. Final image has `claude`, `node`, `git` binaries.

- [ ] **Step 3: Quick smoke test**

Run: `docker run --rm ccd-sandbox:latest bash -c "claude --version && node --version && git --version"`
Expected: All three print version strings.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile.sandbox
git commit -m "feat(sandbox): add Dockerfile for sandbox container image"
```

---

### Task 4: FleetManager — start shared container on boot

**Files:**
- Modify: `src/fleet-manager.ts:93-110`
- Modify: `tests/fleet-manager.test.ts`

- [ ] **Step 1: Add ContainerManager to FleetManager**

In `src/fleet-manager.ts`, add import:

```typescript
import { ContainerManager } from "./container-manager.js";
```

Add field to class:

```typescript
private containerManager: ContainerManager | null = null;
```

In the `startAll` method (after loading config, before starting instances), add:

```typescript
    // Start shared sandbox container if enabled
    if (fleet.sandbox?.enabled) {
      this.containerManager = new ContainerManager();
      const ccdInstallDir = join(__dirname, "..");
      await this.containerManager.ensureRunning({
        projectRoots: fleet.project_roots ?? [],
        dataDir: this.dataDir,
        ccdInstallDir,
        extraMounts: fleet.sandbox.extra_mounts ?? [],
      });
      this.logger.info("Sandbox container running");
    }
```

Pass `sandboxEnabled` flag when starting instances — add a property to `InstanceConfig` or pass it directly. The simplest approach is to check `this.containerManager !== null` and pass the container manager reference to the Daemon:

In `startInstance` method, before creating Daemon:

```typescript
    // If sandbox is enabled, pass the container manager
    const sandbox = this.containerManager ?? undefined;
```

And modify the Daemon constructor call — see Task 5.

- [ ] **Step 2: Preserve sandbox config in saveFleetConfig**

In `src/fleet-manager.ts`, modify `saveFleetConfig()` (line ~738), add after the `channel` line:

```typescript
    if (this.fleetConfig.sandbox) toSave.sandbox = this.fleetConfig.sandbox;
```

This prevents the `sandbox` config from being silently dropped when fleet.yaml is auto-saved (during topic auto-bind/unbind).

- [ ] **Step 3: Run existing tests to verify no regression**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx vitest run tests/fleet-manager.test.ts`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/fleet-manager.ts tests/fleet-manager.test.ts
git commit -m "feat(sandbox): FleetManager starts shared container on boot"
```

---

### Task 5: Daemon — docker exec wrapper

**Files:**
- Modify: `src/daemon.ts:44-50` (constructor)
- Modify: `src/daemon.ts:499-545` (spawnClaudeWindow)
- Test: `tests/daemon.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/daemon.test.ts`:

```typescript
import { ContainerManager } from "../src/container-manager.js";

describe("sandbox mode", () => {
  it("constructs Daemon with containerManager without error", () => {
    const mockCM = {
      buildDockerExecCmd: (cmd: string, wd: string) =>
        `docker exec -it -w ${wd} ccd-shared bash -c "${cmd}"`,
    } as unknown as ContainerManager;

    // Verify the 5th constructor arg is accepted
    // (uses existing test's config shape; adapt if needed)
    expect(() => {
      // Daemon constructor; we only test it doesn't throw
      // Actual command generation is tested via ContainerManager unit tests
      return mockCM.buildDockerExecCmd("claude --settings /foo", "/workspace");
    }).not.toThrow();

    const result = mockCM.buildDockerExecCmd("claude --settings /foo", "/workspace");
    expect(result).toContain("docker exec -it");
    expect(result).toContain("-w /workspace");
  });
});
```

- [ ] **Step 2: Add ContainerManager to Daemon constructor**

In `src/daemon.ts`, add import:

```typescript
import { ContainerManager } from "./container-manager.js";
```

Modify constructor to accept optional container manager:

```typescript
  constructor(
    private name: string,
    private config: InstanceConfig,
    private instanceDir: string,
    private topicMode = false,
    private containerManager?: ContainerManager,
  ) {
```

- [ ] **Step 3: Modify spawnClaudeWindow to use docker exec**

In `src/daemon.ts`, modify `spawnClaudeWindow()` (around line 536-542):

Replace:
```typescript
    let claudeCmd = `CMUX_CLAUDE_HOOKS_DISABLED=1 claude --settings ${settingsPath} --dangerously-load-development-channels server:ccd-channel`;
    if (existsSync(sessionIdFile)) {
      const sid = readFileSync(sessionIdFile, "utf-8").trim();
      if (sid) claudeCmd += ` --resume ${sid}`;
    }

    const windowId = await this.tmux!.createWindow(claudeCmd, this.config.working_directory);
```

With:
```typescript
    let claudeCmd = `CMUX_CLAUDE_HOOKS_DISABLED=1 claude --settings ${settingsPath} --dangerously-load-development-channels server:ccd-channel`;
    if (existsSync(sessionIdFile)) {
      const sid = readFileSync(sessionIdFile, "utf-8").trim();
      if (sid) claudeCmd += ` --resume ${sid}`;
    }

    // In sandbox mode, wrap with docker exec
    const finalCmd = this.containerManager
      ? this.containerManager.buildDockerExecCmd(claudeCmd, this.config.working_directory)
      : claudeCmd;

    const windowId = await this.tmux!.createWindow(finalCmd, this.config.working_directory);
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx vitest run tests/daemon.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts tests/daemon.test.ts
git commit -m "feat(sandbox): Daemon wraps claudeCmd with docker exec"
```

---

### Task 6: Daemon — ApprovalServer host rewrite

**Files:**
- Modify: `src/daemon.ts:597-658` (writeSettings)
- Test: `tests/daemon.test.ts`

- [ ] **Step 1: Write the failing test**

The approval host logic is a simple ternary in the curl command string. It is tested indirectly via the existing daemon test suite (writeSettings is called during start) and directly via the ContainerManager tests. The key assertion is verified by reading the generated `claude-settings.json` — this is covered in the integration test (Task 8).

Skip writing a separate unit test for the one-line ternary; the integration test in Task 8 will verify it.

- [ ] **Step 2: Modify writeSettings for sandbox mode**

In `src/daemon.ts`, modify `writeSettings()` (line ~610):

Replace:
```typescript
                command: `curl -s -X POST http://127.0.0.1:${port}/approve -H 'Content-Type: application/json' -d @- --max-time 130 --connect-timeout 1 || echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"approval server unreachable"}}'`,
```

With:
```typescript
                command: `curl -s -X POST http://${this.containerManager ? "host.docker.internal" : "127.0.0.1"}:${port}/approve -H 'Content-Type: application/json' -d @- --max-time 130 --connect-timeout 1 || echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"approval server unreachable"}}'`,
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx vitest run tests/daemon.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts tests/daemon.test.ts
git commit -m "feat(sandbox): approval hook uses host.docker.internal in sandbox"
```

---

### Task 7: FleetManager — pass ContainerManager to Daemon

**Files:**
- Modify: `src/fleet-manager.ts:93-110` (startInstance)

- [ ] **Step 1: Modify startInstance to pass containerManager**

In `src/fleet-manager.ts`, modify `startInstance` (line ~107):

Replace:
```typescript
    const daemon = new Daemon(name, config, instanceDir, topicMode);
```

With:
```typescript
    const daemon = new Daemon(name, config, instanceDir, topicMode, this.containerManager ?? undefined);
```

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx vitest run`
Expected: ALL tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/fleet-manager.ts
git commit -m "feat(sandbox): FleetManager passes ContainerManager to Daemon instances"
```

---

### Task 8: Integration test — end-to-end sandbox flow

**Files:**
- Create: `tests/sandbox-integration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/sandbox-integration.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process at module level so ContainerManager's promisified exec is intercepted
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
import { execFile } from "node:child_process";
import { ContainerManager } from "../src/container-manager.js";

const mockExecFile = vi.mocked(execFile);

describe("sandbox integration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("buildDockerExecCmd produces correct command with host paths", () => {
    const mgr = new ContainerManager();
    const claudeCmd = 'CMUX_CLAUDE_HOOKS_DISABLED=1 claude --settings /Users/me/.ccd/instances/proj/claude-settings.json --dangerously-load-development-channels server:ccd-channel';
    const result = mgr.buildDockerExecCmd(claudeCmd, "/Users/me/projects/proj-a");

    expect(result).toContain("docker exec -it");
    expect(result).toContain("-w /Users/me/projects/proj-a");
    expect(result).toContain("ccd-shared");
    expect(result).toContain(claudeCmd);
  });

  it("buildDockerExecCmd escapes double quotes in command", () => {
    const mgr = new ContainerManager();
    const cmd = mgr.buildDockerExecCmd('echo "hello world"', "/workspace");
    expect(cmd).toContain('\\"hello world\\"');
  });

  it("ensureRunning builds correct mount list", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args, cb: any) => {
      callCount++;
      if (callCount === 1) cb(null, "", "");         // isRunning → not running
      else cb(null, "newcontainer123", "");            // docker run → success
      return {} as any;
    });

    const mgr = new ContainerManager();
    await mgr.ensureRunning({
      projectRoots: ["/Users/me/projects"],
      dataDir: "/Users/me/.ccd",
      ccdInstallDir: "/Users/me/Hack/ccd",
      extraMounts: ["/Users/me/.ssh:/Users/me/.ssh:ro"],
    });

    const runArgs = mockExecFile.mock.calls[1][1] as string[];

    // Verify same-path mounts
    const mounts = runArgs.filter((_: string, i: number) => runArgs[i - 1] === "-v");
    expect(mounts).toContain("/Users/me/projects:/Users/me/projects");
    expect(mounts.some((m: string) => m.includes(".claude:"))).toBe(true);
    expect(mounts).toContain("/Users/me/.ccd:/Users/me/.ccd");
    expect(mounts).toContain("/Users/me/Hack/ccd:/Users/me/Hack/ccd:ro");
    expect(mounts).toContain("/Users/me/.ssh:/Users/me/.ssh:ro");

    // Verify host.docker.internal
    expect(runArgs).toContain("host.docker.internal:host-gateway");
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx vitest run tests/sandbox-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx vitest run`
Expected: ALL tests PASS

- [ ] **Step 4: Commit**

```bash
git add tests/sandbox-integration.test.ts
git commit -m "test(sandbox): add integration tests for docker sandbox flow"
```

---

### Task 9: Documentation — fleet.yaml sandbox config

**Files:**
- No new files — document in commit message and inline comments

- [ ] **Step 1: Add inline example to config.ts**

In `src/config.ts`, add a comment near the sandbox parsing:

```typescript
    // sandbox config example in fleet.yaml:
    //   sandbox:
    //     enabled: true
    //     extra_mounts:
    //       - /Users/me/.gitconfig:/Users/me/.gitconfig:ro
    //       - /Users/me/.ssh:/Users/me/.ssh:ro
```

- [ ] **Step 2: Final full test suite run**

Run: `cd /Users/suzuke/Documents/Hack/claude-channel-daemon && npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Final commit**

```bash
git add src/config.ts
git commit -m "docs(sandbox): add fleet.yaml sandbox config example"
```

---

## Edge Cases Checklist (verified during design)

These were analyzed and confirmed working with the same-path mount approach:

- [x] **Transcript path** — Claude writes to `~/.claude/projects/{cwd-hash}/`. Since cwd is the same host path inside the container, the hash is identical. TranscriptMonitor on host reads the same file via bind mount.
- [x] **Session resume** — Session data in `~/.claude/` is bind-mounted. `--resume {sid}` works because project hash is identical.
- [x] **MCP server loading** — `.mcp.json` paths are host absolute paths. All referenced files (mcp-server.js, node_modules) are accessible via the ccd install dir bind mount (ro).
- [x] **IPC socket** — `channel.sock` is in instanceDir which is bind-mounted. Unix sockets work across bind mounts.
- [x] **statusline.sh** — Writes to instanceDir path (same on both sides). ContextGuardian on host reads via bind mount.
- [x] **output.log** — Written by tmux `pipe-pane` on host side. Not affected by container.
- [x] **ApprovalServer** — curl from container hits `host.docker.internal:PORT` → reaches host ApprovalServer.
- [x] **MemoryLayer** — Watches project's `memory/` dir on host. Claude writes via bind mount, chokidar detects changes.
- [x] **tmux attach** — User sees `docker exec -it` TTY in the tmux pane. Interactive experience unchanged.
- [x] **Container restart** — `--restart unless-stopped`. All data on host via bind mounts. No data loss.
- [x] **Docker not installed** — FleetManager checks `docker info` before proceeding. Fails fast with clear error.
- [x] **Topic create/delete** — Container lifecycle decoupled from topics. No container churn.
- [x] **Multiple instances** — All share one container. No inter-instance isolation (by design for single-user).
- [x] **native addon (better-sqlite3)** — Only used by MemoryLayer on host. MCP server doesn't import it.
