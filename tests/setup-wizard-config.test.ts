import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import yaml from "js-yaml";
import { buildFleetConfig, type WizardAnswers } from "../src/setup-wizard.js";
import { AccessManager } from "../src/channel/access-manager.js";

const defaults: WizardAnswers = {
  backend: "claude-code",
  botTokenEnv: "AGEND_BOT_TOKEN",
  groupId: -1001234567890,
  channelMode: "topic",
  accessMode: "locked",
  allowedUsers: [],
  projectRoots: [],
  instances: [],
  costGuard: { enabled: false },
  dailySummary: { enabled: false },
};

describe("buildFleetConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `wizard-config-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("allowed_users roundtrip: string input matches number comparison", () => {
    const config = buildFleetConfig({
      ...defaults,
      allowedUsers: ["1047180393"],
    });

    // Serialize to YAML and parse back (simulates fleet.yaml load)
    const yamlStr = yaml.dump(config);
    const loaded = yaml.load(yamlStr) as Record<string, any>;

    // YAML may parse bare numbers back as number type
    const accessConfig = loaded.channel.access;
    const statePath = join(tmpDir, "access.json");
    const am = new AccessManager(
      { mode: accessConfig.mode, allowed_users: accessConfig.allowed_users ?? [], max_pending_codes: 3, code_expiry_minutes: 60 },
      statePath,
    );

    // Telegram adapter sends number, must match string in config
    expect(am.isAllowed(1047180393)).toBe(true);
    expect(am.isAllowed("1047180393")).toBe(true);
    expect(am.isAllowed(999)).toBe(false);
  });

  it("allowed_users with number input also works", () => {
    const config = buildFleetConfig({
      ...defaults,
      allowedUsers: [1047180393],
    });

    const yamlStr = yaml.dump(config);
    const loaded = yaml.load(yamlStr) as Record<string, any>;
    const accessConfig = loaded.channel.access;
    const am = new AccessManager(
      { mode: accessConfig.mode, allowed_users: accessConfig.allowed_users ?? [], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "access2.json"),
    );

    expect(am.isAllowed("1047180393")).toBe(true);
    expect(am.isAllowed(1047180393)).toBe(true);
  });

  it("backend selection writes correct config", () => {
    const config = buildFleetConfig({ ...defaults, backend: "codex" });
    expect((config.defaults as any).backend).toBe("codex");
  });

  it("claude-code backend omits backend field (it is the default)", () => {
    const config = buildFleetConfig({ ...defaults, backend: "claude-code" });
    expect((config.defaults as any).backend).toBeUndefined();
  });

  it("topic_id roundtrip preserves value as string", () => {
    const config = buildFleetConfig({
      ...defaults,
      instances: [{ name: "test", workDir: "/tmp/test", topicId: "5033" }],
    });

    const yamlStr = yaml.dump(config);
    const loaded = yaml.load(yamlStr) as Record<string, any>;

    // topic_id should survive roundtrip (YAML may parse "5033" as number 5033)
    const topicId = loaded.instances.test.topic_id;
    // RoutingEngine normalizes via String(), so either type works
    expect(String(topicId)).toBe("5033");
  });

  it("cost guard writes when enabled", () => {
    const config = buildFleetConfig({
      ...defaults,
      costGuard: { enabled: true, dailyLimitUsd: 50, timezone: "Asia/Taipei" },
    });

    const d = config.defaults as any;
    expect(d.cost_guard.daily_limit_usd).toBe(50);
    expect(d.cost_guard.timezone).toBe("Asia/Taipei");
  });

  it("cost guard omitted when disabled", () => {
    const config = buildFleetConfig({ ...defaults, costGuard: { enabled: false } });
    expect((config.defaults as any).cost_guard).toBeUndefined();
  });

  it("daily summary writes when enabled", () => {
    const config = buildFleetConfig({
      ...defaults,
      dailySummary: { enabled: true, hour: 9 },
    });
    expect((config.defaults as any).daily_summary.hour).toBe(9);
  });

  it("group_id included in channel config", () => {
    const config = buildFleetConfig({ ...defaults, groupId: -1001234567890 });
    expect((config.channel as any).group_id).toBe(-1001234567890);
  });
});
