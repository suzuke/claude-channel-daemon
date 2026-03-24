import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeBackend } from "../../src/backend/claude-code.js";
import { MessageBus } from "../../src/channel/message-bus.js";
import { HookBasedApproval } from "../../src/backend/hook-based-approval.js";
import type { CliBackendConfig } from "../../src/backend/types.js";

const TEST_DIR = "/tmp/ccd-test-claude-backend";
const WORK_DIR = "/tmp/ccd-test-workdir";

function makeConfig(overrides?: Partial<CliBackendConfig>): CliBackendConfig {
  const bus = new MessageBus();
  return {
    workingDirectory: WORK_DIR,
    instanceDir: TEST_DIR,
    instanceName: "test",
    approvalPort: 18400,
    mcpServers: {
      "ccd-channel": {
        command: "node",
        args: ["/path/to/mcp-server.js"],
        env: { CCD_SOCKET_PATH: "/tmp/test.sock" },
      },
    },
    approvalStrategy: new HookBasedApproval({ messageBus: bus, port: 18400 }),
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

    it("writes claude-settings.json with hooks and permissions", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const settings = JSON.parse(readFileSync(join(TEST_DIR, "claude-settings.json"), "utf-8"));
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.permissions.allow).toContain("Read");
      expect(settings.permissions.allow).toContain("Bash(*)");
      expect(settings.statusLine).toBeDefined();
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
