import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  it("filterDirectories: exact match wins over substring", () => {
    const dirs = ["/p/myapp", "/p/myapp-v2", "/p/other"];
    const tc = new TopicCommands({} as any);

    // Access private method via cast
    const exact = (tc as any).filterDirectories(dirs, "myapp");
    expect(exact).toEqual({ type: "exact", path: "/p/myapp" });

    const sub = (tc as any).filterDirectories(dirs, "app");
    expect(sub).toEqual({ type: "multiple", paths: ["/p/myapp", "/p/myapp-v2"] });

    const none = (tc as any).filterDirectories(dirs, "zzz");
    expect(none).toEqual({ type: "none" });
  });

  it("validateProjectName rejects invalid names", () => {
    const tc = new TopicCommands({} as any);
    const validate = (name: string) => (tc as any).validateProjectName(name);
    expect(validate("my-project")).toBe(true);
    expect(validate("")).toBe(false);
    expect(validate("   ")).toBe(false);
    expect(validate("foo/bar")).toBe(false);
    expect(validate("..")).toBe(false);
    expect(validate("-flag")).toBe(false);
    expect(validate("ok-project")).toBe(true);
    expect(validate("中文專案")).toBe(true);
  });

  it("listUnboundDirectories excludes already-bound dirs", () => {
    const tmpDir = join(tmpdir(), `ccd-topic-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    const projectRoot = join(tmpDir, "projects");
    mkdirSync(join(projectRoot, "proj-a"), { recursive: true });
    mkdirSync(join(projectRoot, "proj-b"), { recursive: true });
    mkdirSync(join(projectRoot, "proj-c"), { recursive: true });

    const fm = new FleetManager(tmpDir);
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
project_roots:
  - ${projectRoot}
instances:
  proj-a-t42:
    working_directory: ${join(projectRoot, "proj-a")}
    topic_id: 42
`);
    fm.loadConfig(configPath);

    const tc = new TopicCommands(fm);
    // listUnboundDirectories is private, but we can test via getProjectRoots indirectly
    const unbound = (tc as any).listUnboundDirectories();
    const names = unbound.map((d: string) => basename(d));
    expect(names).toContain("proj-b");
    expect(names).toContain("proj-c");
    expect(names).not.toContain("proj-a");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
