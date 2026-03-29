import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadFleetConfig } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadFleetConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-fleet-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads fleet.yaml with defaults merged into instances", () => {
    const fleetPath = join(tmpDir, "fleet.yaml");
    writeFileSync(
      fleetPath,
      `channel:
  type: telegram
  mode: dm
  bot_token_env: BOT_TOKEN
  access:
    mode: pairing
    allowed_users: []
    max_pending_codes: 5
    code_expiry_minutes: 10
defaults:
  restart_policy:
    max_retries: 3
    backoff: linear
    reset_after: 60
  log_level: debug
instances:
  mybot:
    working_directory: /home/user/mybot
    topic_id: 42
    context_guardian:
      threshold_percentage: 90
      max_idle_wait_ms: 300000
      completion_timeout_ms: 60000
      grace_period_ms: 600000
      max_age_hours: 2
`
    );
    const fleet = loadFleetConfig(fleetPath);

    // restart_policy from defaults should be merged in
    expect(fleet.instances.mybot.restart_policy.max_retries).toBe(3);
    expect(fleet.instances.mybot.restart_policy.backoff).toBe("linear");

    // context_guardian from instance overrides defaults
    expect(fleet.instances.mybot.context_guardian.threshold_percentage).toBe(90);
    expect(fleet.instances.mybot.context_guardian.max_idle_wait_ms).toBe(300000);

    // topic_id preserved
    expect(fleet.instances.mybot.topic_id).toBe(42);

    // top-level channel present
    expect(fleet.channel).toBeDefined();
    expect(fleet.channel!.type).toBe("telegram");
    expect(fleet.channel!.mode).toBe("dm");
  });

  it("validates required fields", () => {
    const fleetPath = join(tmpDir, "fleet.yaml");
    writeFileSync(
      fleetPath,
      `defaults: {}
instances:
  badbot:
    log_level: info
`
    );
    expect(() => loadFleetConfig(fleetPath)).toThrow(/working_directory/);
  });

  it("returns empty instances when no fleet.yaml exists", () => {
    const fleet = loadFleetConfig(join(tmpDir, "nonexistent-fleet.yaml"));
    expect(fleet.instances).toEqual({});
    expect(fleet.defaults).toEqual({});
  });
});

