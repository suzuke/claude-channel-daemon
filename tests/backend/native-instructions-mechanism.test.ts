import { describe, it, expect } from "vitest";
import { ClaudeCodeBackend } from "../../src/backend/claude-code.js";
import { GeminiCliBackend } from "../../src/backend/gemini-cli.js";
import { CodexBackend } from "../../src/backend/codex.js";
import { KiroBackend } from "../../src/backend/kiro.js";
import { OpenCodeBackend } from "../../src/backend/opencode.js";
import { MockBackend } from "../../src/backend/mock.js";

// Bug #55: every backend must declare how it natively delivers fleet
// instructions. Daemon uses this to decide whether to also expose the MCP
// `instructions` capability — otherwise the same content is injected twice.
describe("CliBackend.nativeInstructionsMechanism (Bug #55)", () => {
  it("Claude uses --append-system-prompt-file (append-flag)", () => {
    const b = new ClaudeCodeBackend("/tmp/test-instance");
    expect(b.nativeInstructionsMechanism).toBe("append-flag");
  });

  it("OpenCode uses opencode.json instructions array (append-flag)", () => {
    const b = new OpenCodeBackend("/tmp/test-instance");
    expect(b.nativeInstructionsMechanism).toBe("append-flag");
  });

  it("Gemini writes GEMINI.md (project-doc)", () => {
    const b = new GeminiCliBackend("/tmp/test-instance");
    expect(b.nativeInstructionsMechanism).toBe("project-doc");
  });

  it("Codex writes AGENTS.md (project-doc)", () => {
    const b = new CodexBackend("/tmp/test-instance");
    expect(b.nativeInstructionsMechanism).toBe("project-doc");
  });

  it("Kiro writes .kiro/steering/ (project-doc)", () => {
    const b = new KiroBackend("/tmp/test-instance");
    expect(b.nativeInstructionsMechanism).toBe("project-doc");
  });

  it("Mock backend has no native injection (none)", () => {
    const b = new MockBackend("/tmp/test-instance");
    expect(b.nativeInstructionsMechanism).toBe("none");
  });
});
