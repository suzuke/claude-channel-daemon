import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Daemon } from "../src/daemon.js";
import type { InstanceConfig } from "../src/types.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { GeminiCliBackend } from "../src/backend/gemini-cli.js";
import { CodexBackend } from "../src/backend/codex.js";
import { KiroBackend } from "../src/backend/kiro.js";
import { OpenCodeBackend } from "../src/backend/opencode.js";
import { MockBackend } from "../src/backend/mock.js";
import type { CliBackend, CliBackendConfig } from "../src/backend/types.js";

// Bug #55 regression: verify daemon.buildBackendConfig only injects fleet
// context env vars (display_name, description, workflow, custom prompt,
// decisions) into the MCP server when the backend has no native injection
// mechanism. Backends with native injection should receive
// AGEND_DISABLE_MCP_INSTRUCTIONS=1 instead, so the MCP server omits its
// `instructions` capability.

const FLEET_CONTEXT_KEYS = [
  "AGEND_DISPLAY_NAME",
  "AGEND_DESCRIPTION",
  "AGEND_WORKFLOW",
  "AGEND_CUSTOM_PROMPT",
  "AGEND_DECISIONS",
] as const;

function makeConfig(overrides?: Partial<InstanceConfig>): InstanceConfig {
  return {
    working_directory: "/tmp/test-bb-config",
    display_name: "TestAgent",
    description: "for testing dual-injection gate",
    systemPrompt: "Be terse.",
    workflow: "## inline workflow",
    restart_policy: { max_retries: 1, backoff: "exponential", reset_after: 60 },
    context_guardian: { grace_period_ms: 0, max_age_hours: 1 },
    log_level: "warn",
    ...overrides,
  } as InstanceConfig;
}

interface BackendCase {
  label: string;
  make: (instanceDir: string) => CliBackend;
  expectedMech: "append-flag" | "project-doc" | "none";
}

const cases: BackendCase[] = [
  { label: "claude-code",  make: (d) => new ClaudeCodeBackend(d), expectedMech: "append-flag" },
  { label: "opencode",     make: (d) => new OpenCodeBackend(d),   expectedMech: "append-flag" },
  { label: "gemini-cli",   make: (d) => new GeminiCliBackend(d),  expectedMech: "project-doc" },
  { label: "codex",        make: (d) => new CodexBackend(d),      expectedMech: "project-doc" },
  { label: "kiro-cli",     make: (d) => new KiroBackend(d),       expectedMech: "project-doc" },
  { label: "mock",         make: (d) => new MockBackend(d),       expectedMech: "none" },
];

describe("Daemon.buildBackendConfig — Bug #55 fleet context gate", () => {
  let instanceDir: string;
  let prevDecisions: string | undefined;

  beforeEach(() => {
    instanceDir = join(tmpdir(), `ccd-bb-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(instanceDir, { recursive: true });
    // Simulate fleet-manager.ts:440 setting AGEND_DECISIONS for the daemon
    prevDecisions = process.env.AGEND_DECISIONS;
    process.env.AGEND_DECISIONS = JSON.stringify([{ title: "scope", content: "test scope" }]);
  });

  afterEach(() => {
    rmSync(instanceDir, { recursive: true, force: true });
    if (prevDecisions === undefined) delete process.env.AGEND_DECISIONS;
    else process.env.AGEND_DECISIONS = prevDecisions;
  });

  for (const c of cases) {
    it(`${c.label}: native=${c.expectedMech} → MCP env follows the gate`, () => {
      const backend = c.make(instanceDir);
      const daemon = new Daemon("test-bb", makeConfig(), instanceDir, false, backend);
      const cfg: CliBackendConfig = (daemon as unknown as { buildBackendConfig(): CliBackendConfig }).buildBackendConfig();
      const env = cfg.mcpServers["agend"]?.env ?? {};

      // Identity / operational vars are always present
      expect(env.AGEND_INSTANCE_NAME).toBe("test-bb");
      expect(env.AGEND_WORKING_DIR).toBe("/tmp/test-bb-config");
      expect(env.AGEND_SOCKET_PATH).toBeTruthy();

      // Backend always receives the assembled instructions string for native injection
      expect(cfg.instructions).toBeTruthy();
      expect(cfg.instructions).toContain("test-bb");

      if (c.expectedMech === "none") {
        // No native injection → MCP instructions capability stays active.
        expect(env.AGEND_DISABLE_MCP_INSTRUCTIONS).toBeUndefined();
        // All fleet context env vars present so MCP server can rebuild instructions.
        expect(env.AGEND_DISPLAY_NAME).toBe("TestAgent");
        expect(env.AGEND_DESCRIPTION).toBe("for testing dual-injection gate");
        expect(env.AGEND_WORKFLOW).toBeTruthy();
        expect(env.AGEND_CUSTOM_PROMPT).toBe("Be terse.");
        expect(env.AGEND_DECISIONS).toBeTruthy();
      } else {
        // Native injection present → MCP instructions capability disabled, fleet
        // context env vars dropped to avoid duplicate injection.
        expect(env.AGEND_DISABLE_MCP_INSTRUCTIONS).toBe("1");
        for (const key of FLEET_CONTEXT_KEYS) {
          expect(env[key], `${c.label}: ${key} must NOT be passed when backend injects natively`).toBeUndefined();
        }
      }
    });
  }
});
