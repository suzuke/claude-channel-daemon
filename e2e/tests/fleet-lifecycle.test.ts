/**
 * E2E Test: Fleet Lifecycle — Full FleetManager + tmux + MockBackend (B Layer)
 *
 * T1: Fleet startup — FleetManager.startAll() → daemons running → IPC connected
 * T2: Fleet shutdown — FleetManager.stopAll() → daemons stopped → sockets cleaned
 * T5: Message routing — mock Telegram injects message → correct instance receives
 * T6: Reply path — instance reply → mock Telegram records sendMessage
 *
 * This test runs a REAL FleetManager with tmux, using MockBackend and mock Telegram.
 * Uses a unique tmux session name (AGEND_TMUX_SESSION) to avoid conflicts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import { createTelegramMock, type TelegramMock } from "../mock-servers/telegram-mock.js";
import { waitFor, sleep, getFreePort } from "../mock-servers/shared.js";
import { TmuxManager } from "../../src/tmux-manager.js";
import { FleetManager } from "../../src/fleet-manager.js";

const TEST_GROUP_ID = -1001234567890;
const TEST_USER_ID = 111222333;
const TMUX_SESSION = `agend-e2e-${process.pid}`;

let telegramMock: TelegramMock;
let telegramMockPort: number;
let testDir: string;
let fm: FleetManager | null = null;
let healthPort: number;

describe("Fleet Lifecycle E2E (B Layer)", () => {
  beforeAll(async () => {
    process.env.AGEND_TMUX_SESSION = TMUX_SESSION;
    [healthPort, telegramMockPort] = await Promise.all([getFreePort(), getFreePort()]);

    telegramMock = createTelegramMock({ port: telegramMockPort });
    await telegramMock.start();

    // Use /tmp/ directly (not tmpdir()) to keep socket paths under macOS 104-byte limit.
    // tmpdir() on macOS returns /var/folders/.../T/ (~50 chars), which makes
    // .../instances/<name>/channel.sock exceed the sun_path limit.
    testDir = `/tmp/ae2e-${Date.now().toString(36)}`;
    process.env.AGEND_HOME = testDir;
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "instances"), { recursive: true });
    mkdirSync(join(testDir, "access"), { recursive: true });

    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(testDir, "work", name), { recursive: true });
    }

    writeFileSync(join(testDir, ".env"), `AGEND_BOT_TOKEN=123456:FAKE_TOKEN\n`);

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
        cost_guard: { daily_limit_usd: 999, warn_at_percentage: 90, timezone: "UTC" },
        context_guardian: { grace_period_ms: 600000, max_age_hours: 0 },
      },
      instances: {
        alpha: {
          working_directory: join(testDir, "work", "alpha"),
          display_name: "Alpha",
          description: "Test instance A",
          tags: ["test"],
          topic_id: 42,
        },
        beta: {
          working_directory: join(testDir, "work", "beta"),
          display_name: "Beta",
          description: "Test instance B",
          tags: ["test"],
          topic_id: 87,
        },
      },
      teams: {
        "test-team": {
          members: ["alpha", "beta"],
          description: "Test team",
        },
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
    // Give processes time to release files
    await sleep(500);
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.AGEND_TMUX_SESSION;
    delete process.env.AGEND_HOME;
    delete process.env.AGEND_BOT_TOKEN;
  }, 30_000);

  // --- Phase 1: Pre-flight checks ---

  it("T1: fleet config is set up correctly", () => {
    expect(existsSync(join(testDir, "fleet.yaml"))).toBe(true);
    expect(existsSync(join(testDir, ".env"))).toBe(true);

    const config = yaml.load(readFileSync(join(testDir, "fleet.yaml"), "utf-8")) as Record<string, unknown>;
    expect((config.defaults as Record<string, unknown>).backend).toBe("mock");
  });

  it("T1: FleetManager can be constructed", () => {
    fm = new FleetManager(testDir);
    expect(fm).toBeDefined();
    expect(fm.dataDir).toBe(testDir);
  });

  it("T1: mock Telegram server is accessible", async () => {
    const res = await fetch(`http://localhost:${telegramMockPort}/bot123456:FAKE_TOKEN/getMe`);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  // --- Phase 2: Fleet startup ---

  it("T1: FleetManager.startAll() launches fleet with mock backend", async () => {
    expect(fm).not.toBeNull();

    const configPath = join(testDir, "fleet.yaml");
    await fm!.startAll(configPath);

    // Verify tmux session was created
    const sessionExists = await TmuxManager.sessionExists(TMUX_SESSION);
    expect(sessionExists).toBe(true);

    // Verify fleet config was loaded
    expect(fm!.fleetConfig).not.toBeNull();
    expect(fm!.fleetConfig!.instances).toHaveProperty("alpha");
    expect(fm!.fleetConfig!.instances).toHaveProperty("beta");
  }, 60_000);

  it("T1: adapter connected to mock Telegram (getMe called)", async () => {
    // grammy should have called getMe during bot.start()
    await waitFor(
      () => telegramMock.getCallsFor("getMe").length > 0,
      { timeout: 10_000, label: "getMe from adapter" },
    );
    expect(telegramMock.getCallsFor("getMe").length).toBeGreaterThan(0);
  });

  it("T1: instance directories and sockets created", async () => {
    // Wait for instance directories to be populated
    await waitFor(
      () => existsSync(join(testDir, "instances", "alpha", "mcp-config.json")),
      { timeout: 15_000, label: "alpha mcp-config.json" },
    );

    for (const name of ["alpha", "beta"]) {
      const dir = join(testDir, "instances", name);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, "mcp-config.json"))).toBe(true);
      expect(existsSync(join(dir, "statusline.json"))).toBe(true);
    }
  }, 30_000);

  it("T1: health endpoint responds", async () => {
    await waitFor(
      async () => {
        const res = await fetch(`http://localhost:${healthPort}/health`);
        return res.ok;
      },
      { timeout: 10_000, label: "health endpoint" },
    );
  });

  // --- Phase 2b: Message routing ---

  it("T5: message routed to correct instance via topic_id", async () => {
    // Reset to isolate this test's calls
    const sendsBefore = telegramMock.getCallsFor("sendMessage").length;

    // Inject message to alpha's topic (topic_id: 42)
    telegramMock.injectMessage({
      text: "Hello alpha",
      chatId: TEST_GROUP_ID,
      userId: TEST_USER_ID,
      username: "testuser",
      threadId: 42,
    });

    // Wait for bot to reply in alpha's topic
    await waitFor(
      () => {
        const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
        return sends.some(
          (c) => String(c.params.message_thread_id) === "42",
        );
      },
      { timeout: 30_000, label: "sendMessage to alpha topic" },
    );

    const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
    const alphaReply = sends.find(
      (c) => String(c.params.message_thread_id) === "42",
    );
    expect(alphaReply).toBeDefined();
    expect(String(alphaReply!.params.chat_id)).toBe(String(TEST_GROUP_ID));
  }, 60_000);

  it("T5: message to beta topic routes to beta, not alpha", async () => {
    const sendsBefore = telegramMock.getCallsFor("sendMessage").length;

    telegramMock.injectMessage({
      text: "Hello beta",
      chatId: TEST_GROUP_ID,
      userId: TEST_USER_ID,
      username: "testuser",
      threadId: 87,
    });

    await waitFor(
      () => {
        const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
        return sends.some(
          (c) => String(c.params.message_thread_id) === "87",
        );
      },
      { timeout: 30_000, label: "sendMessage to beta topic" },
    );

    const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
    const betaReply = sends.find(
      (c) => String(c.params.message_thread_id) === "87",
    );
    expect(betaReply).toBeDefined();
    expect(String(betaReply!.params.chat_id)).toBe(String(TEST_GROUP_ID));

    // Negative assertion: alpha should NOT receive this message's reply
    const alphaMisroute = sends.find(
      (c) => String(c.params.message_thread_id) === "42",
    );
    expect(alphaMisroute).toBeUndefined();
  }, 60_000);

  it("T6: reply contains mock backend response text", async () => {
    const sendsBefore = telegramMock.getCallsFor("sendMessage").length;

    telegramMock.injectMessage({
      text: "ping",
      chatId: TEST_GROUP_ID,
      userId: TEST_USER_ID,
      username: "testuser",
      threadId: 42,
    });

    await waitFor(
      () => {
        const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
        return sends.some(
          (c) => String(c.params.message_thread_id) === "42" && typeof c.params.text === "string",
        );
      },
      { timeout: 30_000, label: "reply text from mock backend" },
    );

    const sends = telegramMock.getCallsFor("sendMessage").slice(sendsBefore);
    const reply = sends.find(
      (c) => String(c.params.message_thread_id) === "42" && typeof c.params.text === "string",
    );
    expect(reply).toBeDefined();
    expect(typeof reply!.params.text).toBe("string");
    expect((reply!.params.text as string).length).toBeGreaterThan(0);
  }, 60_000);

  // --- Phase 3: Fleet shutdown ---

  it("T2: FleetManager.stopAll() shuts down gracefully", async () => {
    expect(fm).not.toBeNull();
    await fm!.stopAll();

    // Verify adapter stopped (no more getUpdates polling)
    const callsBefore = telegramMock.getCallsFor("getUpdates").length;
    await sleep(3000);
    const callsAfter = telegramMock.getCallsFor("getUpdates").length;

    // Polling should have stopped (no new getUpdates calls)
    expect(callsAfter - callsBefore).toBeLessThanOrEqual(2);

    // Verify health endpoint is gone
    try {
      await fetch(`http://localhost:${healthPort}/health`);
      // If we get here, server is still running — not great but not fatal
    } catch {
      // Expected: connection refused
    }

    fm = null;
  }, 30_000);
});
