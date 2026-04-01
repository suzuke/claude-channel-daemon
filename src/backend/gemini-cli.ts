import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { type CliBackend, type CliBackendConfig, resolveBinary } from "./types.js";

export class GeminiCliBackend implements CliBackend {
  readonly binaryName = "gemini";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("gemini");
  }

  buildCommand(config: CliBackendConfig): string {
    let cmd = `${this.binaryPath} --yolo`;

    const sessionIdFile = join(this.instanceDir, "session-id");
    if (existsSync(sessionIdFile)) {
      const sid = readFileSync(sessionIdFile, "utf-8").trim();
      if (sid) cmd += ` --resume ${sid}`;
    }

    if (config.model) {
      cmd += ` --model ${config.model}`;
    }

    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // Gemini uses .gemini/settings.json for MCP servers
    const geminiDir = join(config.workingDirectory, ".gemini");
    mkdirSync(geminiDir, { recursive: true });

    const settingsPath = join(geminiDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch { /* new file */ }

    // Inject AGEND_INSTANCE_NAME into each MCP server's env so the MCP server
    // identifies as this instance (Gemini spawns MCP servers as separate processes)
    const mcpWithInstanceName: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      mcpWithInstanceName[name] = {
        ...entry,
        env: { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName },
      };
    }
    settings.mcpServers = mcpWithInstanceName;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // System prompt via GEMINI.md
    if (config.systemPrompt) {
      writeFileSync(join(geminiDir, "GEMINI.md"), config.systemPrompt);
    }
  }

  preTrust(workDir: string): void {
    const trustFile = join(homedir(), ".gemini", "trustedFolders.json");
    let trusted: Record<string, string> = {};
    try { trusted = JSON.parse(readFileSync(trustFile, "utf-8")); } catch {}
    if (!trusted[workDir]) {
      trusted[workDir] = "TRUST_FOLDER";
      mkdirSync(dirname(trustFile), { recursive: true });
      writeFileSync(trustFile, JSON.stringify(trusted, null, 2));
    }
  }

  getReadyPattern(): RegExp {
    return /Type your message|\? for shortcuts|YOLO Ctrl/m;
  }

  getContextUsage(): number | null {
    // Gemini CLI doesn't expose context usage via a file
    return null;
  }

  getSessionId(): string | null {
    try {
      const f = join(this.instanceDir, "session-id");
      return readFileSync(f, "utf-8").trim() || null;
    } catch { return null; }
  }

  cleanup(config: CliBackendConfig): void {
    // Clean up .gemini/settings.json MCP entries
    try {
      const settingsPath = join(config.workingDirectory, ".gemini", "settings.json");
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (settings.mcpServers) {
          for (const name of Object.keys(config.mcpServers)) {
            delete settings.mcpServers[name];
          }
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        }
      }
    } catch { /* best effort */ }
  }
}
