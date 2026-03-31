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

    // MCP servers
    oc.mcp = {};
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      (oc.mcp as Record<string, unknown>)[name] = {
        type: "local",
        command: [entry.command, ...entry.args],
        env: entry.env,
      };
    }

    // System prompt via instructions
    if (config.systemPrompt) {
      oc.instructions = config.systemPrompt;
    }

    writeFileSync(configPath, JSON.stringify(oc, null, 2));
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
        if (oc.mcp) {
          for (const name of Object.keys(config.mcpServers)) {
            delete oc.mcp[name];
          }
          writeFileSync(configPath, JSON.stringify(oc, null, 2));
        }
      }
    } catch { /* best effort */ }
  }
}
