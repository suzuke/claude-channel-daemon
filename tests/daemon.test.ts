import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Daemon } from "../src/daemon.js";
import type { InstanceConfig } from "../src/types.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const makeConfig = (): InstanceConfig => ({
  working_directory: "/tmp/test",
  restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
  context_guardian: { restart_threshold_pct: 80, max_age_hours: 4, grace_period_ms: 600_000 },
  memory: { auto_summarize: false, watch_memory_dir: false, backup_to_sqlite: false },
  log_level: "info",
});

describe("Daemon", () => {
  it("constructs with valid config", () => {
    const backend = new ClaudeCodeBackend("/tmp/ccd-test-instance");
    const daemon = new Daemon("test", makeConfig(), "/tmp/ccd-test-instance", false, backend);
    expect(daemon).toBeDefined();
  });

  it("constructs with topic mode flag", () => {
    const backend = new ClaudeCodeBackend("/tmp/ccd-test-instance");
    const daemon = new Daemon("test", makeConfig(), "/tmp/ccd-test-instance", true, backend);
    expect(daemon).toBeDefined();
  });
});

describe("Daemon snapshot", () => {
  let tmpDir: string;
  let daemon: Daemon;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-daemon-snap-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const backend = new ClaudeCodeBackend(tmpDir);
    daemon = new Daemon("test-snap", makeConfig(), tmpDir, false, backend);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writeRotationSnapshot creates rotation-state.json", () => {
    const snapshot = daemon.writeRotationSnapshot("context_full");
    const filePath = join(tmpDir, "rotation-state.json");
    expect(existsSync(filePath)).toBe(true);
    const written = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(written.instance).toBe("test-snap");
    expect(written.reason).toBe("context_full");
    expect(snapshot.instance).toBe("test-snap");
  });

  it("snapshot file persists after prompt read (no longer deleted)", () => {
    // Write a snapshot file
    const snapshotData = {
      instance: "test-snap",
      reason: "max_age",
      created_at: new Date().toISOString(),
      working_directory: "/tmp/test",
      context_pct: 75,
      recent_user_messages: [{ text: "hello", ts: new Date().toISOString() }],
    };
    const filePath = join(tmpDir, "rotation-state.json");
    writeFileSync(filePath, JSON.stringify(snapshotData));
    expect(existsSync(filePath)).toBe(true);

    const result = (daemon as any).buildSnapshotPrompt();
    expect(result).toContain("Previous Session Snapshot");
    expect(result).toContain("max_age");
    expect(result).toContain("hello");

    // File stays on disk for daemon restart recovery
    expect(existsSync(filePath)).toBe(true);
    // In-memory flag prevents re-injection
    expect((daemon as any).snapshotConsumed).toBe(true);
  });

  it("buildSnapshotPrompt returns null when no snapshot exists", () => {
    const result = (daemon as any).buildSnapshotPrompt();
    expect(result).toBeNull();
  });

  it("snapshotConsumed flag resets when new snapshot is written", () => {
    daemon.writeRotationSnapshot("context_full");
    const first = (daemon as any).buildSnapshotPrompt();
    expect(first).not.toBeNull();
    expect((daemon as any).snapshotConsumed).toBe(true);
    // Writing a new snapshot resets the flag
    daemon.writeRotationSnapshot("crash");
    expect((daemon as any).snapshotConsumed).toBe(false);
    const second = (daemon as any).buildSnapshotPrompt();
    expect(second).not.toBeNull();
  });
});
