import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TopicArchiver, type ArchiverContext } from "../src/topic-archiver.js";
import type { FleetConfig } from "../src/types.js";

function silentLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() };
}

function makeCtx(overrides: Partial<ArchiverContext> = {}): ArchiverContext {
  return {
    fleetConfig: null,
    adapter: null,
    logger: silentLogger() as unknown as ArchiverContext["logger"],
    dataDir: "",
    getInstanceStatus: () => "running",
    lastActivityMs: () => 0,
    setTopicIcon: () => {},
    touchActivity: () => {},
    ...overrides,
  };
}

describe("TopicArchiver persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `archiver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists archived topics across restart", async () => {
    const closeForumTopic = vi.fn().mockResolvedValue(undefined);
    const fleetConfig = {
      instances: {
        worker: { topic_id: 42, general_topic: false },
      },
    } as unknown as FleetConfig;

    // First run: archive an idle topic
    const ctx1 = makeCtx({
      dataDir: tmpDir,
      fleetConfig,
      adapter: { closeForumTopic } as unknown as ArchiverContext["adapter"],
      lastActivityMs: () => Date.now() - (TopicArchiver.IDLE_MS + 1000),
    });
    const archiver1 = new TopicArchiver(ctx1);
    await archiver1.archiveIdle();
    expect(archiver1.isArchived("42")).toBe(true);
    expect(closeForumTopic).toHaveBeenCalledTimes(1);

    // State file should exist on disk
    const statePath = join(tmpDir, "archived-topics.json");
    expect(existsSync(statePath)).toBe(true);
    expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual(["42"]);

    // Second run: fresh instance loads state, does NOT re-archive
    const ctx2 = makeCtx({
      dataDir: tmpDir,
      fleetConfig,
      adapter: { closeForumTopic } as unknown as ArchiverContext["adapter"],
      lastActivityMs: () => Date.now() - (TopicArchiver.IDLE_MS + 1000),
    });
    const archiver2 = new TopicArchiver(ctx2);
    expect(archiver2.isArchived("42")).toBe(true); // remembered
    await archiver2.archiveIdle();
    expect(closeForumTopic).toHaveBeenCalledTimes(1); // not called again
  });

  it("removes id from state on reopen", async () => {
    const reopenForumTopic = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      dataDir: tmpDir,
      adapter: { reopenForumTopic } as unknown as ArchiverContext["adapter"],
    });
    const archiver = new TopicArchiver(ctx);
    // Seed state directly via archiveIdle path
    (archiver as unknown as { archived: Set<string> }).archived.add("99");
    (archiver as unknown as { save: () => void }).save();

    await archiver.reopen("99", "worker");
    expect(archiver.isArchived("99")).toBe(false);

    // Re-load fresh instance — should NOT have 99
    const archiver2 = new TopicArchiver(ctx);
    expect(archiver2.isArchived("99")).toBe(false);
  });

  it("tolerates missing state file on first start", () => {
    const ctx = makeCtx({ dataDir: tmpDir });
    expect(() => new TopicArchiver(ctx)).not.toThrow();
  });

  it("tolerates corrupted state file", () => {
    const statePath = join(tmpDir, "archived-topics.json");
    writeFileSync(statePath, "not valid json{{");
    const ctx = makeCtx({ dataDir: tmpDir });
    const archiver = new TopicArchiver(ctx);
    expect(archiver.isArchived("anything")).toBe(false);
  });
});
