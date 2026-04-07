import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { KiroBackend } from "../../src/backend/kiro.js";
import type { CliBackendConfig } from "../../src/backend/types.js";

const TEST_DIR = "/tmp/ccd-test-kiro-backend";
const WORK_DIR = "/tmp/ccd-test-kiro-workdir";

function makeConfig(overrides?: Partial<CliBackendConfig>): CliBackendConfig {
  return {
    workingDirectory: WORK_DIR,
    instanceDir: TEST_DIR,
    instanceName: "test-kiro",
    mcpServers: {
      "agend": {
        command: "node",
        args: ["/path/to/mcp-server.js"],
        env: { AGEND_SOCKET_PATH: "/tmp/test.sock" },
      },
    },
    ...overrides,
  };
}

describe("KiroBackend", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(WORK_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  describe("buildCommand", () => {
    it("generates chat command with --trust-all-tools and --resume", () => {
      const backend = new KiroBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("chat");
      expect(cmd).toContain("--trust-all-tools");
      expect(cmd).toContain("--resume");
      expect(cmd).toContain("--require-mcp-startup");
    });

    it("always includes --resume (boolean flag, resumes latest session for CWD)", () => {
      const backend = new KiroBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("--resume");
    });

    it("includes --model when model is set", () => {
      const backend = new KiroBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ model: "claude-sonnet-4.5" }));
      expect(cmd).toContain("--model claude-sonnet-4.5");
    });

    it("omits --trust-all-tools when skipPermissions is false", () => {
      const backend = new KiroBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ skipPermissions: false }));
      expect(cmd).not.toContain("--trust-all-tools");
    });
  });

  describe("writeConfig", () => {
    it("writes mcp.json to .kiro/settings/ in working directory", () => {
      const backend = new KiroBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const mcpConfigPath = join(WORK_DIR, ".kiro", "settings", "mcp.json");
      expect(existsSync(mcpConfigPath)).toBe(true);
      const config = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
      expect(config.mcpServers["agend-test-kiro"]).toBeDefined();
      expect(config.mcpServers["agend-test-kiro"].command).toBe("node");
    });

    it("uses instance-namespaced key to avoid conflicts", () => {
      const backend = new KiroBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instanceName: "instance-a" }));
      backend.writeConfig(makeConfig({ instanceName: "instance-b" }));
      const config = JSON.parse(readFileSync(join(WORK_DIR, ".kiro", "settings", "mcp.json"), "utf-8"));
      expect(config.mcpServers["agend-instance-a"]).toBeDefined();
      expect(config.mcpServers["agend-instance-b"]).toBeDefined();
    });

    it("cleans up old non-namespaced key", () => {
      const mcpDir = join(WORK_DIR, ".kiro", "settings");
      mkdirSync(mcpDir, { recursive: true });
      writeFileSync(join(mcpDir, "mcp.json"), JSON.stringify({ mcpServers: { agend: { command: "old" } } }));
      const backend = new KiroBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const config = JSON.parse(readFileSync(join(mcpDir, "mcp.json"), "utf-8"));
      expect(config.mcpServers["agend"]).toBeUndefined();
      expect(config.mcpServers["agend-test-kiro"]).toBeDefined();
    });
  });

  describe("cleanup", () => {
    it("removes instance MCP entry from mcp.json", () => {
      const backend = new KiroBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      backend.cleanup(makeConfig());
      const config = JSON.parse(readFileSync(join(WORK_DIR, ".kiro", "settings", "mcp.json"), "utf-8"));
      expect(config.mcpServers["agend-test-kiro"]).toBeUndefined();
    });
  });

  describe("getSessionId", () => {
    it("returns null (Kiro manages sessions internally)", () => {
      const backend = new KiroBackend(TEST_DIR);
      expect(backend.getSessionId()).toBeNull();
    });
  });

  describe("getContextUsage", () => {
    it("returns null (not supported)", () => {
      const backend = new KiroBackend(TEST_DIR);
      expect(backend.getContextUsage()).toBeNull();
    });
  });
});
