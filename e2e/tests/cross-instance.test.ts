/**
 * E2E Test: Cross-Instance Communication
 *
 * T11: send_to_instance — alpha sends message to beta via MCP tool,
 *      beta receives and replies to its own topic.
 * T11: broadcast — message sent to all running instances.
 *
 * Uses mock-control.json call_tool directive to trigger MCP tool calls
 * from mock-claude without a real LLM.
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
const TMUX_SESSION = `agend-xinstance-${process.pid}`;

let telegramMock: TelegramMock;
let telegramMockPort: number;
let testDir: string;
let fm: FleetManager | null = null;
let healthPort: number;

describe("Cross-Instance Communication E2E", () => {
  beforeAll(async () => {
    process.env.AGEND_TMUX_SESSION = TMUX_SESSION;
    [healthPort, telegramMockPort] = await Promise.all([
      getFreePort(),
      getFreePort(),
    ]);

    telegramMock = createTelegramMock({ port: telegramMockPort });
    await telegramMock.start();

    testDir = `/tmp/ae2e-xins-${Date.now().toString(36)}`;
    process.env.AGEND_HOME = testDir;
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "instances"), { recursive: true });
    mkdirSync(join(testDir, "access"), { recursive: true });
    for (const name of ["alpha", "beta", "general"]) {
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
        alpha: {
          working_directory: join(testDir, "work", "alpha"),
          display_name: "Alpha",
          description: "Source instance",
          tags: ["test"],
          topic_id: 42,
        },
        beta: {
          working_directory: join(testDir, "work", "beta"),
          display_name: "Beta",
          description: "Target instance",
          tags: ["test"],
          topic_id: 87,
        },
        general: {
          working_directory: join(testDir, "work", "general"),
          display_name: "General",
          description: "General topic",
          tags: ["test"],
          topic_id: 51,
          general_topic: true,
        },
      },
      teams: {
        devteam: { members: ["alpha", "beta"], description: "Dev team" },
      },
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

  it("T11: fleet starts with alpha, beta, and general", async () => {
    fm = new FleetManager(testDir);
    await fm.startAll(join(testDir, "fleet.yaml"));

    await waitFor(
      () =>
        existsSync(join(testDir, "instances", "alpha", "statusline.json")) &&
        existsSync(join(testDir, "instances", "beta", "statusline.json")) &&
        existsSync(join(testDir, "instances", "general", "statusline.json")),
      { timeout: 20_000, label: "all instances ready" },
    );
  }, 60_000);

  // --- Phase 1b: Warm up reply context for all instances ---
  // Cross-instance messages have empty chat_id, so they don't populate
  // lastChatId/lastThreadId in the daemon. Each instance needs at least
  // one regular channel message first so replies have a destination.

  it("T11: warm up beta reply context", async () => {
    const sendsBefore = telegramMock.getCallsFor("sendMessage").length;
    telegramMock.injectMessage({
      text: "warm up",
      chatId: TEST_GROUP_ID,
      userId: TEST_USER_ID,
      username: "testuser",
      threadId: 87,
    });
    await waitFor(
      () =>
        telegramMock
          .getCallsFor("sendMessage")
          .slice(sendsBefore)
          .some((c) => String(c.params.message_thread_id) === "87"),
      { timeout: 30_000, label: "beta warm-up reply" },
    );
  }, 60_000);

  it("T11: warm up general reply context", async () => {
    const sendsBefore = telegramMock.getCallsFor("sendMessage").length;
    telegramMock.injectMessage({
      text: "warm up",
      chatId: TEST_GROUP_ID,
      userId: TEST_USER_ID,
      username: "testuser",
      threadId: 51,
    });
    await waitFor(
      () =>
        telegramMock
          .getCallsFor("sendMessage")
          .slice(sendsBefore)
          .some((c) => String(c.params.message_thread_id) === "51"),
      { timeout: 30_000, label: "general warm-up reply" },
    );
  }, 60_000);

  // --- Phase 2: send_to_instance ---

  it("T11: alpha sends to beta via send_to_instance, beta receives", async () => {
    const alphaDir = join(testDir, "instances", "alpha");
    const sendsBefore = telegramMock.getCallsFor("sendMessage").length;

    // Trigger alpha to call send_to_instance via mock-control
    writeFileSync(
      join(alphaDir, "mock-control.json"),
      JSON.stringify({
        call_tool: {
          name: "send_to_instance",
          args: {
            instance_name: "beta",
            message: "Hello beta from alpha!",
            request_kind: "query",
          },
        },
      }),
    );

    // Wait for beta to receive and reply (mock-claude auto-replies to any input)
    await waitFor(
      () => {
        const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
        return sends.some(
          (c) =>
            String(c.params.message_thread_id) === "87" &&
            typeof c.params.text === "string" &&
            (c.params.text as string).includes("Mock response"),
        );
      },
      { timeout: 30_000, label: "beta reply after send_to_instance" },
    );

    // Clean up control file
    rmSync(join(alphaDir, "mock-control.json"), { force: true });

    // Verify beta's topic got a reply
    const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
    const betaReply = sends.find(
      (c) => String(c.params.message_thread_id) === "87",
    );
    expect(betaReply).toBeDefined();
  }, 60_000);

  it("T11: send_to_instance cross-instance visibility post", async () => {
    // The send_to_instance handler posts a visibility notification to Telegram
    // Check that a notification was posted (not a query/report kind — those are posted)
    const sends = telegramMock.getCallsFor("sendMessage");
    const visibilityPost = sends.find(
      (c) =>
        typeof c.params.text === "string" &&
        (c.params.text as string).includes("alpha") &&
        (c.params.text as string).includes("beta"),
    );
    expect(visibilityPost).toBeDefined();
  });

  // --- Phase 3: broadcast ---

  it("T11: broadcast sends to all instances", async () => {
    const alphaDir = join(testDir, "instances", "alpha");
    const sendsBefore = telegramMock.getCallsFor("sendMessage").length;

    // Trigger alpha to broadcast
    writeFileSync(
      join(alphaDir, "mock-control.json"),
      JSON.stringify({
        call_tool: {
          name: "broadcast",
          args: {
            message: "Broadcast from alpha to all!",
          },
        },
      }),
    );

    // Wait for both beta and general to receive and reply
    await waitFor(
      () => {
        const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
        const betaGot = sends.some(
          (c) =>
            String(c.params.message_thread_id) === "87" &&
            typeof c.params.text === "string" &&
            (c.params.text as string).includes("Mock response"),
        );
        const generalGot = sends.some(
          (c) =>
            String(c.params.message_thread_id) === "51" &&
            typeof c.params.text === "string" &&
            (c.params.text as string).includes("Mock response"),
        );
        return betaGot && generalGot;
      },
      { timeout: 30_000, label: "broadcast replies from beta + general" },
    );

    rmSync(join(alphaDir, "mock-control.json"), { force: true });
  }, 60_000);

  // --- Phase 4: Shutdown ---

  it("T11: fleet shuts down", async () => {
    expect(fm).not.toBeNull();
    await fm!.stopAll();
    fm = null;
  }, 30_000);
});
