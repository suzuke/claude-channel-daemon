import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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
    it("generates fresh session command when no session-id exists", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("codex");
      expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(cmd).not.toContain("resume");
    });

    it("generates resume command when session-id file exists", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "sess-abc-123");
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).toContain("resume sess-abc-123");
      expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("falls back to fresh session when session-id is invalid", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "invalid id with spaces!");
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).not.toContain("resume");
      expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("falls back to fresh session when session-id file is empty", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "  \n");
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig());
      expect(cmd).not.toContain("resume");
    });

    it("includes model config when model is set", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ model: "o3" }));
      expect(cmd).toContain('-c model="o3"');
    });

    it("includes model config in resume command", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "sess-xyz");
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ model: "o3" }));
      expect(cmd).toContain("resume sess-xyz");
      expect(cmd).toContain('-c model="o3"');
    });

    it("uses --full-auto when skipPermissions is false", () => {
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ skipPermissions: false }));
      expect(cmd).toContain("--full-auto");
      expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("uses --full-auto in resume mode when skipPermissions is false", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "sess-abc");
      const backend = new CodexBackend(TEST_DIR);
      const cmd = backend.buildCommand(makeConfig({ skipPermissions: false }));
      expect(cmd).toContain("resume sess-abc");
      expect(cmd).toContain("--full-auto");
      expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });
  });

  describe("getSessionId", () => {
    it("returns session-id from file", () => {
      writeFileSync(join(TEST_DIR, "session-id"), "sess-123");
      const backend = new CodexBackend(TEST_DIR);
      expect(backend.getSessionId()).toBe("sess-123");
    });

    it("returns null when file missing", () => {
      const backend = new CodexBackend(TEST_DIR);
      expect(backend.getSessionId()).toBeNull();
    });
  });
});
