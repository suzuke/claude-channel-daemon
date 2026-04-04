import { join } from "node:path";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type RuntimeDialog, resolveBinary } from "./types.js";

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

    // Check for existing session to resume
    const sessionIdFile = join(this.instanceDir, "session-id");
    if (existsSync(sessionIdFile)) {
      const sid = readFileSync(sessionIdFile, "utf-8").trim();
      if (sid && /^[a-zA-Z0-9_-]+$/.test(sid)) {
        let cmd = `${this.binaryPath} resume ${sid} ${approvalFlag}`;
        if (config.model) cmd += ` -c model="${config.model}"`;
        return cmd;
      }
    }

    let cmd = `${this.binaryPath} ${approvalFlag}`;
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
    try {
      const f = join(this.instanceDir, "session-id");
      return readFileSync(f, "utf-8").trim() || null;
    } catch { return null; }
  }

  cleanup(config: CliBackendConfig): void {
    for (const name of Object.keys(config.mcpServers)) {
      try { execSync(`codex mcp remove ${name}`, { stdio: "ignore" }); } catch { /* best effort */ }
    }
  }
}
