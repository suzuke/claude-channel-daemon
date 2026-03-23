import type { CliBackend } from "./types.js";
import { ClaudeCodeBackend } from "./claude-code.js";

export function createBackend(name: string, instanceDir: string): CliBackend {
  switch (name) {
    case "claude-code":
      return new ClaudeCodeBackend(instanceDir);
    default:
      throw new Error(`Unknown backend: ${name}. Available: claude-code`);
  }
}
