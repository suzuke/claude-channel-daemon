import { join } from "node:path";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
    let cmd = `${this.binaryPath} resume --last ${approvalFlag}`;
    if (config.model) cmd += ` -c model="${config.model}"`;
    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // Codex uses codex mcp add (global config), write a setup script
    // that registers MCP servers on first launch
    const setupScript = Object.entries(config.mcpServers).map(([name, entry]) => {
      const args = entry.args.map(a => `"${a}"`).join(" ");
      // Include AGEND_INSTANCE_NAME so MCP server identifies as this instance
      // (Codex spawns MCP servers as separate processes that don't inherit tmux shell env)
      const allEnv = { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName };
      const envFlags = Object.entries(allEnv).map(([k, v]) => `--env ${k}="${v}"`).join(" ");
      return `codex mcp add ${name} ${envFlags} -- ${entry.command} ${args} 2>/dev/null || true`;
    }).join("\n");
    writeFileSync(join(this.instanceDir, "setup-mcp.sh"), setupScript, { mode: 0o755 });

    // Run setup immediately
    try {
      execSync(`bash ${join(this.instanceDir, "setup-mcp.sh")}`, { stdio: "ignore" });
    } catch { /* best effort */ }
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
      try { execSync(`codex mcp remove ${name}`, { stdio: "ignore" }); } catch { /* best effort */ }
    }
  }
}
