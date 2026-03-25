> **OBSOLETE** — Docker sandbox feature removed. Retained for historical reference.

# Sandbox Auto-Bake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect when Claude installs packages inside the Docker sandbox, record those install commands, and bake them into the Dockerfile during context rotation — so packages persist across container rebuilds without any manual configuration.

**Architecture:** The approval hook already intercepts every Bash command before execution. We add pattern matching to detect install commands (pip install, apt-get install, cargo install, npm install -g) and record them to `installed-packages.txt`. During context rotation, the daemon checks if new packages were recorded and, if thresholds are met, appends them to Dockerfile.sandbox and rebuilds the image. A manual `ccd sandbox bake` CLI command is also provided.

**Tech Stack:** TypeScript, Docker CLI, Commander.js (existing CLI framework)

**Core Insight:** Claude is already the dependency resolver — it figures out what's needed and installs it. We just observe and persist.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/install-recorder.ts` | Create | Pattern matching for install commands + file recording |
| `src/container-manager.ts` | Modify | Add `shouldAutoBake()`, `autoBake()`, `generateDockerfilePatch()` |
| `src/approval/approval-server.ts` | Modify | Call install recorder after approving Bash commands |
| `src/daemon.ts` | Modify | Call auto-bake check during rotation |
| `src/cli.ts` | Modify | Add `ccd sandbox bake` subcommand |
| `Dockerfile.sandbox` | Modify | Add sudo for non-root user, add P0 packages |
| `tests/install-recorder.test.ts` | Create | Unit tests for pattern matching |
| `tests/container-manager.test.ts` | Modify | Tests for bake logic |

---

### Task 1: Install Command Recorder

**Files:**
- Create: `src/install-recorder.ts`
- Create: `tests/install-recorder.test.ts`

- [ ] **Step 1: Write failing tests for install command pattern matching**

```typescript
// tests/install-recorder.test.ts
import { describe, it, expect } from "vitest";
import { parseInstallCommand } from "../src/install-recorder.js";

describe("parseInstallCommand", () => {
  it("detects pip install", () => {
    expect(parseInstallCommand("pip install pymupdf")).toEqual({
      type: "pip", packages: ["pymupdf"],
    });
    expect(parseInstallCommand("pip3 install --break-system-packages yt-dlp requests")).toEqual({
      type: "pip", packages: ["yt-dlp", "requests"],
    });
  });

  it("detects apt-get install", () => {
    expect(parseInstallCommand("sudo apt-get install -y ffmpeg")).toEqual({
      type: "apt", packages: ["ffmpeg"],
    });
    expect(parseInstallCommand("apt-get install -y --no-install-recommends ffmpeg curl")).toEqual({
      type: "apt", packages: ["ffmpeg", "curl"],
    });
  });

  it("detects cargo install", () => {
    expect(parseInstallCommand("cargo install ripgrep")).toEqual({
      type: "cargo", packages: ["ripgrep"],
    });
  });

  it("detects npm install -g", () => {
    expect(parseInstallCommand("npm install -g typescript")).toEqual({
      type: "npm", packages: ["typescript"],
    });
  });

  it("detects apt install (without -get)", () => {
    expect(parseInstallCommand("sudo apt install -y ffmpeg")).toEqual({
      type: "apt", packages: ["ffmpeg"],
    });
  });

  it("returns null for non-install commands", () => {
    expect(parseInstallCommand("ls -la")).toBeNull();
    expect(parseInstallCommand("pip list")).toBeNull();
    expect(parseInstallCommand("npm install")).toBeNull(); // local install, not -g
    expect(parseInstallCommand("git commit")).toBeNull();
  });

  it("ignores pip install edge cases (files, URLs, local paths)", () => {
    expect(parseInstallCommand("pip install -r requirements.txt")).toBeNull();
    expect(parseInstallCommand("pip install .")).toBeNull();
    expect(parseInstallCommand("pip install -e .")).toBeNull();
    expect(parseInstallCommand("pip install git+https://github.com/foo/bar")).toBeNull();
    expect(parseInstallCommand("pip install ./my-package")).toBeNull();
  });

  it("handles multiline commands (extracts install from pipeline)", () => {
    expect(parseInstallCommand("apt-get update && apt-get install -y ffmpeg")).toEqual({
      type: "apt", packages: ["ffmpeg"],
    });
  });

  it("deduplicates when recording the same package twice", () => {
    // Tested via recordInstall + readPendingPackages in integration tests
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/install-recorder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement install-recorder.ts**

```typescript
// src/install-recorder.ts
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export interface InstallCommand {
  type: "pip" | "apt" | "cargo" | "npm";
  packages: string[];
}

const INSTALL_PATTERNS: Array<{
  type: InstallCommand["type"];
  pattern: RegExp;
  extract: (match: RegExpMatchArray) => string[];
}> = [
  {
    type: "pip",
    pattern: /pip3?\s+install\s+(.+)/,
    extract: (m) => {
      const tokens = m[1].split(/\s+/);
      const skipNext = new Set(["-r", "-c", "-e", "--requirement", "--constraint", "--editable"]);
      const packages: string[] = [];
      let skip = false;
      for (const t of tokens) {
        if (skip) { skip = false; continue; }
        if (skipNext.has(t)) { skip = true; continue; }
        if (t.startsWith("-") || t.startsWith("--")) continue;
        if (t === "." || t.startsWith("./") || t.startsWith("/")) continue;  // local paths
        if (t.includes("://") || t.includes("+https")) continue;  // URLs
        if (t.endsWith(".txt") || t.endsWith(".cfg") || t.endsWith(".toml")) continue;  // files
        packages.push(t);
      }
      return packages;
    },
  },
  {
    type: "apt",
    pattern: /apt(?:-get)?\s+install\s+(.+)/,
    extract: (m) => m[1].split(/\s+/).filter(p => !p.startsWith("-") && !p.startsWith("--")),
  },
  {
    type: "cargo",
    pattern: /cargo\s+install\s+(.+)/,
    extract: (m) => m[1].split(/\s+/).filter(p => !p.startsWith("-") && !p.startsWith("--")),
  },
  {
    type: "npm",
    pattern: /npm\s+install\s+-g\s+(.+)/,
    extract: (m) => m[1].split(/\s+/).filter(p => !p.startsWith("-") && !p.startsWith("--")),
  },
];

export function parseInstallCommand(command: string): InstallCommand | null {
  for (const { type, pattern, extract } of INSTALL_PATTERNS) {
    const match = command.match(pattern);
    if (match) {
      const packages = extract(match);
      if (packages.length > 0) return { type, packages };
    }
  }
  return null;
}

export function recordInstall(filePath: string, install: InstallCommand): void {
  const ts = new Date().toISOString();
  // Deduplicate: check existing records before appending
  const existing = new Set<string>();
  if (existsSync(filePath)) {
    for (const line of readFileSync(filePath, "utf-8").split("\n")) {
      const [type, pkg] = line.split("|");
      if (type && pkg) existing.add(`${type}|${pkg}`);
    }
  }
  const newLines = install.packages
    .filter(pkg => !existing.has(`${install.type}|${pkg}`))
    .map(pkg => `${install.type}|${pkg}|${ts}`);
  if (newLines.length > 0) {
    appendFileSync(filePath, newLines.join("\n") + "\n");
  }
}

export interface PendingPackages {
  apt: string[];
  pip: string[];
  cargo: string[];
  npm: string[];
  count: number;
  oldestTs: Date | null;
}

export function readPendingPackages(filePath: string): PendingPackages {
  const result: PendingPackages = { apt: [], pip: [], cargo: [], npm: [], count: 0, oldestTs: null };
  if (!existsSync(filePath)) return result;

  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return result;

  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const [type, pkg, ts] = line.split("|");
    if (!type || !pkg) continue;
    const key = `${type}|${pkg}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (type === "apt") result.apt.push(pkg);
    else if (type === "pip") result.pip.push(pkg);
    else if (type === "cargo") result.cargo.push(pkg);
    else if (type === "npm") result.npm.push(pkg);

    if (ts) {
      const date = new Date(ts);
      if (!result.oldestTs || date < result.oldestTs) result.oldestTs = date;
    }
  }
  result.count = result.apt.length + result.pip.length + result.cargo.length + result.npm.length;
  return result;
}

export function clearPendingPackages(filePath: string): void {
  writeFileSync(filePath, "");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/install-recorder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/install-recorder.ts tests/install-recorder.test.ts
git commit -m "feat(sandbox): add install command recorder with pattern matching"
```

---

### Task 2: Wire Recorder into Approval Server

**Files:**
- Modify: `src/approval/approval-server.ts:87-117` (the `req.on("end")` handler)

- [ ] **Step 1: Write failing test — approval server records install commands**

```typescript
// tests/approval/approval-server.test.ts — add to existing test file
it("records install commands on approval", async () => {
  // POST a pip install command to the approval endpoint
  // Verify installed-packages.txt gets the entry
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/approval/approval-server.test.ts`
Expected: FAIL

- [ ] **Step 3: Add recorder call to approval-server.ts**

In `ApprovalServer` constructor, accept an optional `installRecordPath` parameter.
After the `permissionDecision = "allow"` branch (line ~108), add:

```typescript
// After deciding to allow a Bash command, check if it's an install command
if (permissionDecision === "allow" && tool_name === "Bash" && typeof tool_input?.command === "string") {
  const install = parseInstallCommand(tool_input.command);
  if (install && this.installRecordPath) {
    recordInstall(this.installRecordPath, install);
  }
}
```

Import `parseInstallCommand` and `recordInstall` from `../install-recorder.js`.
Add `installRecordPath` to `ApprovalOptions` interface (optional string).
Store as `this.installRecordPath` in constructor.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/approval/approval-server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/approval/approval-server.ts tests/approval/approval-server.test.ts
git commit -m "feat(sandbox): wire install recorder into approval server"
```

---

### Task 3: Add Auto-Bake to ContainerManager

**Files:**
- Modify: `src/container-manager.ts`
- Create or modify: `tests/container-manager.test.ts`

- [ ] **Step 1: Write failing tests for shouldAutoBake and generateDockerfilePatch**

```typescript
import { describe, it, expect } from "vitest";
import { generateDockerfilePatch } from "../src/container-manager.js";

describe("generateDockerfilePatch", () => {
  it("generates apt + pip RUN commands with sudo for apt", () => {
    const patch = generateDockerfilePatch({
      apt: ["ffmpeg", "python3-venv"],
      pip: ["pymupdf", "yt-dlp"],
      cargo: [],
      npm: [],
      count: 4,
      oldestTs: new Date(),
    });
    expect(patch).toContain("apt-get install");
    expect(patch).toContain("ffmpeg");
    expect(patch).toContain("pip3 install");
    expect(patch).toContain("pymupdf");
    expect(patch).toContain("# Auto-baked");
    expect(patch).toContain("sudo apt-get");
  });
});

describe("shouldAutoBake", () => {
  it("returns false with no packages", () => {
    const cm = new ContainerManager();
    expect(cm.shouldAutoBake("/nonexistent/path")).toBe(false);
  });

  it("returns true when count >= threshold", () => {
    // Create temp file with 3+ entries, verify returns true
  });

  it("returns true when oldest record >= 24 hours", () => {
    // Create temp file with 1 entry dated 25 hours ago, verify returns true
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/container-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement bake methods in container-manager.ts**

Add to `ContainerManager`:

```typescript
import { readPendingPackages, clearPendingPackages, type PendingPackages } from "./install-recorder.js";
import { readFileSync, appendFileSync } from "node:fs";

// Constants
const BAKE_THRESHOLD_COUNT = 3;
const BAKE_THRESHOLD_HOURS = 24;

export function generateDockerfilePatch(pending: PendingPackages): string {
  const lines: string[] = [];
  const date = new Date().toISOString().split("T")[0];
  lines.push(`\n# Auto-baked from Claude's install history (${date})`);

  // All commands use sudo since auto-baked lines go after USER ccd
  if (pending.apt.length > 0) {
    lines.push(`RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends \\`);
    lines.push(pending.apt.map(p => `    ${p}`).join(" \\\n") + " \\");
    lines.push("    && sudo rm -rf /var/lib/apt/lists/*");
  }
  if (pending.pip.length > 0) {
    lines.push(`RUN pip3 install --break-system-packages ${pending.pip.join(" ")}`);
  }
  if (pending.cargo.length > 0) {
    lines.push(`RUN cargo install ${pending.cargo.join(" ")}`);
  }
  if (pending.npm.length > 0) {
    lines.push(`RUN npm install -g ${pending.npm.join(" ")}`);
  }
  return lines.join("\n") + "\n";
}

// Add to ContainerManager class:
shouldAutoBake(recordPath: string): boolean {
  const pending = readPendingPackages(recordPath);
  if (pending.count === 0) return false;
  if (pending.count >= BAKE_THRESHOLD_COUNT) return true;
  if (pending.oldestTs) {
    const hoursAgo = (Date.now() - pending.oldestTs.getTime()) / 3600000;
    if (hoursAgo >= BAKE_THRESHOLD_HOURS) return true;
  }
  return false;
}

async autoBake(recordPath: string, dockerfilePath: string): Promise<{ success: boolean; packages: PendingPackages }> {
  const pending = readPendingPackages(recordPath);
  if (pending.count === 0) return { success: true, packages: pending };

  const patch = generateDockerfilePatch(pending);

  // Append patch at end of Dockerfile (after USER ccd, using sudo for apt)
  appendFileSync(dockerfilePath, patch);

  // Rebuild image (use Dockerfile's directory as build context, not cwd)
  const { dirname } = await import("node:path");
  const buildContext = dirname(dockerfilePath);
  await exec("docker", ["build", "-f", dockerfilePath, "-t", IMAGE_NAME, buildContext]);

  // Remove old container (next ensureRunning will create new one)
  await this.destroy();

  // Clear records
  clearPendingPackages(recordPath);

  return { success: true, packages: pending };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/container-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/container-manager.ts tests/container-manager.test.ts
git commit -m "feat(sandbox): add auto-bake logic to container manager"
```

---

### Task 4: Wire Auto-Bake into Daemon Rotation

**Files:**
- Modify: `src/daemon.ts:305-311` (the `rotate` event handler)

- [ ] **Step 1: Add bake check to rotation flow**

In `daemon.ts`, find the `this.guardian.on("rotate", ...)` handler (line 305). Add auto-bake check between `saveSessionId()` and `tmux.killWindow()`:

```typescript
this.guardian.on("rotate", async () => {
  this.logger.info("Context rotation — killing and respawning Claude");
  this.saveSessionId();

  // Auto-bake: check if Claude installed new packages in the container
  if (this.containerManager) {
    const recordPath = join(this.instanceDir, "installed-packages.txt");
    if (this.containerManager.shouldAutoBake(recordPath)) {
      const dockerfilePath = join(this.config.ccd_install_dir ?? __dirname, "..", "Dockerfile.sandbox");
      this.logger.info("Auto-baking new packages into sandbox image...");
      try {
        // Notify user via channel
        if (this.lastChatId) {
          this.pushChannelMessage(
            "📦 正在將新安裝的套件寫入 Dockerfile 並重建 sandbox image...",
            { chat_id: this.lastChatId, ...(this.lastThreadId ? { thread_id: this.lastThreadId } : {}) }
          );
        }
        const { packages } = await this.containerManager.autoBake(recordPath, dockerfilePath);
        const summary = [
          packages.apt.length > 0 ? `apt: ${packages.apt.join(", ")}` : "",
          packages.pip.length > 0 ? `pip: ${packages.pip.join(", ")}` : "",
          packages.cargo.length > 0 ? `cargo: ${packages.cargo.join(", ")}` : "",
          packages.npm.length > 0 ? `npm: ${packages.npm.join(", ")}` : "",
        ].filter(Boolean).join("; ");
        this.logger.info({ summary }, "Auto-bake complete");
      } catch (err) {
        this.logger.warn({ err }, "Auto-bake failed — continuing rotation");
      }
    }
  }

  await this.tmux?.killWindow();
  this.transcriptMonitor?.resetOffset();
  await this.spawnClaudeWindow();
  // ...
});
```

- [ ] **Step 2: Pass installRecordPath to ApprovalServer**

Where `ApprovalServer` is constructed in `daemon.ts`, add the `installRecordPath` option:

```typescript
installRecordPath: this.containerManager
  ? join(this.instanceDir, "installed-packages.txt")
  : undefined,
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts
git commit -m "feat(sandbox): wire auto-bake into context rotation"
```

---

### Task 5: Add `ccd sandbox bake` CLI Command

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add sandbox subcommand group and bake command**

```typescript
const sandbox = program
  .command("sandbox")
  .description("Manage Docker sandbox");

sandbox
  .command("bake")
  .description("Bake recorded package installs into the Dockerfile and rebuild")
  .option("--dry-run", "Show what would be added without modifying anything")
  .option("--dockerfile <path>", "Path to Dockerfile.sandbox", join(__dirname, "..", "Dockerfile.sandbox"))
  .action(async (opts) => {
    const { readPendingPackages } = await import("./install-recorder.js");
    const { generateDockerfilePatch, ContainerManager } = await import("./container-manager.js");

    // Scan all instances for installed-packages.txt
    const instancesDir = join(DATA_DIR, "instances");
    // ... read all instance dirs, merge pending packages
    // Show summary, optionally apply
  });

sandbox
  .command("reset")
  .description("Recreate sandbox container")
  .action(async () => {
    const { ContainerManager } = await import("./container-manager.js");
    const cm = new ContainerManager();
    await cm.destroy();
    console.log("Sandbox container removed. Will recreate on next daemon start.");
  });
```

- [ ] **Step 2: Test manually**

Run: `npx tsx src/cli.ts sandbox bake --dry-run`
Expected: Shows "No pending packages" or lists pending packages

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat(sandbox): add ccd sandbox bake and reset CLI commands"
```

---

### Task 6: Update Dockerfile with sudo + P0 Packages

**Files:**
- Modify: `Dockerfile.sandbox`

- [ ] **Step 1: Update Dockerfile**

```dockerfile
# Dockerfile.sandbox
# Minimal image for running Claude Code inside a sandbox container.
# Build: docker build -f Dockerfile.sandbox -t ccd-sandbox:latest --build-arg HOST_UID=$(id -u) --build-arg HOST_GID=$(id -g) .
FROM node:22-slim

# Install commonly needed tools + P0 packages for skills
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    openssh-client \
    ca-certificates \
    sudo \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Python tools
RUN pip3 install --break-system-packages uv yt-dlp

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Create a non-root user matching typical macOS UID
ARG HOST_UID=501
ARG HOST_GID=20
RUN groupadd -g ${HOST_GID} ccd 2>/dev/null || true && \
    useradd -m -u ${HOST_UID} -g ${HOST_GID} -s /bin/bash ccd && \
    echo "ccd ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Configure user-space install paths
USER ccd
RUN mkdir -p /home/ccd/.local/bin /home/ccd/.cargo/bin /home/ccd/.npm-global && \
    npm config set prefix /home/ccd/.npm-global
ENV PATH="/home/ccd/.local/bin:/home/ccd/.cargo/bin:/home/ccd/.npm-global/bin:${PATH}"

# No ENTRYPOINT — docker run args provide the keep-alive command (tail -f /dev/null)
```

- [ ] **Step 2: Build and verify**

Run: `docker build -f Dockerfile.sandbox -t ccd-sandbox:latest --build-arg HOST_UID=$(id -u) --build-arg HOST_GID=$(id -g) .`
Expected: Build succeeds

- [ ] **Step 3: Verify tools are available**

Run: `docker run --rm ccd-sandbox:latest bash -c "python3 --version && pip3 --version && ffmpeg -version | head -1 && gh --version | head -1 && sudo echo sudo-works"`
Expected: All commands succeed

- [ ] **Step 4: Commit**

```bash
git add Dockerfile.sandbox
git commit -m "feat(sandbox): add sudo, python3, ffmpeg, gh to base image"
```

---

### Task 7: Integration Test — End-to-End Flow

- [ ] **Step 1: Write integration test**

```typescript
// tests/sandbox-bake-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseInstallCommand, recordInstall, readPendingPackages, clearPendingPackages } from "../src/install-recorder.js";
import { generateDockerfilePatch } from "../src/container-manager.js";

describe("sandbox bake integration", () => {
  const recordPath = join(tmpdir(), "test-installed-packages.txt");

  beforeEach(() => { try { unlinkSync(recordPath); } catch {} });
  afterEach(() => { try { unlinkSync(recordPath); } catch {} });

  it("full flow: detect → record → read → generate patch", () => {
    // Simulate Claude running install commands
    const cmds = [
      "pip3 install --break-system-packages pymupdf",
      "sudo apt-get install -y ffmpeg",
      "cargo install ripgrep",
      "ls -la",  // not an install
    ];

    for (const cmd of cmds) {
      const install = parseInstallCommand(cmd);
      if (install) recordInstall(recordPath, install);
    }

    const pending = readPendingPackages(recordPath);
    expect(pending.count).toBe(3);
    expect(pending.pip).toEqual(["pymupdf"]);
    expect(pending.apt).toEqual(["ffmpeg"]);
    expect(pending.cargo).toEqual(["ripgrep"]);

    const patch = generateDockerfilePatch(pending);
    expect(patch).toContain("apt-get install");
    expect(patch).toContain("ffmpeg");
    expect(patch).toContain("pip3 install");
    expect(patch).toContain("pymupdf");
    expect(patch).toContain("cargo install");
    expect(patch).toContain("ripgrep");

    clearPendingPackages(recordPath);
    expect(readPendingPackages(recordPath).count).toBe(0);
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add tests/sandbox-bake-integration.test.ts
git commit -m "test(sandbox): add integration test for bake flow"
```
