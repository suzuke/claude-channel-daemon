/**
 * E2E Test: Context Rotation via max_age
 *
 * T12: ContextGuardian max_age timer fires → daemon writes snapshot →
 *      kills tmux window → respawns with new session → instance recovers.
 *
 * Uses a very short max_age_hours (0.005 ≈ 18s) to trigger rotation quickly.
 * Threshold-based rotation is disabled in production (Claude Code auto-compacts),
 * so only max_age rotation is tested.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import yaml from "js-yaml";
import {
  createTelegramMock,
  type TelegramMock,
} from "../mock-servers/telegram-mock.js";
import { waitFor, sleep, getFreePort } from "../mock-servers/shared.js";
import { TmuxManager } from "../../src/tmux-manager.js";
import { FleetManager } from "../../src/fleet-manager.js";

const TEST_GROUP_ID = -1001234567890;
const TEST_USER_ID = 111222333;
const TMUX_SESSION = `agend-rotation-${process.pid}`;

let telegramMock: TelegramMock;
let telegramMockPort: number;
let testDir: string;
let fm: FleetManager | null = null;
let healthPort: number;

describe("Context Rotation E2E", () => {
  beforeAll(async () => {
    process.env.AGEND_TMUX_SESSION = TMUX_SESSION;
    [healthPort, telegramMockPort] = await Promise.all([
      getFreePort(),
      getFreePort(),
    ]);

    telegramMock = createTelegramMock({ port: telegramMockPort });
    await telegramMock.start();

    testDir = `/tmp/ae2e-rot-${Date.now().toString(36)}`;
    process.env.AGEND_HOME = testDir;
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "instances"), { recursive: true });
    mkdirSync(join(testDir, "access"), { recursive: true });
    mkdirSync(join(testDir, "work", "rotator"), { recursive: true });
    mkdirSync(join(testDir, "work", "general"), { recursive: true });

    writeFileSync(
      join(testDir, ".env"),
      `AGEND_BOT_TOKEN=123456:FAKE_TOKEN\n`,
    );

    const fleetConfig = {
      channel: {
        type: "telegram",
        mode: "topic",
        bot_token_env: "AGEND_BOT_TOKEN",
        group_id: TEST_GROUP_ID,
        telegram_api_root: `http://localhost:${telegramMockPort}`,
        access: { mode: "locked", allowed_users: [TEST_USER_ID] },
      },
      defaults: {
        backend: "mock",
        model: "mock-model",
        tool_set: "standard",
        hang_detector: { enabled: false },
        cost_guard: {
          daily_limit_usd: 999,
          warn_at_percentage: 90,
          timezone: "UTC",
        },
        context_guardian: {
          grace_period_ms: 5000,    // Short grace for testing
          max_age_hours: 0.005,     // ~18 seconds — triggers rotation quickly
        },
        restart_policy: { max_retries: 3, backoff: "linear", reset_after: 300000 },
      },
      instances: {
        rotator: {
          working_directory: join(testDir, "work", "rotator"),
          display_name: "Rotator",
          description: "Instance for rotation testing",
          tags: ["test"],
          topic_id: 60,
        },
        general: {
          working_directory: join(testDir, "work", "general"),
          display_name: "General",
          description: "General topic",
          tags: ["test"],
          topic_id: 61,
          general_topic: true,
        },
      },
      teams: {},
      health_port: healthPort,
    };

    writeFileSync(join(testDir, "fleet.yaml"), yaml.dump(fleetConfig));
  }, 30_000);

  afterAll(async () => {
    if (fm) {
      try { await fm.stopAll(); } catch { /* best effort */ }
      fm = null;
    }
    await TmuxManager.killSession(TMUX_SESSION).catch(() => {});
    await telegramMock.stop();
    await sleep(500);
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.AGEND_TMUX_SESSION;
    delete process.env.AGEND_HOME;
    delete process.env.AGEND_BOT_TOKEN;
  }, 30_000);

  // --- Phase 1: Start fleet ---

  it("T12: fleet starts with rotator instance", async () => {
    fm = new FleetManager(testDir);
    await fm.startAll(join(testDir, "fleet.yaml"));

    await waitFor(
      () =>
        existsSync(join(testDir, "instances", "rotator", "statusline.json")) &&
        existsSync(join(testDir, "instances", "general", "statusline.json")),
      { timeout: 20_000, label: "rotator+general statusline.json" },
    );

    const status = JSON.parse(
      readFileSync(
        join(testDir, "instances", "rotator", "statusline.json"),
        "utf-8",
      ),
    );
    expect(status.session_id).toMatch(/^mock-rotator-/);
  }, 60_000);

  // --- Phase 2: Wait for max_age rotation ---

  it("T12: max_age timer triggers rotation and writes snapshot", async () => {
    const instanceDir = join(testDir, "instances", "rotator");

    // Record pre-rotation session
    const statusBefore = JSON.parse(
      readFileSync(join(instanceDir, "statusline.json"), "utf-8"),
    );
    const sessionBefore = statusBefore.session_id;

    // max_age_hours = 0.005 ≈ 18s. Wait for rotation to trigger.
    // After rotation: new session_id + rotation-state.json written.
    await waitFor(
      () => {
        try {
          const raw = readFileSync(
            join(instanceDir, "statusline.json"),
            "utf-8",
          );
          const status = JSON.parse(raw);
          return (
            status.session_id !== sessionBefore &&
            status.session_id.startsWith("mock-rotator-")
          );
        } catch {
          return false;
        }
      },
      { timeout: 45_000, interval: 2000, label: "max_age rotation new session" },
    );

    // Verify new session
    const statusAfter = JSON.parse(
      readFileSync(join(instanceDir, "statusline.json"), "utf-8"),
    );
    expect(statusAfter.session_id).not.toBe(sessionBefore);
    expect(statusAfter.session_id).toMatch(/^mock-rotator-/);
  }, 60_000);

  it("T12: rotation-state.json has reason max_age", () => {
    const snapshotPath = join(
      testDir,
      "instances",
      "rotator",
      "rotation-state.json",
    );
    expect(existsSync(snapshotPath)).toBe(true);

    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));
    expect(snapshot.instance).toBe("rotator");
    expect(snapshot.reason).toBe("max_age");
    expect(snapshot.created_at).toBeTruthy();
    expect(snapshot.working_directory).toContain("work/rotator");
  });

  it("T12: rotated instance responds to messages", async () => {
    const sendsBefore = telegramMock.getCallsFor("sendMessage").length;

    telegramMock.injectMessage({
      text: "Are you alive after rotation?",
      chatId: TEST_GROUP_ID,
      userId: TEST_USER_ID,
      username: "testuser",
      threadId: 60,
    });

    await waitFor(
      () => {
        const sends = telegramMock
          .getCallsFor("sendMessage")
          .slice(sendsBefore);
        return sends.some(
          (c) => String(c.params.message_thread_id) === "60",
        );
      },
      { timeout: 30_000, label: "post-rotation reply" },
    );

    const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
    const reply = sends.find(
      (c) => String(c.params.message_thread_id) === "60",
    );
    expect(reply).toBeDefined();
  }, 60_000);

  // --- Phase 3: Shutdown ---

  it("T12: fleet shuts down after rotation test", async () => {
    expect(fm).not.toBeNull();
    await fm!.stopAll();
    fm = null;
  }, 30_000);
});
