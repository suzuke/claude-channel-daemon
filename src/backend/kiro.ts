import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, resolveBinary } from "./types.js";

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
    if (!config.skipResume) cmd += " --resume";
    if (config.model) cmd += ` --model ${config.model}`;
    cmd += " --require-mcp-startup";
    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // Kiro CLI reads workspace MCP config from .kiro/settings/mcp.json
    // Format: { "mcpServers": { "name": { command, args, env } } }
    //
    // WORKAROUND: kiro-cli ignores the "env" block in mcp.json — the MCP server
    // subprocess inherits the fleet manager's process env, which has a stale
    // AGEND_SOCKET_PATH from whichever daemon wrote to it last.
    // Fix: generate a wrapper script that exports the correct env vars before
    // exec-ing the real MCP server.
    const mcpDir = join(config.workingDirectory, ".kiro", "settings");
    mkdirSync(mcpDir, { recursive: true });
    const mcpConfigPath = join(mcpDir, "mcp.json");

    let mcpConfig: Record<string, unknown> = {};
    try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch { /* new file */ }

    const servers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>;
    // Remove stale agend entries whose wrapper scripts no longer exist
    for (const [key, val] of Object.entries(servers)) {
      if (key.startsWith("agend-")) {
        const cmd = (val as Record<string, unknown>)?.command;
        if (typeof cmd === "string" && !existsSync(cmd)) {
          delete servers[key];
        }
      }
    }
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const instanceKey = `${name}-${config.instanceName}`;
      const allEnv = { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName };

      // Write a wrapper script that sets env vars explicitly
      const wrapperPath = join(this.instanceDir, `mcp-wrapper-${name}.sh`);
      const envExports = Object.entries(allEnv)
        .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`)
        .join("\n");
      writeFileSync(wrapperPath, `#!/bin/bash\n${envExports}\n# Wait for IPC socket to be ready (up to 10s)\nfor i in $(seq 1 20); do [ -S "$AGEND_SOCKET_PATH" ] && break; sleep 0.5; done\nexec ${entry.command} ${entry.args.map((a: string) => JSON.stringify(a)).join(" ")}\n`);
      chmodSync(wrapperPath, 0o755);

      servers[instanceKey] = {
        command: wrapperPath,
        args: [],
      };
    }
    // Clean up old non-namespaced key if present
    delete servers["agend"];
    mcpConfig.mcpServers = servers;

    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // Write fleet instructions to .kiro/steering/ (auto-loaded by Kiro CLI)
    if (config.instructions) {
      try {
        const steeringDir = join(config.workingDirectory, ".kiro", "steering");
        mkdirSync(steeringDir, { recursive: true });
        writeFileSync(join(steeringDir, `agend-${config.instanceName}.md`), config.instructions);
      } catch { /* best effort */ }
    }
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

  getQuitCommand(): string { return "/quit"; }

  cleanup(config: CliBackendConfig): void {
    // Only remove namespaced keys — non-namespaced "agend" key may belong to
    // another instance sharing this working directory.
    try {
      const mcpConfigPath = join(config.workingDirectory, ".kiro", "settings", "mcp.json");
      if (existsSync(mcpConfigPath)) {
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
        if (mcpConfig.mcpServers) {
          for (const name of Object.keys(config.mcpServers)) {
            delete mcpConfig.mcpServers[`${name}-${config.instanceName}`];
          }
          writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
        }
      }
    } catch { /* best effort */ }

    // Remove fleet instructions steering file
    try {
      const steeringFile = join(config.workingDirectory, ".kiro", "steering", `agend-${config.instanceName}.md`);
      if (existsSync(steeringFile)) unlinkSync(steeringFile);
    } catch { /* best effort */ }
  }
}
