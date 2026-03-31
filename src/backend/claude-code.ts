import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { type CliBackend, type CliBackendConfig, resolveBinary } from "./types.js";


export class ClaudeCodeBackend implements CliBackend {
  readonly binaryName = "claude";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("claude");
  }

  buildCommand(config: CliBackendConfig): string {
    const settingsPath = join(this.instanceDir, "claude-settings.json");
    const mcpConfigPath = join(this.instanceDir, "mcp-config.json");
    const envPrefix = ["CMUX_CLAUDE_HOOKS_DISABLED=1", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"];
    if (process.env.ANTHROPIC_BASE_URL) envPrefix.push(`ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}`);
    if (process.env.ANTHROPIC_API_KEY && !this.hasOAuthSession()) {
      envPrefix.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
    }
    let cmd = `${envPrefix.join(" ")} ${this.binaryPath} --settings ${settingsPath} --mcp-config ${mcpConfigPath} --dangerously-skip-permissions`;

    const sessionIdFile = join(this.instanceDir, "session-id");
    if (existsSync(sessionIdFile)) {
      const sid = readFileSync(sessionIdFile, "utf-8").trim();
      if (sid && /^[a-zA-Z0-9_-]+$/.test(sid)) cmd += ` --resume ${sid}`;
    }

    if (config.model) {
      cmd += ` --model ${config.model}`;
    }

    if (config.systemPrompt) {
      const promptPath = join(this.instanceDir, "system-prompt.md");
      writeFileSync(promptPath, config.systemPrompt);
      cmd += ` --system-prompt "${promptPath}"`;
    }

    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // 1. Write mcp-config.json to instance dir (loaded via --mcp-config)
    const mcpConfigPath = join(this.instanceDir, "mcp-config.json");
    const mcpConfig = { mcpServers: config.mcpServers };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // 2. Write statusline script
    const statusLineCommand = this.writeStatusLineScript();

    // 3. Write claude-settings.json (permissions handled by --dangerously-skip-permissions)
    const settings: Record<string, unknown> = {
      statusLine: {
        type: "command",
        command: statusLineCommand,
      },
    };
    writeFileSync(
      join(this.instanceDir, "claude-settings.json"),
      JSON.stringify(settings),
    );

    // 4. Pre-approve API key to skip interactive prompt on startup
    this.preApproveApiKey(config);
  }

  getContextUsage(): number | null {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      const data = JSON.parse(readFileSync(sf, "utf-8"));
      return data.context_window?.used_percentage ?? null;
    } catch (err) {
      // File may not exist yet during startup — return null to signal unavailable
      return null;
    }
  }

  getSessionId(): string | null {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      const data = JSON.parse(readFileSync(sf, "utf-8"));
      return data.session_id ?? null;
    } catch {
      return null;
    }
  }

  cleanup(_config: CliBackendConfig): void {
    // mcp-config.json is in instance dir, cleaned up when instance is deleted
  }

  /** Pre-approve ANTHROPIC_API_KEY in ~/.claude.json to skip the interactive prompt */
  private preApproveApiKey(_config: CliBackendConfig): void {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const fingerprint = apiKey.length > 20 ? apiKey.slice(-20) : apiKey;
    const claudeJsonPath = join(homedir(), ".claude.json");

    let claudeCfg: Record<string, unknown> = {};
    try {
      claudeCfg = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    } catch { /* new file or parse error */ }

    const existing = claudeCfg.customApiKeyResponses as { approved?: string[]; rejected?: string[] } | undefined;
    const approved = existing?.approved ?? [];
    if (!approved.includes(fingerprint)) {
      claudeCfg.customApiKeyResponses = {
        approved: [...approved, fingerprint],
        rejected: existing?.rejected ?? [],
      };
      writeFileSync(claudeJsonPath, JSON.stringify(claudeCfg, null, 2));
    }
  }

  /** Check if user has an active OAuth session in ~/.claude.json */
  private hasOAuthSession(): boolean {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf-8"));
      return !!cfg.oauthAccount?.accountUuid;
    } catch {
      return false;
    }
  }

  private writeStatusLineScript(): string {
    const statusFile = join(this.instanceDir, "statusline.json");
    // Use a Node.js script instead of bash to avoid shell injection via statusFile path
    const script = [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "let input = '';",
      "process.stdin.on('data', d => input += d);",
      `process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(statusFile)}, input); console.log('ok'); });`,
    ].join("\n");
    const scriptPath = join(this.instanceDir, "statusline.js");
    writeFileSync(scriptPath, script, { mode: 0o755 });
    return scriptPath;
  }
}
