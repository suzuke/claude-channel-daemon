import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { CodexBackend } from "../../src/backend/codex.js";
import type { CliBackendConfig } from "../../src/backend/types.js";

const TEST_DIR = "/tmp/ccd-test-codex-backend";
const WORK_DIR = "/tmp/ccd-test-codex-workdir";

function makeConfig(overrides?: Partial<CliBackendConfig>): CliBackendConfig {
  return {
    workingDirectory: WORK_DIR,
    instanceDir: TEST_DIR,
    instanceName: "test-codex",
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

describe("CodexBackend", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(WORK_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  describe("buildCommand", () => {
    it("always uses resume --last (resumes latest session for CWD)", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("resume --last");
      expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("includes model config", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ model: "o3" }));
      expect(cmd).toContain("resume --last");
      expect(cmd).toContain('-c model="o3"');
    });

    it("uses --full-auto when skipPermissions is false", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ skipPermissions: false }));
      expect(cmd).toContain("--full-auto");
      expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });
  });

  describe("getSessionId", () => {
    it("returns null (Codex manages sessions internally)", () => {
      const backend = new CodexBackend(TEST_DIR);
      expect(backend.getSessionId()).toBeNull();
    });
  });
});
