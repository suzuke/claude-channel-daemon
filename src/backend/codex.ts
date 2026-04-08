import { execFileSync } from "node:child_process";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type RuntimeDialog, type StartupDialog, resolveBinary } from "./types.js";

export class CodexBackend implements CliBackend {
  readonly binaryName = "codex";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("codex");
  }

  buildCommand(config: CliBackendConfig): string {
    const approvalFlag = config.skipPermissions !== false
      ? "--dangerously-bypass-approvals-and-sandbox"
      : "--full-auto";

    // `codex resume --last` resumes the most recent session for the current
    // working directory. Each AgEnD instance has a unique working_directory,
    // so sessions are per-instance scoped and won't collide.
    // If no prior session exists (first launch), Codex falls back to a fresh session.
    let cmd: string;
    if (config.skipResume) {
      cmd = `${this.binaryPath} ${approvalFlag}`;
    } else {
      cmd = `${this.binaryPath} resume --last ${approvalFlag}`;
    }
    if (config.model) cmd += ` -c model="${config.model}"`;
    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // Codex stores MCP config globally in ~/.codex/config.toml.
    // Use execFileSync (no shell) to avoid escaping issues with env values
    // containing JSON (e.g. AGEND_DECISIONS). Use namespaced key to avoid
    // conflicts when multiple Codex instances run simultaneously.
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const mcpName = `${name}-${config.instanceName}`;
      const allEnv = { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName };
      const args = ["mcp", "add", mcpName];
      for (const [k, v] of Object.entries(allEnv)) {
        args.push("--env", `${k}=${v}`);
      }
      args.push("--", entry.command, ...entry.args);
      // Remove existing entry first (codex mcp add fails if name exists)
      try { execFileSync(this.binaryPath, ["mcp", "remove", mcpName], { stdio: "ignore" }); } catch { /* may not exist */ }
      try { execFileSync(this.binaryPath, args, { stdio: "ignore" }); } catch { /* best effort */ }
    }
    // Clean up old non-namespaced key if present (one-time migration)
    try { execFileSync(this.binaryPath, ["mcp", "remove", "agend"], { stdio: "ignore" }); } catch { /* may not exist */ }
  }

  getReadyPattern(): RegExp {
    return /% left|OpenAI Codex/m;
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /rate limit|429 Too Many Requests/i, type: "rate_limit", action: "failover", message: "OpenAI rate limit reached" },
      { pattern: /authentication|401 Unauthorized/i, type: "auth_error", action: "pause", message: "OpenAI authentication error" },
      { pattern: /insufficient_quota|billing/i, type: "quota", action: "pause", message: "OpenAI quota exceeded" },
      { pattern: /you've hit your usage limit/i, type: "quota", action: "pause", message: "Codex usage limit reached — upgrade plan required" },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      { pattern: /Yes, continue/i, keys: ["Enter"], description: "Codex 'Yes, continue' confirmation" },
    ];
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      {
        // Codex shows a model switch dialog when approaching rate limits.
        // Auto-select "Keep current model (never show again)" — option 3.
        pattern: /Approaching rate limits[\s\S]*Switch to.*for lower credit/m,
        keys: ["Down", "Down", "Enter"],
        description: "Codex rate limit model switch dialog",
      },
    ];
  }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(): string | null {
    // Codex manages sessions internally via SQLite (~/.codex/state_5.sqlite).
    // `resume --last` handles session selection by CWD automatically.
    return null;
  }

  cleanup(config: CliBackendConfig): void {
    for (const name of Object.keys(config.mcpServers)) {
      const mcpName = `${name}-${config.instanceName}`;
      try { execFileSync(this.binaryPath, ["mcp", "remove", mcpName], { stdio: "ignore" }); } catch { /* best effort */ }
    }
  }
}
