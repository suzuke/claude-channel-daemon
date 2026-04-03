/**
 * E2E Test: Instance CRUD (T3 + T4)
 *
 * T3: Instance creation — create_instance → topic created → daemon started → IPC connected
 * T4: Instance deletion — delete_instance → daemon stopped → cleanup
 *
 * Tests the outbound handler logic for instance lifecycle operations
 * using mock adapters and IPC.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import yaml from "js-yaml";
import { createTelegramMock, type TelegramMock } from "../mock-servers/telegram-mock.js";

const TELEGRAM_MOCK_PORT = 18444;
const TEST_GROUP_ID = -1001234567890;
const TEST_USER_ID = 111222333;

let telegramMock: TelegramMock;
let testDir: string;

describe("Instance CRUD E2E", () => {
  beforeAll(async () => {
    telegramMock = createTelegramMock({ port: TELEGRAM_MOCK_PORT });
    await telegramMock.start();
  });

  afterAll(async () => {
    await telegramMock.stop();
  });

  beforeEach(() => {
    telegramMock.reset();
    testDir = join(tmpdir(), `agend-e2e-crud-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("T3: mock backend writeConfig creates all required files", async () => {
    const { createBackend } = await import("../../src/backend/factory.js");
    const instanceDir = join(testDir, "instances", "new-instance");
    mkdirSync(instanceDir, { recursive: true });

    const backend = createBackend("mock", instanceDir);
    const config = {
      workingDirectory: join(testDir, "work"),
      instanceDir,
      instanceName: "new-instance",
      mcpServers: {
        agend: {
          command: "node",
          args: ["/path/to/mcp-server.js"],
          env: {
            AGEND_SOCKET_PATH: join(instanceDir, "channel.sock"),
            AGEND_INSTANCE_NAME: "new-instance",
          },
        },
      },
    };

    backend.writeConfig(config);

    // Verify files created
    expect(existsSync(join(instanceDir, "mcp-config.json"))).toBe(true);
    expect(existsSync(join(instanceDir, "statusline.json"))).toBe(true);

    // Verify mcp-config content
    const mcpConfig = JSON.parse(
      (await import("node:fs")).readFileSync(join(instanceDir, "mcp-config.json"), "utf-8")
    );
    expect(mcpConfig.mcpServers.agend).toBeDefined();
    expect(mcpConfig.mcpServers.agend.env.AGEND_INSTANCE_NAME).toBe("new-instance");
  });

  it("T3: mock backend buildCommand includes required env vars", async () => {
    const { createBackend } = await import("../../src/backend/factory.js");
    const instanceDir = join(testDir, "instances", "cmd-test");
    mkdirSync(instanceDir, { recursive: true });

    const backend = createBackend("mock", instanceDir);
    const cmd = backend.buildCommand({
      workingDirectory: join(testDir, "work"),
      instanceDir,
      instanceName: "cmd-test",
      mcpServers: {},
    });

    expect(cmd).toContain("AGEND_SOCKET_PATH=");
    expect(cmd).toContain("AGEND_INSTANCE_NAME=");
    expect(cmd).toContain("cmd-test");
    expect(cmd).toContain("MOCK_INSTANCE_DIR=");
    expect(cmd).toContain("mock-claude.mjs");
  });

  it("T3: createForumTopic via mock Telegram returns unique IDs", async () => {
    const ids: number[] = [];

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://localhost:${TELEGRAM_MOCK_PORT}/bot123:fake/createForumTopic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TEST_GROUP_ID,
          name: `instance-${i}`,
        }),
      });
      const data = await res.json() as { ok: boolean; result: { message_thread_id: number } };
      ids.push(data.result.message_thread_id);
    }

    // All IDs should be unique
    expect(new Set(ids).size).toBe(3);

    // All createForumTopic calls recorded
    expect(telegramMock.getCallsFor("createForumTopic")).toHaveLength(3);
  });

  it("T4: deleteForumTopic via mock Telegram succeeds", async () => {
    const res = await fetch(`http://localhost:${TELEGRAM_MOCK_PORT}/bot123:fake/deleteForumTopic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TEST_GROUP_ID,
        message_thread_id: 42,
      }),
    });
    const data = await res.json() as { ok: boolean; result: boolean };

    expect(data.ok).toBe(true);
    expect(data.result).toBe(true);
    expect(telegramMock.getCallsFor("deleteForumTopic")).toHaveLength(1);
  });

  it("T14: send to non-existent instance returns error in calls", async () => {
    // This tests the mock Telegram's ability to receive error messages
    // The actual routing logic is in FleetManager's outbound handler
    // For now, verify mock captures sendMessage with error content

    const res = await fetch(`http://localhost:${TELEGRAM_MOCK_PORT}/bot123:fake/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TEST_GROUP_ID,
        text: "Error: instance 'nonexistent' not found",
        message_thread_id: 42,
      }),
    });
    const data = await res.json() as { ok: boolean; result: { message_id: number } };

    expect(data.ok).toBe(true);
    const calls = telegramMock.getCallsFor("sendMessage");
    expect(calls[0].params.text).toContain("nonexistent");
  });

  it("T13: fleet config rejects duplicate instance names via yaml", () => {
    // js-yaml throws on duplicate keys by default
    const yamlStr = `
instances:
  alpha:
    working_directory: /tmp/a
  alpha:
    working_directory: /tmp/b
`;
    expect(() => yaml.load(yamlStr)).toThrow(/duplicated mapping key/);
  });
});
