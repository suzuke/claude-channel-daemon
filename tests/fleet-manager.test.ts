import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
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

  it("bindAndStart exists as a method on FleetManager", () => {
    const fm = new FleetManager(tmpDir);
    expect(typeof (fm as any).bindAndStart).toBe("function");
  });

  it("listUnboundDirectories excludes already-bound dirs", () => {
    const fm = new FleetManager(tmpDir);
    const configPath = join(tmpDir, "fleet.yaml");

    // Create some project dirs
    const projectRoot = join(tmpDir, "projects");
    mkdirSync(join(projectRoot, "proj-a"), { recursive: true });
    mkdirSync(join(projectRoot, "proj-b"), { recursive: true });
    mkdirSync(join(projectRoot, "proj-c"), { recursive: true });

    writeFileSync(configPath, `
project_roots:
  - ${projectRoot}
instances:
  proj-a-t42:
    working_directory: ${join(projectRoot, "proj-a")}
    topic_id: 42
`);
    fm.loadConfig(configPath);
    fm.buildRoutingTable();

    const unbound = (fm as any).listUnboundDirectories();
    const names = unbound.map((d: string) => basename(d));
    expect(names).toContain("proj-b");
    expect(names).toContain("proj-c");
    expect(names).not.toContain("proj-a");
  });

  it("filterDirectories: exact match wins over substring", () => {
    const dirs = ["/p/myapp", "/p/myapp-v2", "/p/other"];
    const fm = new FleetManager(tmpDir);

    // Exact match
    const exact = (fm as any).filterDirectories(dirs, "myapp");
    expect(exact).toEqual({ type: "exact", path: "/p/myapp" });

    // Substring only
    const sub = (fm as any).filterDirectories(dirs, "app");
    expect(sub).toEqual({ type: "multiple", paths: ["/p/myapp", "/p/myapp-v2"] });

    // No match
    const none = (fm as any).filterDirectories(dirs, "zzz");
    expect(none).toEqual({ type: "none" });
  });

  it("validateProjectName rejects invalid names", () => {
    const fm = new FleetManager(tmpDir);
    const validate = (name: string) => (fm as any).validateProjectName(name);
    expect(validate("my-project")).toBe(true);
    expect(validate("")).toBe(false);
    expect(validate("   ")).toBe(false);
    expect(validate("foo/bar")).toBe(false);
    expect(validate("..")).toBe(false);
    expect(validate("-flag")).toBe(false);
    expect(validate("ok-project")).toBe(true);
    expect(validate("中文專案")).toBe(true);
  });

  it("createForumTopic calls Telegram API and returns message_thread_id", async () => {
    const fm = new FleetManager(tmpDir);
    const configPath = join(tmpDir, "fleet.yaml");
    writeFileSync(configPath, `
channel:
  type: telegram
  mode: topic
  bot_token_env: TEST_BOT_TOKEN
  group_id: -100123
instances: {}
`);
    fm.loadConfig(configPath);

    // Stub global fetch
    const originalFetch = global.fetch;
    global.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      return {
        json: async () => ({ ok: true, result: { message_thread_id: 999 } }),
      } as Response;
    };

    process.env.TEST_BOT_TOKEN = "test-token-abc";

    try {
      // Access private method via cast
      const threadId = await (fm as any).createForumTopic("my-topic");
      expect(threadId).toBe(999);
    } finally {
      global.fetch = originalFetch;
      delete process.env.TEST_BOT_TOKEN;
    }
  });
});
