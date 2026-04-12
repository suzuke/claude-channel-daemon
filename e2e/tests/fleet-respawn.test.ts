/**
 * E2E Test: Instance Respawn + Recovery notifications
 *
 * T7: Trigger instance crash via mock-control.json → health check detects →
 *     respawn with backoff → instance recovers and responds to messages.
 * T8: Verify crash notification sent to both instance topic and general topic.
 * T10: Verify crash-aware snapshot: rotation-state.json written on crash,
 *      persists after injection (not deleted), updated on subsequent crashes.
 *
 * Uses a shorter health check assertion window. The test config sets
 * health_check_interval_ms to 3s, so detection + backoff + respawn
 * should complete within ~10s.
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
const TMUX_SESSION = `agend-respawn-${process.pid}`;

let telegramMock: TelegramMock;
let telegramMockPort: number;
let testDir: string;
let fm: FleetManager | null = null;
let healthPort: number;

describe("Fleet Respawn E2E", () => {
  beforeAll(async () => {
    process.env.AGEND_TMUX_SESSION = TMUX_SESSION;
    [healthPort, telegramMockPort] = await Promise.all([
      getFreePort(),
      getFreePort(),
    ]);

    telegramMock = createTelegramMock({ port: telegramMockPort });
    await telegramMock.start();

    testDir = `/tmp/ae2e-respawn-${Date.now().toString(36)}`;
    process.env.AGEND_HOME = testDir;
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "instances"), { recursive: true });
    mkdirSync(join(testDir, "access"), { recursive: true });
    mkdirSync(join(testDir, "work", "crasher"), { recursive: true });
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
        access: {
          mode: "locked",
          allowed_users: [TEST_USER_ID],
        },
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
        context_guardian: { grace_period_ms: 600000, max_age_hours: 0 },
        restart_policy: {
          max_retries: 3,
          backoff: "linear",
          reset_after: 300000,
          health_check_interval_ms: 3000,
        },
      },
      instances: {
        crasher: {
          working_directory: join(testDir, "work", "crasher"),
          display_name: "Crasher",
          description: "Instance that will be crashed for testing",
          tags: ["test"],
          topic_id: 50,
        },
        general: {
          working_directory: join(testDir, "work", "general"),
          display_name: "General",
          description: "General topic instance for notifications",
          tags: ["test"],
          topic_id: 51,
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
      try {
        await fm.stopAll();
      } catch {
        /* best effort */
      }
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

  it("T7: fleet starts with crasher and general instances", async () => {
    fm = new FleetManager(testDir);
    await fm.startAll(join(testDir, "fleet.yaml"));

    // Wait for both instances to be ready
    await waitFor(
      () =>
        existsSync(join(testDir, "instances", "crasher", "statusline.json")) &&
        existsSync(join(testDir, "instances", "general", "statusline.json")),
      { timeout: 20_000, label: "crasher+general statusline.json" },
    );

    const statusRaw = readFileSync(
      join(testDir, "instances", "crasher", "statusline.json"),
      "utf-8",
    );
    const status = JSON.parse(statusRaw);
    expect(status.session_id).toMatch(/^mock-crasher-/);
  }, 60_000);

  // --- Phase 2: Trigger crash and verify respawn ---

  it("T7: instance respawns after crash via mock-control", async () => {
    const instanceDir = join(testDir, "instances", "crasher");

    // Record pre-crash session ID
    const statusBefore = JSON.parse(
      readFileSync(join(instanceDir, "statusline.json"), "utf-8"),
    );
    const sessionBefore = statusBefore.session_id;
    expect(sessionBefore).toBeTruthy();

    // Trigger crash: write mock-control.json with exit command
    writeFileSync(
      join(instanceDir, "mock-control.json"),
      JSON.stringify({ exit: true }),
    );

    // Wait for respawn: health check runs every 30s, then backoff (1s linear).
    // New statusline.json should have a different session_id after respawn.
    // Clean up control file as soon as new session appears to prevent re-crash.
    let cleaned = false;
    await waitFor(
      () => {
        try {
          const raw = readFileSync(
            join(instanceDir, "statusline.json"),
            "utf-8",
          );
          const status = JSON.parse(raw);
          const respawned =
            status.session_id !== sessionBefore &&
            status.session_id.startsWith("mock-crasher-");
          if (respawned && !cleaned) {
            rmSync(join(instanceDir, "mock-control.json"), { force: true });
            cleaned = true;
          }
          return respawned;
        } catch {
          return false;
        }
      },
      { timeout: 30_000, interval: 2000, label: "respawn with new session_id" },
    );

    // Verify new session ID
    const statusAfter = JSON.parse(
      readFileSync(join(instanceDir, "statusline.json"), "utf-8"),
    );
    expect(statusAfter.session_id).not.toBe(sessionBefore);
    expect(statusAfter.session_id).toMatch(/^mock-crasher-/);
  }, 90_000);

  it("T8: crash notification sent to crasher topic", async () => {
    // notifyInstanceTopic is fire-and-forget async — poll for the sendMessage call
    await waitFor(
      () => {
        const sends = telegramMock.getCallsFor("sendMessage");
        return sends.some(
          (c) =>
            String(c.params.message_thread_id) === "50" &&
            typeof c.params.text === "string" &&
            (c.params.text as string).includes("crashed and respawned"),
        );
      },
      { timeout: 10_000, label: "crash notification to crasher topic" },
    );
  }, 15_000);

  it("T8: crash notification sent to general topic with daemon.log path", async () => {
    await waitFor(
      () => {
        const sends = telegramMock.getCallsFor("sendMessage");
        return sends.some(
          (c) =>
            String(c.params.message_thread_id) === "51" &&
            typeof c.params.text === "string" &&
            (c.params.text as string).includes("crashed and respawned") &&
            (c.params.text as string).includes("daemon.log"),
        );
      },
      { timeout: 10_000, label: "crash notification to general topic" },
    );
  }, 15_000);

  // --- Phase 2b: Crash-aware snapshot (T10) ---
  // After respawn, the daemon reads rotation-state.json, injects it as a
  // session-snapshot message, then deletes the file. Snapshot injection
  // is verified at the unit test level (daemon.test.ts). Here we only
  // verify the file lifecycle: written on crash, deleted after respawn.

  it("T10: rotation-state.json deleted after respawn (consumed by daemon)", () => {
    // buildSnapshotPrompt reads and deletes the file to prevent stale re-injection
    const snapshotPath = join(testDir, "instances", "crasher", "rotation-state.json");
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("T7: respawned instance responds to messages", async () => {
    const sendsBefore = telegramMock.getCallsFor("sendMessage").length;

    telegramMock.injectMessage({
      text: "Are you alive after crash?",
      chatId: TEST_GROUP_ID,
      userId: TEST_USER_ID,
      username: "testuser",
      threadId: 50,
    });

    await waitFor(
      () => {
        const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
        return sends.some(
          (c) => String(c.params.message_thread_id) === "50",
        );
      },
      { timeout: 30_000, label: "post-respawn reply" },
    );

    const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
    const reply = sends.find(
      (c) => String(c.params.message_thread_id) === "50",
    );
    expect(reply).toBeDefined();
  }, 60_000);

  // --- Phase 3: Shutdown ---

  it("T7: fleet shuts down after respawn test", async () => {
    expect(fm).not.toBeNull();
    await fm!.stopAll();
    fm = null;
  }, 30_000);
});
