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
    it("writes fleet-instructions.md and adds to contextPaths", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet Context" }));
      const instrFile = join(TEST_DIR, "fleet-instructions.md");
      expect(existsSync(instrFile)).toBe(true);
      expect(readFileSync(instrFile, "utf-8")).toContain("# Fleet Context");
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.contextPaths).toContain(instrFile);
    });

    it("does not add contextPaths when instructions absent", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig());
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.contextPaths).toBeUndefined();
    });

    it("preserves existing contextPaths", () => {
      writeFileSync(join(WORK_DIR, "opencode.json"), JSON.stringify({ contextPaths: ["/existing/path.md"] }));
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet" }));
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.contextPaths).toContain("/existing/path.md");
      expect(oc.contextPaths).toContain(join(TEST_DIR, "fleet-instructions.md"));
    });
  });

  describe("cleanup", () => {
    it("removes contextPaths entry and deletes instructions file", () => {
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet" }));
      const instrFile = join(TEST_DIR, "fleet-instructions.md");
      expect(existsSync(instrFile)).toBe(true);
      backend.cleanup(makeConfig());
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.contextPaths).not.toContain(instrFile);
      expect(existsSync(instrFile)).toBe(false);
    });

    it("preserves other contextPaths entries", () => {
      writeFileSync(join(WORK_DIR, "opencode.json"), JSON.stringify({ contextPaths: ["/keep/this.md"] }));
      const backend = new OpenCodeBackend(TEST_DIR);
      backend.writeConfig(makeConfig({ instructions: "# Fleet" }));
      backend.cleanup(makeConfig());
      const oc = JSON.parse(readFileSync(join(WORK_DIR, "opencode.json"), "utf-8"));
      expect(oc.contextPaths).toContain("/keep/this.md");
    });
  });
});
