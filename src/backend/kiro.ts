import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, resolveBinary } from "./types.js";

export class KiroBackend implements CliBackend {
  readonly binaryName = "kiro-cli";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("kiro-cli");
  }

  buildCommand(config: CliBackendConfig): string {
    let cmd = `${this.binaryPath} chat`;
    if (config.skipPermissions !== false) cmd += " --trust-all-tools";
    // --resume is boolean: Kiro auto-resumes latest conversation for this working directory
    cmd += " --resume";
    if (config.model) cmd += ` --model ${config.model}`;
    cmd += " --require-mcp-startup";
    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // Kiro CLI reads workspace MCP config from .kiro/settings/mcp.json
    // Format: { "mcpServers": { "name": { command, args, env } } }
    const mcpDir = join(config.workingDirectory, ".kiro", "settings");
    mkdirSync(mcpDir, { recursive: true });
    const mcpConfigPath = join(mcpDir, "mcp.json");

    let mcpConfig: Record<string, unknown> = {};
    try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch { /* new file */ }

    // Use instance-namespaced key to avoid conflicts when multiple instances share working directory
    const servers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const instanceKey = `${name}-${config.instanceName}`;
      servers[instanceKey] = {
        command: entry.command,
        args: entry.args,
        env: { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName },
      };
    }
    // Clean up old non-namespaced key if present
    delete servers["agend"];
    mcpConfig.mcpServers = servers;

    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  }

  getReadyPattern(): RegExp {
    return /All tools are now trusted|Credits:.*Time:/m;
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /rate.?limit|429|too many requests/i, type: "rate_limit", action: "failover", message: "Rate limit reached" },
      { pattern: /auth.*error|unauthorized|401/i, type: "auth_error", action: "pause", message: "Authentication error" },
      { pattern: /usage limit|insufficient.?credit|credit.*exhaust/i, type: "quota", action: "pause", message: "Usage limit reached" },
    ];
  }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(): string | null {
    // Kiro manages sessions internally via SQLite keyed by working directory.
    // No external session ID needed — --resume handles it automatically.
    return null;
  }

  cleanup(config: CliBackendConfig): void {
    try {
      const mcpConfigPath = join(config.workingDirectory, ".kiro", "settings", "mcp.json");
      if (existsSync(mcpConfigPath)) {
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
        if (mcpConfig.mcpServers) {
          for (const name of Object.keys(config.mcpServers)) {
            delete mcpConfig.mcpServers[`${name}-${config.instanceName}`];
            delete mcpConfig.mcpServers[name]; // also clean old non-namespaced key
          }
          writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
        }
      }
    } catch { /* best effort */ }
  }
}
