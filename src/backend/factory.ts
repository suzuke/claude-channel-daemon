import type { CliBackend } from "./types.js";
import { ClaudeCodeBackend } from "./claude-code.js";
import { GeminiCliBackend } from "./gemini-cli.js";
import { CodexBackend } from "./codex.js";
import { OpenCodeBackend } from "./opencode.js";
import { KiroBackend } from "./kiro.js";
import { MockBackend } from "./mock.js";

export function createBackend(name: string, instanceDir: string): CliBackend {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeBackend(instanceDir);
    case "gemini-cli":
      return new GeminiCliBackend(instanceDir);
    case "codex":
      return new CodexBackend(instanceDir);
    case "opencode":
      return new OpenCodeBackend(instanceDir);
    case "kiro-cli":
      return new KiroBackend(instanceDir);
    case "mock":
      return new MockBackend(instanceDir);
    default:
      throw new Error(`Unknown backend: ${name}. Available: claude-code, gemini-cli, codex, opencode, kiro-cli, mock`);
  }
}
