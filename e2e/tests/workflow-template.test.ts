/**
 * E2E Test: Workflow Template Injection
 *
 * T15: Verify workflow template is injected into MCP instructions.
 *   - Default (builtin): instructions contain "Fleet Collaboration" (executor version)
 *   - workflow: false → instructions do NOT contain workflow content
 *   - workflow: "file:..." → instructions contain custom file content
 *   - workflow + systemPrompt → both appear in instructions
 *
 * Tests inspect `mcp-instructions.txt` written by mock-claude after MCP init.
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
const TMUX_SESSION = `agend-wf-${process.pid}`;

let telegramMock: TelegramMock;
let telegramMockPort: number;
let testDir: string;
let fm: FleetManager | null = null;
let healthPort: number;

describe("Workflow Template E2E", () => {
  beforeAll(async () => {
    process.env.AGEND_TMUX_SESSION = TMUX_SESSION;
    [healthPort, telegramMockPort] = await Promise.all([
      getFreePort(),
      getFreePort(),
    ]);

    telegramMock = createTelegramMock({ port: telegramMockPort });
    await telegramMock.start();

    testDir = `/tmp/ae2e-wf-${Date.now().toString(36)}`;
    process.env.AGEND_HOME = testDir;
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "instances"), { recursive: true });
    mkdirSync(join(testDir, "access"), { recursive: true });
    for (const name of [
      "default-wf",
      "no-wf",
      "custom-wf",
      "both-wf",
      "general",
    ]) {
      mkdirSync(join(testDir, "work", name), { recursive: true });
    }

    // Create custom workflow file
    writeFileSync(
      join(testDir, "custom-workflow.md"),
      "# Custom Workflow\n\nThis is a custom workflow for testing.\n",
    );

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
        restart_policy: {
          max_retries: 3,
          backoff: "linear",
          reset_after: 300000,
        },
      },
      instances: {
        "default-wf": {
          working_directory: join(testDir, "work", "default-wf"),
          display_name: "DefaultWF",
          description: "Instance with default (builtin) workflow",
          tags: ["test"],
          topic_id: 80,
          // workflow not set → defaults to "builtin"
        },
        "no-wf": {
          working_directory: join(testDir, "work", "no-wf"),
          display_name: "NoWF",
          description: "Instance with workflow disabled",
          tags: ["test"],
          topic_id: 81,
          workflow: false,
        },
        "custom-wf": {
          working_directory: join(testDir, "work", "custom-wf"),
          display_name: "CustomWF",
          description: "Instance with custom workflow file",
          tags: ["test"],
          topic_id: 82,
          workflow: `file:${join(testDir, "custom-workflow.md")}`,
        },
        "both-wf": {
          working_directory: join(testDir, "work", "both-wf"),
          display_name: "BothWF",
          description: "Instance with workflow + systemPrompt",
          tags: ["test"],
          topic_id: 83,
          // workflow defaults to builtin
          systemPrompt: "You are a specialized testing agent.",
        },
        general: {
          working_directory: join(testDir, "work", "general"),
          display_name: "General",
          description: "General topic",
          tags: ["test"],
          topic_id: 84,
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

  it("T15: fleet starts with all workflow variants", async () => {
    fm = new FleetManager(testDir);
    await fm.startAll(join(testDir, "fleet.yaml"));

    // Wait for all instances to write mcp-instructions.txt
    const instances = ["default-wf", "no-wf", "custom-wf", "both-wf"];
    await waitFor(
      () =>
        instances.every((name) =>
          existsSync(
            join(testDir, "instances", name, "mcp-instructions.txt"),
          ),
        ),
      { timeout: 30_000, label: "all mcp-instructions.txt files" },
    );
  }, 60_000);

  // --- Phase 2: Verify workflow injection ---

  it("T15: default workflow includes builtin template", () => {
    const instructions = readFileSync(
      join(testDir, "instances", "default-wf", "mcp-instructions.txt"),
      "utf-8",
    );
    expect(instructions).toContain("Development Workflow");
    expect(instructions).toContain("Fleet Collaboration");
    expect(instructions).toContain("Communication Rules");
    expect(instructions).toContain("Context Protection");
  });

  it("T15: workflow false excludes workflow content", () => {
    const instructions = readFileSync(
      join(testDir, "instances", "no-wf", "mcp-instructions.txt"),
      "utf-8",
    );
    expect(instructions).not.toContain("Development Workflow");
    expect(instructions).not.toContain("Fleet Collaboration");
    // Should still have base fleet context
    expect(instructions).toContain("Collaboration Rules");
  });

  it("T15: custom file workflow injects file content", () => {
    const instructions = readFileSync(
      join(testDir, "instances", "custom-wf", "mcp-instructions.txt"),
      "utf-8",
    );
    expect(instructions).toContain("Development Workflow");
    expect(instructions).toContain("Custom Workflow");
    expect(instructions).toContain("custom workflow for testing");
    // Should NOT contain builtin template
    expect(instructions).not.toContain("Communication Rules");
  });

  it("T15: workflow + systemPrompt both appear in instructions", () => {
    const instructions = readFileSync(
      join(testDir, "instances", "both-wf", "mcp-instructions.txt"),
      "utf-8",
    );
    // Builtin workflow present
    expect(instructions).toContain("Fleet Collaboration");
    expect(instructions).toContain("Communication Rules");
    // Custom systemPrompt also present
    expect(instructions).toContain("specialized testing agent");
  });

  // --- Phase 3: Shutdown ---

  it("T15: fleet shuts down after workflow test", async () => {
    expect(fm).not.toBeNull();
    await fm!.stopAll();
    fm = null;
  }, 30_000);
});
