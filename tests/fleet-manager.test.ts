import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { join, basename } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("FleetManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-fleet-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects stopped instance (no PID)", () => {
    const fm = new FleetManager(tmpDir);
    mkdirSync(join(tmpDir, "instances/test"), { recursive: true });
    expect(fm.getInstanceStatus("test")).toBe("stopped");
  });

  it("detects crashed instance (stale PID)", () => {
    const fm = new FleetManager(tmpDir);
    const dir = join(tmpDir, "instances/test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "daemon.pid"), "99999999");
    expect(fm.getInstanceStatus("test")).toBe("crashed");
  });

  it("builds routing table from config", () => {
    const fm = new FleetManager(tmpDir);
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
channel:
  type: telegram
  mode: topic
  bot_token_env: BOT
  group_id: -100
  access:
    mode: locked
    allowed_users: [1]
instances:
  proj-a:
    working_directory: /tmp/a
    topic_id: 42
  proj-b:
    working_directory: /tmp/b
    topic_id: 87
  proj-c:
    working_directory: /tmp/c
`);
    fm.loadConfig(configPath);
    const table = fm.buildRoutingTable();
    expect(table.get(42)).toEqual({ kind: "instance", name: "proj-a" });
    expect(table.get(87)).toEqual({ kind: "instance", name: "proj-b" });
    expect(table.size).toBe(2); // proj-c has no topic_id
  });

  it("createForumTopic delegates to adapter.createTopic", async () => {
    const fm = new FleetManager(tmpDir);

    // No adapter set — should throw
    await expect(fm.createForumTopic("my-topic")).rejects.toThrow("Adapter does not support topic creation");

    // Set a mock adapter with createTopic
    fm.adapter = {
      createTopic: async (name: string) => {
        expect(name).toBe("my-topic");
        return 999;
      },
    } as any;

    const threadId = await fm.createForumTopic("my-topic");
    expect(threadId).toBe(999);
  });
});

describe("TopicCommands", () => {
  it("handleGeneralCommand returns false for non-commands", async () => {
    const adapter = { sendText: vi.fn() };
    const tc = new TopicCommands({ adapter } as any);
    const result = await tc.handleGeneralCommand({ text: "hello", chatId: "1", messageId: "1", username: "u", userId: "1", timestamp: new Date() } as any);
    expect(result).toBe(false);
  });
});
