import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type StartupDialog, resolveBinary } from "./types.js";

export class GeminiCliBackend implements CliBackend {
  readonly binaryName = "gemini";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("gemini");
  }

  buildCommand(config: CliBackendConfig): string {
    // --resume latest lets Gemini auto-resume without showing a session picker.
    // Using specific session IDs causes a picker dialog that daemon can't handle.
    let cmd = `${this.binaryPath} --yolo --resume latest`;

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
    // identifies as this instance (Gemini spawns MCP servers as separate processes).
    // Use instance-namespaced key to avoid conflicts when multiple instances share
    // the same working directory.
    const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const instanceKey = `${name}-${config.instanceName}`;
      servers[instanceKey] = {
        ...entry,
        env: { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName },
      };
    }
    // Clean up old non-namespaced key if present (one-time migration)
    delete servers["agend"];
    settings.mcpServers = servers;
    // Write model to per-project settings (Gemini reads model.name from settings.json)
    if (config.model) {
      settings.model = { name: config.model };
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  }

  preTrust(workDir: string): void {
    const trustFile = join(homedir(), ".gemini", "trustedFolders.json");
    let trusted: Record<string, string> = {};
    try { trusted = JSON.parse(readFileSync(trustFile, "utf-8")); } catch {}
    let changed = false;
    // Trust the exact working directory
    if (!trusted[workDir]) { trusted[workDir] = "TRUST_FOLDER"; changed = true; }
    // Also trust parent directory (Gemini may resolve cwd differently under launchd)
    const parent = dirname(workDir);
    if (parent !== workDir && !trusted[parent]) { trusted[parent] = "TRUST_PARENT"; changed = true; }
    if (changed) {
      mkdirSync(dirname(trustFile), { recursive: true });
      writeFileSync(trustFile, JSON.stringify(trusted, null, 2));
    }
  }

  getReadyPattern(): RegExp {
    return /Type your message|\? for shortcuts|YOLO Ctrl/m;
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /RESOURCE_EXHAUSTED|quota exceeded/i, type: "rate_limit", action: "notify", message: "Gemini quota exhausted" },
      { pattern: /PERMISSION_DENIED|API key not valid/i, type: "auth_error", action: "pause", message: "Gemini authentication error" },
      { pattern: /(?:google|googleapis|grpc).*UNAVAILABLE|503 Service/i, type: "network", action: "notify", message: "Gemini service unavailable" },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      { pattern: /[❯›]\s*Don't trust/m, keys: ["Up", "Up", "Enter"], description: "Gemini 'Don't trust' selected — navigate to Trust folder" },
      { pattern: /Trust folder/i, keys: ["Enter"], description: "Gemini trust folder dialog" },
    ];
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
    // Only remove namespaced keys — non-namespaced keys may belong to
    // another instance sharing this working directory.
    try {
      const settingsPath = join(config.workingDirectory, ".gemini", "settings.json");
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        if (settings.mcpServers) {
          for (const name of Object.keys(config.mcpServers)) {
            delete settings.mcpServers[`${name}-${config.instanceName}`];
          }
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        }
      }
    } catch { /* best effort */ }
  }
}
