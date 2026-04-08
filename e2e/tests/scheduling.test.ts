/**
 * E2E Test: Scheduling System
 *
 * T13: Schedule creation → manual trigger → message delivered to target instance.
 * T13: Schedule run audit trail recorded in database.
 * T13: Schedule deletion stops future triggers.
 *
 * Uses FleetManager.scheduler directly (public property) to create/trigger
 * schedules, then verifies delivery via mock Telegram call log.
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
const TMUX_SESSION = `agend-sched-${process.pid}`;

let telegramMock: TelegramMock;
let telegramMockPort: number;
let testDir: string;
let fm: FleetManager | null = null;
let healthPort: number;

describe("Scheduling E2E", () => {
  beforeAll(async () => {
    process.env.AGEND_TMUX_SESSION = TMUX_SESSION;
    [healthPort, telegramMockPort] = await Promise.all([
      getFreePort(),
      getFreePort(),
    ]);

    telegramMock = createTelegramMock({ port: telegramMockPort });
    await telegramMock.start();

    testDir = `/tmp/ae2e-sched-${Date.now().toString(36)}`;
    process.env.AGEND_HOME = testDir;
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "instances"), { recursive: true });
    mkdirSync(join(testDir, "access"), { recursive: true });
    for (const name of ["source", "target", "general"]) {
      mkdirSync(join(testDir, "work", name), { recursive: true });
    }

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
        context_guardian: { grace_period_ms: 600000, max_age_hours: 0 },
        restart_policy: { max_retries: 3, backoff: "linear", reset_after: 300000 },
      },
      instances: {
        source: {
          working_directory: join(testDir, "work", "source"),
          display_name: "Source",
          description: "Schedule creator",
          tags: ["test"],
          topic_id: 70,
        },
        target: {
          working_directory: join(testDir, "work", "target"),
          display_name: "Target",
          description: "Schedule receiver",
          tags: ["test"],
          topic_id: 71,
        },
        general: {
          working_directory: join(testDir, "work", "general"),
          display_name: "General",
          description: "General topic",
          tags: ["test"],
          topic_id: 72,
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

  it("T13: fleet starts with source and target instances", async () => {
    fm = new FleetManager(testDir);
    await fm.startAll(join(testDir, "fleet.yaml"));

    await waitFor(
      () =>
        existsSync(join(testDir, "instances", "source", "statusline.json")) &&
        existsSync(join(testDir, "instances", "target", "statusline.json")) &&
        existsSync(join(testDir, "instances", "general", "statusline.json")),
      { timeout: 20_000, label: "all instances ready" },
    );
  }, 60_000);

  // Warm up target's reply context — schedule-triggered messages have
  // chat_id from the schedule's reply_chat_id, but we need the daemon's
  // lastChatId/lastThreadId populated for the reply tool to work.
  it("T13: warm up target reply context", async () => {
    const sendsBefore = telegramMock.getCallsFor("sendMessage").length;
    telegramMock.injectMessage({
      text: "warm up",
      chatId: TEST_GROUP_ID,
      userId: TEST_USER_ID,
      username: "testuser",
      threadId: 71,
    });
    await waitFor(
      () =>
        telegramMock
          .getCallsFor("sendMessage")
          .slice(sendsBefore)
          .some((c) => String(c.params.message_thread_id) === "71"),
      { timeout: 30_000, label: "target warm-up reply" },
    );
  }, 60_000);

  it("T13: scheduler is initialized", () => {
    expect(fm).not.toBeNull();
    expect(fm!.scheduler).not.toBeNull();
  });

  // --- Phase 2: Create and trigger schedule ---

  let scheduleId: string;

  it("T13: create schedule targeting 'target' instance", () => {
    const schedule = fm!.scheduler!.create({
      cron: "0 0 1 1 *",  // Jan 1 midnight — won't fire naturally during test
      message: "Scheduled ping from test",
      source: "source",
      target: "target",
      reply_chat_id: String(TEST_GROUP_ID),
      reply_thread_id: "71",
      label: "test-schedule",
      timezone: "UTC",
    });

    expect(schedule.id).toBeTruthy();
    expect(schedule.target).toBe("target");
    expect(schedule.enabled).toBe(true);
    scheduleId = schedule.id;
  });

  it("T13: list schedules returns the created schedule", () => {
    const schedules = fm!.scheduler!.list();
    const found = schedules.find((s) => s.id === scheduleId);
    expect(found).toBeDefined();
    expect(found!.label).toBe("test-schedule");
    expect(found!.target).toBe("target");
  });

  it("T13: manual trigger delivers message to target instance", async () => {
    const sendsBefore = telegramMock.getCallsFor("sendMessage").length;

    // Manual trigger — simulates cron firing
    fm!.scheduler!.trigger(scheduleId);

    // Wait for target to receive the scheduled message and reply
    await waitFor(
      () => {
        const sends = telegramMock
          .getCallsFor("sendMessage")
          .slice(sendsBefore);
        return sends.some(
          (c) =>
            String(c.params.message_thread_id) === "71" &&
            typeof c.params.text === "string" &&
            (c.params.text as string).includes("Mock response"),
        );
      },
      { timeout: 30_000, label: "target reply after schedule trigger" },
    );

    const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
    const targetReply = sends.find(
      (c) => String(c.params.message_thread_id) === "71",
    );
    expect(targetReply).toBeDefined();
  }, 60_000);

  it("T13: schedule run recorded as delivered", () => {
    const runs = fm!.scheduler!.db.getRuns(scheduleId);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].status).toBe("delivered");
  });

  // --- Phase 3: Delete schedule ---

  it("T13: delete schedule removes it from list", () => {
    fm!.scheduler!.delete(scheduleId);
    const schedules = fm!.scheduler!.list();
    const found = schedules.find((s) => s.id === scheduleId);
    expect(found).toBeUndefined();
  });

  // --- Phase 4: Shutdown ---

  it("T13: fleet shuts down after scheduling test", async () => {
    expect(fm).not.toBeNull();
    await fm!.stopAll();
    fm = null;
  }, 30_000);
});
