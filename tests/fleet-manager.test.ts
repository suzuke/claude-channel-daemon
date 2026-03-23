import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { join } from "node:path";
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

  it("allocates ports automatically", () => {
    const fm = new FleetManager(tmpDir);
    const ports = fm.allocatePorts({
      "a": {},
      "b": {},
      "c": { approval_port: 19000 },
    } as any);
    expect(ports.a).toBe(18400);
    expect(ports.b).toBe(18401);
    expect(ports.c).toBe(19000);
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
    expect(table.get(42)).toBe("proj-a");
    expect(table.get(87)).toBe("proj-b");
    expect(table.size).toBe(2); // proj-c has no topic_id
  });
});
