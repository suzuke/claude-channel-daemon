import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type CliBackend, type CliBackendConfig, resolveBinary } from "./types.js";

export class OpenCodeBackend implements CliBackend {
  readonly binaryName = "opencode";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("opencode");
  }

  buildCommand(_config: CliBackendConfig): string {
    return this.binaryPath;
  }

  writeConfig(config: CliBackendConfig): void {
    // OpenCode uses opencode.json in the working directory
    const configPath = join(config.workingDirectory, "opencode.json");
    let oc: Record<string, unknown> = {};
    try {
      oc = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch { /* new file */ }

    // MCP servers — OpenCode uses "mcpServers" with stdio format
    oc.mcpServers = {};
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      (oc.mcpServers as Record<string, unknown>)[name] = {
        type: "stdio",
        command: entry.command,
        args: entry.args,
        env: Object.entries(entry.env || {}).map(([k, v]) => `${k}=${v}`),
      };
    }

    // System prompt — write to file and reference via instructions array
    if (config.systemPrompt) {
      const promptPath = join(config.workingDirectory, ".opencode-instructions.md");
      writeFileSync(promptPath, config.systemPrompt);
      oc.instructions = [".opencode-instructions.md"];
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
    // Clean up opencode.json MCP entries
    try {
      const configPath = join(config.workingDirectory, "opencode.json");
      if (existsSync(configPath)) {
        const oc = JSON.parse(readFileSync(configPath, "utf-8"));
        if (oc.mcpServers) {
          for (const name of Object.keys(config.mcpServers)) {
            delete oc.mcpServers[name];
          }
          writeFileSync(configPath, JSON.stringify(oc, null, 2));
        }
      }
    } catch { /* best effort */ }
  }
}
