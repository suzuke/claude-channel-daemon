import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, resolveBinary } from "./types.js";

export class OpenCodeBackend implements CliBackend {
  readonly binaryName = "opencode";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("opencode");
  }

  buildCommand(config: CliBackendConfig): string {
    // Use per-instance config via OPENCODE_CONFIG env (set in writeConfig)
    let cmd = this.binaryPath;

    // Resume last session if session-id exists
    const sessionIdFile = join(this.instanceDir, "session-id");
    if (existsSync(sessionIdFile)) {
      const sid = readFileSync(sessionIdFile, "utf-8").trim();
      if (sid) cmd += ` --session ${sid}`;
    } else {
      // No specific session — continue last (OpenCode auto-selects)
      cmd += " --continue";
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

    // System prompt — write to instance dir (absolute path)
    if (config.systemPrompt) {
      const promptPath = join(this.instanceDir, ".opencode-instructions.md");
      mkdirSync(dirname(promptPath), { recursive: true });
      writeFileSync(promptPath, config.systemPrompt);
      oc.instructions = [promptPath];
    }

    writeFileSync(configPath, JSON.stringify(oc, null, 2));
  }

  getReadyPattern(): RegExp {
    return /Ask anything|ctrl\+p commands/m;
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
    // Clean up instance-specific MCP entries from opencode.json
    try {
      const configPath = join(config.workingDirectory, "opencode.json");
      if (existsSync(configPath)) {
        const oc = JSON.parse(readFileSync(configPath, "utf-8"));
        if (oc.mcp) {
          for (const name of Object.keys(config.mcpServers)) {
            delete oc.mcp[`${name}-${config.instanceName}`];
            delete oc.mcp[name]; // also clean old non-namespaced key
          }
          writeFileSync(configPath, JSON.stringify(oc, null, 2));
        }
      }
    } catch { /* best effort */ }
  }
}
