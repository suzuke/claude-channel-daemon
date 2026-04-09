import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OpenCodeBackend } from "../../src/backend/opencode.js";
import type { CliBackendConfig } from "../../src/backend/types.js";

const TEST_DIR = "/tmp/ccd-test-opencode-backend";
const WORK_DIR = "/tmp/ccd-test-opencode-workdir";

function makeConfig(overrides?: Partial<CliBackendConfig>): CliBackendConfig {
  return {
    workingDirectory: WORK_DIR,
    instanceDir: TEST_DIR,
    instanceName: "test-oc",
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

describe("OpenCodeBackend", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(WORK_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  describe("writeConfig", () => {
    it("writes fleet-instructions.md and adds to instructions", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet Context" }));
      const instrFile = join(TEST_DIR, "fleet-instructions.md");
      expect(existsSync(instrFile)).toBe(true);
      expect(readFileSync(instrFile, "utf-8")).toContain("# Fleet Context");
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.instructions).toContain(instrFile);
    });

    it("does not add instructions when instructions absent", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.instructions).toBeUndefined();
    });

    it("preserves existing instructions", () => {
      writeFileSync(join(WORK_DIR, "opencode.json"), JSON.stringify({ instructions: ["/existing/path.md"] }));
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet" }));
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.instructions).toContain("/existing/path.md");
      expect(oc.instructions).toContain(join(TEST_DIR, "fleet-instructions.md"));
    });
  });

  describe("cleanup", () => {
    it("removes instructions entry and deletes instructions file", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet" }));
      const instrFile = join(TEST_DIR, "fleet-instructions.md");
      expect(existsSync(instrFile)).toBe(true);
      backend.cleanup(makeConfig());
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.instructions).not.toContain(instrFile);
      expect(existsSync(instrFile)).toBe(false);
    });

    it("preserves other instructions entries", () => {
      writeFileSync(join(WORK_DIR, "opencode.json"), JSON.stringify({ instructions: ["/keep/this.md"] }));
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet" }));
      backend.cleanup(makeConfig());
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.instructions).toContain("/keep/this.md");
    });
  });
});
