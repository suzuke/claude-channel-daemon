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
  /** Fleet instructions content to inject into the CLI's additive system prompt mechanism. */
  instructions?: string;
  /** Agent communication mode: "mcp" (default) or "cli" (HTTP endpoint). */
  agentMode?: "mcp" | "cli";
  /** Health server port for CLI mode (agend-agent connects here). */
  agentPort?: number;
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

  /** Whether this backend re-reads instruction files on --resume (e.g. Claude Code's --append-system-prompt-file). */
  readonly instructionsReloadedOnResume?: boolean;

  /**
   * How this backend natively injects fleet instructions into the CLI's prompt:
   * - `'append-flag'`: dedicated CLI flag / config field pointing at a file outside
   *   the workspace (e.g. Claude `--append-system-prompt-file`, OpenCode
   *   `instructions: [path]`). Cleanest, no workspace-visible artefact.
   * - `'project-doc'`: workspace markdown the CLI auto-loads (e.g. Gemini
   *   `GEMINI.md`, Codex `AGENTS.md`, Kiro `.kiro/steering/`).
   * - `'none'`: no native mechanism — daemon must rely on the MCP `instructions`
   *   capability to deliver fleet context.
   *
   * Daemon uses this to gate the MCP `instructions` capability: backends that
   * already inject natively must NOT also receive the same content via MCP, or
   * the model sees it twice (Bug #55).
   */
  readonly nativeInstructionsMechanism: "append-flag" | "project-doc" | "none";

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

/**
 * Whitelist for model names embedded into the shell command line.
 * Allows letters, digits, dot, underscore, hyphen, colon, slash
 * (e.g. "claude-3-5-sonnet", "gpt-4o-mini-2024-07-18", "openrouter/anthropic:beta").
 * Throws if `model` contains anything else, since `buildCommand` returns a
 * shell string consumed by tmux and we cannot rely on argv-style quoting.
 */
const SAFE_MODEL_RE = /^[A-Za-z0-9._:/-]+$/;
export function validateModel(model: string): string {
  if (!SAFE_MODEL_RE.test(model)) {
    throw new Error(`Invalid model name: ${JSON.stringify(model)} — must match ${SAFE_MODEL_RE}`);
  }
  return model;
}

/** POSIX single-quote escape for embedding arbitrary values in a shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
