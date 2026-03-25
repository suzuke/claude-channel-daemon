import type { TmuxManager } from "../tmux-manager.js";

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
}

export interface CliBackend {
  /** Build the shell command string to launch the CLI in a tmux window. */
  buildCommand(config: CliBackendConfig): string;

  /** Write all config files the CLI needs before launch. */
  writeConfig(config: CliBackendConfig): void;

  /** Read context window usage percentage (0-100). Returns null if unavailable. */
  getContextUsage(): number | null;

  /** Read session ID for resume capability. Returns null if unavailable. */
  getSessionId(): string | null;

  /** Post-launch setup (e.g., auto-confirm prompts). Called after CLI spawns in tmux. */
  postLaunch?(tmux: TmuxManager, windowId: string): Promise<void>;

  /** Clean up config files on shutdown. */
  cleanup?(config: CliBackendConfig): void;
}
