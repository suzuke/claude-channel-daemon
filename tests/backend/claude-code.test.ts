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
    it("includes --mcp-config and --dangerously-skip-permissions", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--mcp-config");
      expect(cmd).toContain("mcp-config.json");
      expect(cmd).toContain("--dangerously-skip-permissions");
    });

    it("does not include --dangerously-load-development-channels", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).not.toContain("--dangerously-load-development-channels");
    });

    it("includes --resume when session-id file exists", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "sess-123");
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--resume sess-123");
    });

    it("includes --system-prompt when systemPrompt is set", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ systemPrompt: "You are a debater." }));
      expect(cmd).toContain("--system-prompt");
      expect(readFileSync(join(TEST_DIR, "system-prompt.md"), "utf-8")).toBe("You are a debater.");
    });

    it("includes --model when model is set", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ model: "opus" }));
      expect(cmd).toContain("--model opus");
    });
  });

  describe("writeConfig", () => {
    it("writes mcp-config.json to instance dir", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const mcpConfig = JSON.parse(readFileSync(join(TEST_DIR, "mcp-config.json"), "utf-8"));
      expect(mcpConfig.mcpServers["ccd-channel"]).toBeDefined();
      expect(mcpConfig.mcpServers["ccd-channel"].command).toBe("node");
    });

    it("does not write .mcp.json to working directory", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      expect(existsSync(join(WORK_DIR, ".mcp.json"))).toBe(false);
    });

    it("writes claude-settings.json with statusLine only (no permissions)", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const settings = JSON.parse(readFileSync(join(TEST_DIR, "claude-settings.json"), "utf-8"));
      expect(settings.statusLine).toBeDefined();
      expect(settings.permissions).toBeUndefined();
    });

    it("writes statusline script", () => {
      const backend = new ClaudeCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      expect(existsSync(join(TEST_DIR, "statusline.js"))).toBe(true);
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
  });
});
