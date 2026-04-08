/**
 * E2E Test: Rate limit failover cooldown (#10)
 *
 * T16: Trigger rate limit error via mock-control pty_output → verify failover
 *      notification sent. Then trigger again within cooldown → verify
 *      no duplicate notification (cooldown suppresses it).
 *
 * Uses mock backend's MOCK_RATE_LIMIT error pattern and the pty_output
 * mock-control directive to inject error text into the tmux pane.
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
const TMUX_SESSION = `agend-failover-${process.pid}`;

let telegramMock: TelegramMock;
let telegramMockPort: number;
let testDir: string;
let fm: FleetManager | null = null;
let healthPort: number;

describe("Failover Cooldown E2E", () => {
  beforeAll(async () => {
    process.env.AGEND_TMUX_SESSION = TMUX_SESSION;
    [healthPort, telegramMockPort] = await Promise.all([
      getFreePort(),
      getFreePort(),
    ]);

    telegramMock = createTelegramMock({ port: telegramMockPort });
    await telegramMock.start();

    testDir = `/tmp/ae2e-failover-${Date.now().toString(36)}`;
    process.env.AGEND_HOME = testDir;
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "instances"), { recursive: true });
    mkdirSync(join(testDir, "access"), { recursive: true });
    mkdirSync(join(testDir, "work", "ratelimited"), { recursive: true });
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
        },
      },
      instances: {
        ratelimited: {
          working_directory: join(testDir, "work", "ratelimited"),
          display_name: "RateLimited",
          description: "Instance that will hit rate limits",
          tags: ["test"],
          topic_id: 60,
          model_failover: ["mock-model", "mock-fallback"],
        },
        general: {
          working_directory: join(testDir, "work", "general"),
          display_name: "General",
          description: "General topic for notifications",
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

  it("T16: fleet starts with ratelimited and general instances", async () => {
    fm = new FleetManager(testDir);
    await fm.startAll(join(testDir, "fleet.yaml"));

    await waitFor(
      () =>
        existsSync(join(testDir, "instances", "ratelimited", "statusline.json")) &&
        existsSync(join(testDir, "instances", "general", "statusline.json")),
      { timeout: 20_000, label: "ratelimited+general statusline.json" },
    );

    const statusRaw = readFileSync(
      join(testDir, "instances", "ratelimited", "statusline.json"),
      "utf-8",
    );
    const status = JSON.parse(statusRaw);
    expect(status.session_id).toMatch(/^mock-ratelimited-/);
  }, 60_000);

  // --- Phase 2: Trigger rate limit and verify failover ---

  it("T16: rate limit error triggers failover notification", async () => {
    const instanceDir = join(testDir, "instances", "ratelimited");

    // Clear previous calls
    telegramMock.reset();

    // Inject rate limit error text into PTY output
    writeFileSync(
      join(instanceDir, "mock-control.json"),
      JSON.stringify({ pty_output: "ERROR: MOCK_RATE_LIMIT exceeded" }),
    );

    // Wait for error monitor (30s interval) to detect and send notification
    await waitFor(
      () => {
        const sends = telegramMock.getCallsFor("sendMessage");
        return sends.some(
          (c: any) =>
            String(c.params.message_thread_id) === "60" &&
            (c.params.text as string).includes("Mock rate limit reached"),
        );
      },
      { timeout: 45_000, interval: 2000, label: "failover notification on topic 60" },
    );

    const sends = telegramMock.getCallsFor("sendMessage");
    const failoverNotification = sends.find(
      (c: any) =>
        String(c.params.message_thread_id) === "60" &&
        (c.params.text as string).includes("Mock rate limit reached"),
    );
    expect(failoverNotification).toBeDefined();
    expect((failoverNotification as any).params.text).toContain("failover");
  }, 60_000);

  // --- Phase 3: Verify cooldown suppresses duplicate ---

  it("T16: second rate limit within cooldown is suppressed", async () => {
    const instanceDir = join(testDir, "instances", "ratelimited");

    // Record notification count after first failover
    const countBefore = telegramMock.getCallsFor("sendMessage").filter(
      (c: any) =>
        String(c.params.message_thread_id) === "60" &&
        (c.params.text as string).includes("Mock rate limit reached"),
    ).length;

    // Wait for error monitor to recover (detect MOCK_READY in pane)
    // Then inject another rate limit error — should be suppressed by cooldown
    await sleep(35_000); // Wait for one error monitor cycle to detect recovery

    // Inject second rate limit error
    writeFileSync(
      join(instanceDir, "mock-control.json"),
      JSON.stringify({ pty_output: "ERROR: MOCK_RATE_LIMIT exceeded again" }),
    );

    // Wait two error monitor cycles (60s) — if cooldown works, no new notification
    await sleep(65_000);

    const countAfter = telegramMock.getCallsFor("sendMessage").filter(
      (c: any) =>
        String(c.params.message_thread_id) === "60" &&
        (c.params.text as string).includes("Mock rate limit reached"),
    ).length;

    // Should NOT have a new failover notification (cooldown is 5 minutes)
    expect(countAfter).toBe(countBefore);
  }, 120_000);

  // --- Phase 4: Clean shutdown ---

  it("T16: fleet shuts down after failover test", async () => {
    if (fm) {
      await fm.stopAll();
      fm = null;
    }
    await TmuxManager.killSession(TMUX_SESSION).catch(() => {});
  }, 30_000);
});
