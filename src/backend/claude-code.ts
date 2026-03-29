import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { CliBackend, CliBackendConfig } from "./types.js";


export class ClaudeCodeBackend implements CliBackend {
  constructor(private instanceDir: string) {}

  buildCommand(config: CliBackendConfig): string {
    const settingsPath = join(this.instanceDir, "claude-settings.json");
    let cmd = `CMUX_CLAUDE_HOOKS_DISABLED=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --settings ${settingsPath} --dangerously-load-development-channels server:ccd-channel`;

    const sessionIdFile = join(this.instanceDir, "session-id");
    if (existsSync(sessionIdFile)) {
      const sid = readFileSync(sessionIdFile, "utf-8").trim();
      if (sid && /^[a-zA-Z0-9_-]+$/.test(sid)) cmd += ` --resume ${sid}`;
    }

    if (config.skipPermissions) {
      cmd += ` --dangerously-skip-permissions`;
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
    // 1. Write .mcp.json (always needed — ccd-channel MCP server)
    const mcpConfigPath = join(config.workingDirectory, ".mcp.json");
    let mcpConfig: { mcpServers?: Record<string, unknown> } = {};
    try {
      const raw = readFileSync(mcpConfigPath, "utf-8");
      try {
        mcpConfig = JSON.parse(raw);
      } catch (parseErr) {
        throw new Error(`Existing .mcp.json is corrupted and cannot be parsed. Please fix or remove it manually: ${mcpConfigPath}`);
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        mcpConfig = {};
      } else {
        throw err;
      }
    }
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      mcpConfig.mcpServers[name] = entry;
    }
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // 2. Write statusline script
    const statusLineCommand = this.writeStatusLineScript();

    // 3. Write claude-settings.json
    const mcpTools = [
      "mcp__ccd-channel__reply", "mcp__ccd-channel__react",
      "mcp__ccd-channel__edit_message", "mcp__ccd-channel__download_attachment",
      "mcp__ccd-channel__create_schedule", "mcp__ccd-channel__list_schedules",
      "mcp__ccd-channel__update_schedule", "mcp__ccd-channel__delete_schedule",
      "mcp__ccd-channel__send_to_instance", "mcp__ccd-channel__list_instances",
      "mcp__ccd-channel__start_instance", "mcp__ccd-channel__create_instance",
      "mcp__ccd-channel__delete_instance",
      "mcp__ccd-channel__request_information", "mcp__ccd-channel__delegate_task",
      "mcp__ccd-channel__report_result", "mcp__ccd-channel__describe_instance",
    ];

    const settings: Record<string, unknown> = {
      permissions: {
        allow: config.skipPermissions ? ["*"] : mcpTools,
      },
      statusLine: {
        type: "command",
        command: statusLineCommand,
      },
    };
    writeFileSync(
      join(this.instanceDir, "claude-settings.json"),
      JSON.stringify(settings),
    );
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

  cleanup(config: CliBackendConfig): void {
    // Remove ccd-channel from .mcp.json
    try {
      const mcpConfigPath = join(config.workingDirectory, ".mcp.json");
      if (existsSync(mcpConfigPath)) {
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
        if (mcpConfig.mcpServers?.["ccd-channel"]) {
          delete mcpConfig.mcpServers["ccd-channel"];
          if (Object.keys(mcpConfig.mcpServers).length === 0) {
            unlinkSync(mcpConfigPath);
          } else {
            writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
          }
        }
      }
    } catch (err) {
      // Best-effort cleanup — don't fail shutdown, but warn so user can clean up manually
      process.stderr.write(`ccd: warning: failed to clean up .mcp.json: ${err}\n`);
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
