import { join } from "node:path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, resolveBinary } from "./types.js";

export class OpenCodeBackend implements CliBackend {
  readonly binaryName = "opencode";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("opencode");
  }

  buildCommand(config: CliBackendConfig): string {
    // Use per-instance config via OPENCODE_CONFIG env (set in writeConfig)
    let cmd = this.binaryPath;

    // Resume last session if skipResume is not set
    if (!config.skipResume) {
      const sessionIdFile = join(this.instanceDir, "session-id");
      if (existsSync(sessionIdFile)) {
        const sid = readFileSync(sessionIdFile, "utf-8").trim();
        if (sid) cmd += ` --session ${sid}`;
      } else {
        cmd += " --continue";
      }
    }

    if (config.model) {
      cmd += ` --model ${config.model}`;
    }

    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // OpenCode reads opencode.json from the working directory.
    // Use instance-specific MCP server key name to avoid conflicts when
    // multiple instances share the same working directory.
    const configPath = join(config.workingDirectory, "opencode.json");
    let oc: Record<string, unknown> = {};
    try {
      oc = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch { /* new file */ }

    // MCP servers — use instance name as key to avoid multi-instance conflicts
    const mcp = (oc.mcp ?? {}) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const instanceKey = `${name}-${config.instanceName}`;
      mcp[instanceKey] = {
        type: "local",
        command: [entry.command, ...entry.args],
        environment: { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName },
      };
    }
    // Clean up old non-namespaced key if present
    delete mcp["agend"];
    oc.mcp = mcp;
    delete oc.mcpServers;

    // Add fleet instructions file to instructions (additive — appends to existing array)
    if (config.instructions) {
      try {
        const instrFile = join(config.instanceDir, "fleet-instructions.md");
        writeFileSync(instrFile, config.instructions);
        const paths = (oc.instructions ?? []) as string[];
        if (!paths.includes(instrFile)) paths.push(instrFile);
        oc.instructions = paths;
      } catch { /* best effort */ }
    }

    writeFileSync(configPath, JSON.stringify(oc, null, 2));
  }

  getReadyPattern(): RegExp {
    return /Ask anything|ctrl\+p commands/m;
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /rate.?limit|too many requests|429/i, type: "rate_limit", action: "failover", message: "Rate limit reached" },
      { pattern: /auth.*error|unauthorized|401/i, type: "auth_error", action: "pause", message: "Authentication error" },
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

  getQuitCommand(): string { return "/quit"; }

  cleanup(config: CliBackendConfig): void {
    // Clean up instance-specific MCP entries from opencode.json.
    // Only remove namespaced keys — non-namespaced "agend" key may belong to
    // another instance sharing this working directory.
    try {
      const configPath = join(config.workingDirectory, "opencode.json");
      if (existsSync(configPath)) {
        const oc = JSON.parse(readFileSync(configPath, "utf-8"));
        if (oc.mcp) {
          for (const name of Object.keys(config.mcpServers)) {
            delete oc.mcp[`${name}-${config.instanceName}`];
          }
        }
        // Remove fleet instructions path from instructions
        const instrFile = join(config.instanceDir, "fleet-instructions.md");
        if (Array.isArray(oc.instructions)) {
          oc.instructions = oc.instructions.filter((p: string) => p !== instrFile);
        }
        writeFileSync(configPath, JSON.stringify(oc, null, 2));
      }
    } catch { /* best effort */ }

    // Remove fleet instructions file
    try {
      const instrFile = join(config.instanceDir, "fleet-instructions.md");
      if (existsSync(instrFile)) unlinkSync(instrFile);
    } catch { /* best effort */ }
  }
}
