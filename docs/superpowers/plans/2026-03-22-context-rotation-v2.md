# Context Rotation v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current compact-or-kill rotation with a single-threshold (60%) handover-then-rotate system that uses Claude's own memory for seamless session continuity.

**Architecture:** Context guardian monitors statusline.json. At 60%, it waits for idle (tmux prompt detection), sends a handover prompt via tmux sendKeys, waits for completion (file change event / idle / timeout), then kills and respawns Claude. A grace period prevents rotation loops.

**Tech Stack:** TypeScript, vitest, chokidar (existing), tmux, Node.js EventEmitter

**Spec:** `docs/context-rotation-design.md`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `src/context-guardian.ts` | State machine: NORMAL → PENDING → HANDING_OVER → ROTATING → GRACE | Rewrite |
| `src/types.ts` | `GuardianConfig` type with new fields | Modify |
| `src/config.ts` | Default config values | Modify |
| `src/daemon.ts` | Wire up idle detection + handover in rotate handler | Modify |
| `src/memory-layer.ts` | Emit `file_changed` event on backup | Modify (add EventEmitter) |
| `tests/context-guardian.test.ts` | Full test coverage for new state machine | Rewrite |
| `tests/memory-layer.test.ts` | Test new event emission | Modify |

---

### Task 1: Update types and config defaults

**Files:**
- Modify: `src/types.ts:1-21` (DaemonConfig.context_guardian)
- Modify: `src/config.ts:13-16` (DEFAULT_CONFIG.context_guardian)

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```typescript
it("has correct default context_guardian values", () => {
  const config = loadConfig("/nonexistent/path.yaml");
  expect(config.context_guardian).toEqual({
    threshold_percentage: 60,
    max_idle_wait_ms: 300_000,
    completion_timeout_ms: 60_000,
    grace_period_ms: 600_000,
    max_age_hours: 8,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts --reporter=verbose`
Expected: FAIL — current defaults have `threshold_percentage: 40`, `max_age_hours: 4`, and missing fields.

- [ ] **Step 3: Update types**

In `src/types.ts`, replace the `context_guardian` block:

```typescript
context_guardian: {
  threshold_percentage: number;
  max_idle_wait_ms: number;
  completion_timeout_ms: number;
  grace_period_ms: number;
  max_age_hours: number;
};
```

Also update `InstanceConfig` line 79 — it references `DaemonConfig["context_guardian"]` so it inherits automatically.

- [ ] **Step 4: Update default config**

In `src/config.ts`, replace `context_guardian` in `DEFAULT_CONFIG`:

```typescript
context_guardian: {
  threshold_percentage: 60,
  max_idle_wait_ms: 300_000,
  completion_timeout_ms: 60_000,
  grace_period_ms: 600_000,
  max_age_hours: 8,
},
```

Remove the `strategy` field — no longer needed.

- [ ] **Step 5: Fix any TypeScript compile errors**

Run: `npx tsc --noEmit`

The old `strategy` field is removed. If any code references `config.context_guardian.strategy`, remove those references. Check `context-guardian.ts` and `daemon.ts`.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "refactor: update context_guardian config to single-threshold model"
```

---

### Task 2: Add event emission to MemoryLayer

MemoryLayer currently backs up files silently. We need it to emit a `file_changed` event so the rotation flow can detect when `handover.md` is written.

**Files:**
- Modify: `src/memory-layer.ts`
- Modify: `tests/memory-layer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/memory-layer.test.ts`:

```typescript
it("emits file_changed event when a file is added", async () => {
  const changeSpy = vi.fn();
  memoryLayer.on("file_changed", changeSpy);
  await memoryLayer.start();

  const testFile = join(memDir, "test.md");
  writeFileSync(testFile, "hello");

  // chokidar needs time to detect + stabilityThreshold (200ms)
  await vi.waitFor(() => {
    expect(changeSpy).toHaveBeenCalledWith(testFile);
  }, { timeout: 3000 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/memory-layer.test.ts --reporter=verbose`
Expected: FAIL — `memoryLayer.on is not a function` or event never fires.

- [ ] **Step 3: Make MemoryLayer extend EventEmitter**

```typescript
import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "chokidar";
import { readFileSync } from "node:fs";
import type { MemoryDb } from "./db.js";
import type { Logger } from "./logger.js";

export class MemoryLayer extends EventEmitter {
  private watcher: FSWatcher | null = null;

  constructor(
    private memoryDir: string,
    private db: MemoryDb,
    private logger: Logger,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.logger.info({ dir: this.memoryDir }, "Watching memory directory");

    this.watcher = watch(this.memoryDir, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 200 },
    });

    this.watcher.on("add", (path) => this.backupFile(path));
    this.watcher.on("change", (path) => this.backupFile(path));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.db.close();
  }

  private backupFile(filePath: string): void {
    try {
      const content = readFileSync(filePath, "utf-8");
      this.db.insertBackup(filePath, content, null);
      this.logger.info({ filePath }, "Memory file backed up");
      this.emit("file_changed", filePath);
    } catch (err) {
      this.logger.error({ err, filePath }, "Failed to backup memory file");
    }
  }
}
```

Changes: `extends EventEmitter`, `super()` call, `this.emit("file_changed", filePath)` after backup.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/memory-layer.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory-layer.ts tests/memory-layer.test.ts
git commit -m "feat: emit file_changed event from MemoryLayer"
```

---

### Task 3: Rewrite ContextGuardian state machine

Replace the current simple threshold check with a 5-state machine: NORMAL → PENDING → HANDING_OVER → ROTATING → GRACE.

**Files:**
- Rewrite: `src/context-guardian.ts`
- Rewrite: `tests/context-guardian.test.ts`

- [ ] **Step 1: Write the failing tests**

Rewrite `tests/context-guardian.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContextGuardian } from "../src/context-guardian.js";
import { createLogger } from "../src/logger.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const makeConfig = (overrides = {}) => ({
  threshold_percentage: 60,
  max_idle_wait_ms: 300_000,
  completion_timeout_ms: 60_000,
  grace_period_ms: 600_000,
  max_age_hours: 8,
  ...overrides,
});

describe("ContextGuardian v2", () => {
  const logger = createLogger("silent");
  let guardian: ContextGuardian;
  let tmpDir: string;
  let statusFile: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = join(tmpdir(), `ccd-guardian-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    statusFile = join(tmpDir, "statusline.json");
    guardian = new ContextGuardian(makeConfig(), logger, statusFile);
  });

  afterEach(() => {
    guardian.stop();
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts in NORMAL state", () => {
    expect(guardian.state).toBe("NORMAL");
  });

  it("transitions to PENDING when threshold exceeded", () => {
    const pendingSpy = vi.fn();
    guardian.on("pending", pendingSpy);

    guardian.updateContextStatus({
      used_percentage: 65,
      remaining_percentage: 35,
      context_window_size: 1_000_000,
    });

    expect(guardian.state).toBe("PENDING");
    expect(pendingSpy).toHaveBeenCalledTimes(1);
  });

  it("stays NORMAL below threshold", () => {
    guardian.updateContextStatus({
      used_percentage: 55,
      remaining_percentage: 45,
      context_window_size: 1_000_000,
    });

    expect(guardian.state).toBe("NORMAL");
  });

  it("transitions PENDING → HANDING_OVER on idle signal", () => {
    const handoverSpy = vi.fn();
    guardian.on("request_handover", handoverSpy);

    // Trigger PENDING
    guardian.updateContextStatus({
      used_percentage: 65,
      remaining_percentage: 35,
      context_window_size: 1_000_000,
    });
    expect(guardian.state).toBe("PENDING");

    // Signal idle
    guardian.signalIdle();
    expect(guardian.state).toBe("HANDING_OVER");
    expect(handoverSpy).toHaveBeenCalledTimes(1);
  });

  it("ignores idle signal when not PENDING", () => {
    guardian.signalIdle();
    expect(guardian.state).toBe("NORMAL");
  });

  it("transitions HANDING_OVER → ROTATING on handover complete", () => {
    const rotateSpy = vi.fn();
    guardian.on("rotate", rotateSpy);

    guardian.updateContextStatus({
      used_percentage: 65,
      remaining_percentage: 35,
      context_window_size: 1_000_000,
    });
    guardian.signalIdle();
    guardian.signalHandoverComplete();

    expect(guardian.state).toBe("ROTATING");
    expect(rotateSpy).toHaveBeenCalledTimes(1);
  });

  it("transitions HANDING_OVER → ROTATING on completion timeout", () => {
    const rotateSpy = vi.fn();
    guardian.on("rotate", rotateSpy);

    guardian.updateContextStatus({
      used_percentage: 65,
      remaining_percentage: 35,
      context_window_size: 1_000_000,
    });
    guardian.signalIdle();
    expect(guardian.state).toBe("HANDING_OVER");

    // Advance past completion_timeout_ms
    vi.advanceTimersByTime(60_001);

    expect(guardian.state).toBe("ROTATING");
    expect(rotateSpy).toHaveBeenCalledTimes(1);
  });

  it("enters GRACE after markRotationComplete", () => {
    guardian.updateContextStatus({
      used_percentage: 65,
      remaining_percentage: 35,
      context_window_size: 1_000_000,
    });
    guardian.signalIdle();
    guardian.signalHandoverComplete();
    guardian.markRotationComplete();

    expect(guardian.state).toBe("GRACE");
  });

  it("ignores threshold during GRACE period", () => {
    // Go through full cycle
    guardian.updateContextStatus({
      used_percentage: 65,
      remaining_percentage: 35,
      context_window_size: 1_000_000,
    });
    guardian.signalIdle();
    guardian.signalHandoverComplete();
    guardian.markRotationComplete();
    expect(guardian.state).toBe("GRACE");

    // Try to trigger again during grace
    guardian.updateContextStatus({
      used_percentage: 70,
      remaining_percentage: 30,
      context_window_size: 1_000_000,
    });
    expect(guardian.state).toBe("GRACE");
  });

  it("returns to NORMAL after grace period expires", () => {
    guardian.updateContextStatus({
      used_percentage: 65,
      remaining_percentage: 35,
      context_window_size: 1_000_000,
    });
    guardian.signalIdle();
    guardian.signalHandoverComplete();
    guardian.markRotationComplete();

    vi.advanceTimersByTime(600_001);
    expect(guardian.state).toBe("NORMAL");
  });

  it("falls back to NORMAL if idle not detected within max_idle_wait", () => {
    guardian.updateContextStatus({
      used_percentage: 65,
      remaining_percentage: 35,
      context_window_size: 1_000_000,
    });
    expect(guardian.state).toBe("PENDING");

    vi.advanceTimersByTime(300_001);
    expect(guardian.state).toBe("NORMAL");
  });

  it("triggers rotation on max_age_hours timer", () => {
    const pendingSpy = vi.fn();
    guardian.on("pending", pendingSpy);
    guardian.startTimer();

    vi.advanceTimersByTime(8 * 60 * 60 * 1000);

    expect(guardian.state).toBe("PENDING");
    expect(pendingSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/context-guardian.test.ts --reporter=verbose`
Expected: FAIL — current ContextGuardian has no `state` property, no `signalIdle()`, etc.

- [ ] **Step 3: Implement new ContextGuardian**

Rewrite `src/context-guardian.ts`:

```typescript
import { EventEmitter } from "node:events";
import { readFileSync, watchFile, unwatchFile, existsSync } from "node:fs";
import type { ContextStatus, StatusLineData, DaemonConfig } from "./types.js";
import type { Logger } from "./logger.js";

type GuardianConfig = DaemonConfig["context_guardian"];
type State = "NORMAL" | "PENDING" | "HANDING_OVER" | "ROTATING" | "GRACE";

export class ContextGuardian extends EventEmitter {
  state: State = "NORMAL";
  private ageTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private statusFilePath: string;

  constructor(
    private config: GuardianConfig,
    private logger: Logger,
    statusFilePath: string,
  ) {
    super();
    this.statusFilePath = statusFilePath;
  }

  startWatching(): void {
    this.logger.debug({ path: this.statusFilePath }, "Watching status line file");
    watchFile(this.statusFilePath, { interval: 2000 }, () => this.readAndCheck());
  }

  private readAndCheck(): void {
    try {
      if (!existsSync(this.statusFilePath)) return;
      const raw = readFileSync(this.statusFilePath, "utf-8");
      const data: StatusLineData = JSON.parse(raw);
      const cw = data.context_window;

      if (cw.used_percentage != null) {
        const status: ContextStatus = {
          used_percentage: cw.used_percentage,
          remaining_percentage: cw.remaining_percentage ?? (100 - cw.used_percentage),
          context_window_size: cw.context_window_size,
        };
        const rl = data.rate_limits;
        this.logger.debug({
          context: `${cw.used_percentage}%`,
          cost: `$${data.cost.total_cost_usd.toFixed(2)}`,
          rate_5h: rl?.five_hour ? `${rl.five_hour.used_percentage}%` : "n/a",
          rate_7d: rl?.seven_day ? `${rl.seven_day.used_percentage}%` : "n/a",
        }, "Status update received");
        this.emit("status_update", { ...status, rate_limits: rl });
        this.updateContextStatus(status);
      }
    } catch (err) {
      this.logger.debug({ err }, "Failed to read status line file");
    }
  }

  updateContextStatus(status: ContextStatus): void {
    if (this.state !== "NORMAL") return;

    if (status.used_percentage > this.config.threshold_percentage) {
      this.logger.info(
        { used: status.used_percentage, threshold: this.config.threshold_percentage },
        "Context threshold exceeded — waiting for idle",
      );
      this.enterPending();
    }
  }

  /** Called by daemon when tmux prompt is detected (Claude is idle). */
  signalIdle(): void {
    if (this.state !== "PENDING") return;
    this.enterHandingOver();
  }

  /** Called by daemon when handover.md is written or Claude returns to idle after handover. */
  signalHandoverComplete(): void {
    if (this.state !== "HANDING_OVER") return;
    this.clearTimer("completionTimer");
    this.enterRotating();
  }

  /** Called by daemon after kill + respawn is done. */
  markRotationComplete(): void {
    if (this.state !== "ROTATING") return;
    this.enterGrace();
  }

  startTimer(): void {
    if (this.ageTimer) return;
    const ms = this.config.max_age_hours * 60 * 60 * 1000;
    this.ageTimer = setTimeout(() => {
      this.logger.info("Max age reached — waiting for idle");
      if (this.state === "NORMAL") this.enterPending();
    }, ms);
  }

  private resetAgeTimer(): void {
    if (this.ageTimer) {
      clearTimeout(this.ageTimer);
      this.ageTimer = null;
    }
    this.startTimer();
  }

  stop(): void {
    this.clearTimer("ageTimer");
    this.clearTimer("idleTimer");
    this.clearTimer("completionTimer");
    this.clearTimer("graceTimer");
    unwatchFile(this.statusFilePath);
  }

  // --- State transitions ---

  private enterPending(): void {
    this.state = "PENDING";
    this.emit("pending");

    this.idleTimer = setTimeout(() => {
      this.logger.warn("Idle wait timeout — abandoning this rotation attempt");
      this.state = "NORMAL";
    }, this.config.max_idle_wait_ms);
  }

  private enterHandingOver(): void {
    this.clearTimer("idleTimer");
    this.state = "HANDING_OVER";
    this.emit("request_handover");

    this.completionTimer = setTimeout(() => {
      this.logger.warn("Handover completion timeout — proceeding to rotate");
      this.enterRotating();
    }, this.config.completion_timeout_ms);
  }

  private enterRotating(): void {
    this.state = "ROTATING";
    this.emit("rotate");
  }

  private enterGrace(): void {
    this.state = "GRACE";
    this.graceTimer = setTimeout(() => {
      this.state = "NORMAL";
      this.resetAgeTimer();
    }, this.config.grace_period_ms);
  }

  private clearTimer(name: "ageTimer" | "idleTimer" | "completionTimer" | "graceTimer"): void {
    if (this[name]) {
      clearTimeout(this[name]);
      this[name] = null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/context-guardian.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/context-guardian.ts tests/context-guardian.test.ts
git commit -m "feat: rewrite ContextGuardian as single-threshold state machine"
```

---

### Task 4: Wire up daemon rotate handler

Replace the current compact-or-kill rotate handler in `daemon.ts` with the new flow: listen for `pending` (start idle polling), `request_handover` (send prompt), watch for completion, then `rotate` (kill + respawn).

**Files:**
- Modify: `src/daemon.ts:195-259` (guardian setup + rotate handler)

- [ ] **Step 1: Add helper methods to Daemon**

Add two private methods:

```typescript
  private readContextPercentage(): number {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      const data = JSON.parse(readFileSync(sf, "utf-8"));
      return data.context_window?.used_percentage ?? 0;
    } catch {
      return 0;
    }
  }

  private async isClaudeIdle(): Promise<boolean> {
    try {
      const pane = await this.tmux?.capturePane();
      return !!pane && /^>\s*$/m.test(pane);
    } catch {
      return false;
    }
  }

  private waitForHandoverSignal(): void {
    const onFileChanged = (filePath: string) => {
      if (filePath.endsWith("handover.md")) {
        cleanup();
        this.guardian?.signalHandoverComplete();
      }
    };
    this.memoryLayer?.on("file_changed", onFileChanged);

    const idleCheck = setInterval(async () => {
      if (await this.isClaudeIdle()) {
        cleanup();
        this.guardian?.signalHandoverComplete();
      }
    }, 3000);

    const cleanup = () => {
      this.memoryLayer?.removeListener("file_changed", onFileChanged);
      clearInterval(idleCheck);
    };
  }
```

- [ ] **Step 2: Replace the rotate handler**

Replace `daemon.ts` lines 209-258 with:

```typescript
    let idleCheckInterval: ReturnType<typeof setInterval> | null = null;

    this.guardian.on("pending", () => {
      this.logger.info("Context rotation pending — watching for idle");
      idleCheckInterval = setInterval(async () => {
        if (await this.isClaudeIdle()) this.guardian?.signalIdle();
      }, 3000);
    });

    this.guardian.on("request_handover", async () => {
      if (idleCheckInterval) {
        clearInterval(idleCheckInterval);
        idleCheckInterval = null;
      }

      this.logger.info("Sending handover prompt to Claude");
      if (this.tmux) {
        const pct = this.readContextPercentage();
        const prompt = [
          `你的 context 已使用 ${pct}%，即將進行 rotation。請：`,
          `1. 簡短告知用戶你正在保存工作狀態`,
          `2. 將目前工作狀態寫入 memory/handover.md，包含：正在進行的任務、已完成的部分、下一步計劃、重要決策`,
        ].join("\n");
        await this.tmux.sendKeys(prompt);
        await this.tmux.sendSpecialKey("Enter");
      }

      this.waitForHandoverSignal();
    });

    this.guardian.on("rotate", async () => {
      this.logger.info("Context rotation — killing and respawning Claude");

      try {
        const data = JSON.parse(readFileSync(statusFile, "utf-8"));
        if (data.session_id) writeFileSync(sessionIdFile, data.session_id);
      } catch {}

      await this.tmux?.killWindow();
      this.transcriptMonitor?.resetOffset();
      await this.spawnClaudeWindow();
      this.autoConfirmDevChannels();
      this.guardian?.markRotationComplete();
      this.logger.info("Context rotation complete — fresh Claude session started");
    });
```

- [ ] **Step 3: Run TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts
git commit -m "feat: wire up idle-aware handover rotation in daemon"
```

---

### Task 5: Fix existing tests that reference old API

The old `ContextGuardian` API emitted `"rotate"` directly on threshold. Tests in `daemon.test.ts` may reference this. Update any broken tests.

**Files:**
- Modify: `tests/daemon.test.ts` (if it references old guardian API)
- Modify: any other test files that fail

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose`

- [ ] **Step 2: Fix any failing tests**

Common fixes:
- Old tests that expect `guardian.on("rotate", ...)` to fire on threshold → now fires `"pending"` first
- Old tests that construct `ContextGuardian` with `{ threshold_percentage, max_age_hours, strategy }` → remove `strategy`, add new fields
- Update any mocks of `config.context_guardian` to include new fields

- [ ] **Step 3: Run full test suite again**

Run: `npx vitest run --reporter=verbose`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add -u tests/
git commit -m "test: update tests for context rotation v2 API"
```

---

### Task 6: Integration smoke test

Manually verify the full flow works end-to-end.

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 2: Verify state machine transitions in isolation**

Create a quick script or use the test to verify:
- NORMAL → (60% status) → PENDING → (idle) → HANDING_OVER → (file event) → ROTATING → (markComplete) → GRACE → (timer) → NORMAL

- [ ] **Step 3: Check that all timer-based transitions have proper cleanup**

Verify in `context-guardian.ts`:
- `stop()` clears all 4 timers
- State transitions clear their predecessor's timers
- No timer leaks

- [ ] **Step 4: Commit any fixes**

```bash
git add -u
git commit -m "fix: integration fixes for context rotation v2"
```
