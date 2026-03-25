import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../../src/backend/claude-code.js";
import type { CliBackendConfig } from "../../src/backend/types.js";

const TEST_DIR = "/tmp/ccd-test-claude-backend";
const WORK_DIR = "/tmp/ccd-test-workdir";

function makeConfig(overrides?: Partial<CliBackendConfig>): CliBackendConfig {
  return {
    workingDirectory: WORK_DIR,
    instanceDir: TEST_DIR,
    instanceName: "test",
    mcpServers: {
      "ccd-channel": {
        command: "node",
        args: ["/path/to/mcp-server.js"],
        env: { CCD_SOCKET_PATH: "/tmp/test.sock" },
      },
    },
    ...overrides,
  };
}

describe("ClaudeCodeBackend", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(WORK_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  describe("buildCommand", () => {
    it("includes claude with --settings flag", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("claude");
      expect(cmd).toContain("--settings");
      expect(cmd).toContain("claude-settings.json");
    });

    it("includes --resume when session-id file exists", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "sess-123");
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--resume sess-123");
    });

    it("does not include --resume when no session-id", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).not.toContain("--resume");
    });

    it("includes CMUX_CLAUDE_HOOKS_DISABLED=1", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("CMUX_CLAUDE_HOOKS_DISABLED=1");
    });

    it("includes --dangerously-load-development-channels", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--dangerously-load-development-channels server:ccd-channel");
    });

    it("does not include --dangerously-skip-permissions", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).not.toContain("--dangerously-skip-permissions");
    });

    it("does not include --system-prompt by default", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).not.toContain("--system-prompt");
    });

    it("includes --system-prompt with path when systemPrompt is set", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ systemPrompt: "You are a debater." }));
      expect(cmd).toContain("--system-prompt");
      expect(cmd).toContain("system-prompt.md");
    });

    it("writes system-prompt.md to instanceDir when systemPrompt is set", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.buildCommand(makeConfig({ systemPrompt: "You are a debater." }));
      const promptPath = join(TEST_DIR, "system-prompt.md");
      expect(existsSync(promptPath)).toBe(true);
      expect(readFileSync(promptPath, "utf-8")).toBe("You are a debater.");
    });
  });

  describe("writeConfig", () => {
    it("writes .mcp.json with ccd-channel entry", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const mcpConfig = JSON.parse(readFileSync(join(WORK_DIR, ".mcp.json"), "utf-8"));
      expect(mcpConfig.mcpServers["ccd-channel"]).toBeDefined();
      expect(mcpConfig.mcpServers["ccd-channel"].command).toBe("node");
    });

    it("preserves existing .mcp.json entries", () => {
      writeFileSync(join(WORK_DIR, ".mcp.json"), JSON.stringify({
        mcpServers: { other: { command: "other-cmd", args: [], env: {} } },
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const mcpConfig = JSON.parse(readFileSync(join(WORK_DIR, ".mcp.json"), "utf-8"));
      expect(mcpConfig.mcpServers["other"]).toBeDefined();
      expect(mcpConfig.mcpServers["ccd-channel"]).toBeDefined();
    });

    it("writes claude-settings.json with permissions allow/deny lists", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const settings = JSON.parse(readFileSync(join(TEST_DIR, "claude-settings.json"), "utf-8"));
      expect(settings.hooks).toBeUndefined();
      expect(settings.permissions.allow).toContain("Read");
      expect(settings.permissions.allow).toContain("Bash(*)");
      expect(settings.permissions.deny).toContain("Bash(rm -rf /)");
      expect(settings.permissions.defaultMode).toBe("default");
      expect(settings.statusLine).toBeDefined();
    });

    it("writes all expected MCP tool permissions", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const settings = JSON.parse(readFileSync(join(TEST_DIR, "claude-settings.json"), "utf-8"));
      expect(settings.permissions.allow).toContain("mcp__ccd-channel__reply");
      expect(settings.permissions.allow).toContain("mcp__ccd-channel__react");
      expect(settings.permissions.allow).toContain("mcp__ccd-channel__edit_message");
      expect(settings.permissions.allow).toContain("mcp__ccd-channel__download_attachment");
      expect(settings.permissions.allow).toContain("mcp__ccd-channel__create_schedule");
      expect(settings.permissions.allow).toContain("mcp__ccd-channel__list_schedules");
      expect(settings.permissions.allow).toContain("mcp__ccd-channel__update_schedule");
      expect(settings.permissions.allow).toContain("mcp__ccd-channel__delete_schedule");
    });

    it("writes statusline script", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      expect(existsSync(join(TEST_DIR, "statusline.sh"))).toBe(true);
    });
  });

  describe("getContextUsage", () => {
    it("returns percentage from statusline.json", () => {
      writeFileSync(join(TEST_DIR, "statusline.json"), JSON.stringify({
        context_window: { used_percentage: 42 },
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.getContextUsage()).toBe(42);
    });

    it("returns null when file missing", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.getContextUsage()).toBeNull();
    });
  });

  describe("getSessionId", () => {
    it("returns session_id from statusline.json", () => {
      writeFileSync(join(TEST_DIR, "statusline.json"), JSON.stringify({
        session_id: "sess-abc",
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.getSessionId()).toBe("sess-abc");
    });

    it("returns null when file missing", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      expect(backend.getSessionId()).toBeNull();
    });
  });

  describe("cleanup", () => {
    it("removes ccd-channel from .mcp.json", () => {
      writeFileSync(join(WORK_DIR, ".mcp.json"), JSON.stringify({
        mcpServers: {
          "ccd-channel": { command: "node", args: [], env: {} },
          "other": { command: "x", args: [], env: {} },
        },
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.cleanup!(makeConfig());
      const mcpConfig = JSON.parse(readFileSync(join(WORK_DIR, ".mcp.json"), "utf-8"));
      expect(mcpConfig.mcpServers["ccd-channel"]).toBeUndefined();
      expect(mcpConfig.mcpServers["other"]).toBeDefined();
    });

    it("deletes .mcp.json if ccd-channel was the only entry", () => {
      writeFileSync(join(WORK_DIR, ".mcp.json"), JSON.stringify({
        mcpServers: { "ccd-channel": { command: "node", args: [], env: {} } },
      }));
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.cleanup!(makeConfig());
      expect(existsSync(join(WORK_DIR, ".mcp.json"))).toBe(false);
    });
  });
});
