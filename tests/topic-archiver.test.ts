import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TopicArchiver, type ArchiverContext } from "../src/topic-archiver.js";

function makeCtx(overrides: Partial<ArchiverContext> = {}): ArchiverContext {
  const noop = () => {};
  return {
    fleetConfig: {
      channel: { group_id: 1 },
      instances: {
        dev: { topic_id: 42, general_topic: false, working_directory: "/", topic_name: "dev" } as never,
      },
      teams: {},
    } as never,
    adapter: {
      closeForumTopic: async () => {},
      reopenForumTopic: async () => {},
    } as never,
    logger: { info: noop, debug: noop, error: noop, warn: noop } as never,
    getInstanceStatus: () => "running",
    lastActivityMs: () => Date.now() - 25 * 60 * 60 * 1000, // 25h idle
    setTopicIcon: noop,
    touchActivity: noop,
    ...overrides,
  };
}

describe("TopicArchiver persistence (P2.6)", () => {
  let dir: string;
  let persistPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "archiver-"));
    persistPath = join(dir, "archived-topics.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes archived set to disk and reloads on restart", async () => {
    const a = new TopicArchiver(makeCtx(), persistPath);
    await a.archiveIdle();
    expect(a.isArchived("42")).toBe(true);
    expect(existsSync(persistPath)).toBe(true);
    expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toEqual(["42"]);

    // Simulate restart: fresh TopicArchiver reads the persisted set.
    const b = new TopicArchiver(makeCtx(), persistPath);
    expect(b.isArchived("42")).toBe(true);
  });

  it("removes from persisted state on reopen", async () => {
    const a = new TopicArchiver(makeCtx(), persistPath);
    await a.archiveIdle();
    await a.reopen("42", "dev");
    expect(a.isArchived("42")).toBe(false);
    expect(JSON.parse(readFileSync(persistPath, "utf-8"))).toEqual([]);
  });

  it("tolerates corrupt persistence file", () => {
    require("node:fs").writeFileSync(persistPath, "{not valid json");
    const a = new TopicArchiver(makeCtx(), persistPath);
    expect(a.isArchived("42")).toBe(false); // starts empty, not crashed
  });
});
