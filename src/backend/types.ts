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
  skipPermissions?: boolean;
  model?: string;
  /** When true, backend should not resume a previous session (crash recovery). */
  skipResume?: boolean;
}

/** Action to take when an error pattern is detected in PTY output. */
export type ErrorActionType = "notify" | "failover" | "restart" | "pause";

/** Categorizes detected errors for logging and response. */
export type ErrorType = "rate_limit" | "auth_error" | "crash" | "network" | "quota";

export interface ErrorPattern {
  pattern: RegExp;
  type: ErrorType;
  action: ErrorActionType;
  /** Human-readable description for notifications. */
  message: string;
}

/** A dialog that may appear at runtime and needs auto-dismissal via key sequences. */
export interface RuntimeDialog {
  /** Pattern to detect the dialog in PTY output. */
  pattern: RegExp;
  /** Key sequence to dismiss: strings are literal text, "Up"/"Down"/"Enter"/"Escape" are special keys. */
  keys: string[];
  /** Human-readable description for logging. */
  description: string;
}

/** A dialog that may appear during CLI startup (trust prompts, session pickers, etc.). */
export type StartupDialog = RuntimeDialog;

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

  /** Regex to detect when the CLI is ready to accept input. */
  getReadyPattern(): RegExp;

  /** Error patterns to detect in PTY output during operation. */
  getErrorPatterns?(): ErrorPattern[];

  /**
   * Interactive dialogs that can appear during operation (not just startup).
   * The daemon's error monitor auto-dismisses these by sending the specified keys.
   */
  getRuntimeDialogs?(): RuntimeDialog[];

  /**
   * Dialogs that may appear during CLI startup (trust prompts, confirmation dialogs).
   * The daemon's dismissDialogsUntilReady auto-dismisses these before the CLI is ready.
   */
  getStartupDialogs?(): StartupDialog[];

  /** Pre-approve a working directory to skip trust dialogs on startup. */
  preTrust?(workingDirectory: string): void;

  /** Command to gracefully quit the CLI (e.g. "/exit", "/quit"). */
  getQuitCommand(): string;

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
