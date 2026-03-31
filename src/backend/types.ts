import { execFileSync } from "node:child_process";

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CliBackendConfig {
  workingDirectory: string;
  instanceDir: string;
  instanceName: string;
  mcpServers: Record<string, McpServerEntry>;
  systemPrompt?: string;
  skipPermissions?: boolean;
  model?: string;
}

export interface CliBackend {
  /** The CLI binary name (e.g. "claude", "gemini", "codex") */
  readonly binaryName: string;

  /** Build the shell command string to launch the CLI in a tmux window. */
  buildCommand(config: CliBackendConfig): string;

  /** Write all config files the CLI needs before launch. */
  writeConfig(config: CliBackendConfig): void;

  /** Read context window usage percentage (0-100). Returns null if unavailable. */
  getContextUsage(): number | null;

  /** Read session ID for resume capability. Returns null if unavailable. */
  getSessionId(): string | null;

  /** Clean up config files on shutdown. */
  cleanup?(config: CliBackendConfig): void;
}

/**
 * Resolve the full path to a CLI binary.
 * tmux new-window runs commands in a minimal shell without user PATH,
 * so we resolve at daemon startup time when the full PATH is available.
 */
export function resolveBinary(name: string): string {
  try {
    return execFileSync("which", [name], { encoding: "utf-8" }).trim();
  } catch {
    return name; // fallback to bare name
  }
}
