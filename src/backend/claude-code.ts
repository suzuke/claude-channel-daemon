import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { CliBackend, CliBackendConfig } from "./types.js";
import type { TmuxManager } from "../tmux-manager.js";
import { loadToolAllowlist } from "../approval/tmux-prompt-detector.js";

export class ClaudeCodeBackend implements CliBackend {
  constructor(private instanceDir: string) {}

  buildCommand(config: CliBackendConfig): string {
    const settingsPath = join(this.instanceDir, "claude-settings.json");
    let cmd = `CMUX_CLAUDE_HOOKS_DISABLED=1 claude --settings ${settingsPath} --dangerously-load-development-channels server:ccd-channel`;

    const sessionIdFile = join(this.instanceDir, "session-id");
    if (existsSync(sessionIdFile)) {
      const sid = readFileSync(sessionIdFile, "utf-8").trim();
      if (sid) cmd += ` --resume ${sid}`;
    }

    // NOTE: sandbox shell (CLAUDE_CODE_SHELL) is handled by the daemon,
    // not the backend — it's shared across backends.

    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // 1. Write .mcp.json
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

    // 2. Get hooks from approval strategy
    const approvalResult = config.approvalStrategy.setup(config.approvalPort);

    // 3. Write statusline script
    const statusLineCommand = this.writeStatusLineScript();

    // 4. Write claude-settings.json
    const settings: Record<string, unknown> = {
      hooks: approvalResult.hooks ?? {},
      permissions: {
        allow: [
          "Read", "Edit", "Write", "Glob", "Grep", "Bash(*)",
          "WebFetch", "WebSearch", "Agent", "Skill",
          "mcp__ccd-channel__reply", "mcp__ccd-channel__react",
          "mcp__ccd-channel__edit_message", "mcp__ccd-channel__download_attachment",
          "mcp__ccd-channel__create_schedule", "mcp__ccd-channel__list_schedules",
          "mcp__ccd-channel__update_schedule", "mcp__ccd-channel__delete_schedule",
          // Merge user-approved "always allow" tools from persistent allowlist
          ...loadToolAllowlist(this.instanceDir),
        ],
        deny: [
          "Bash(rm -rf /)", "Bash(rm -rf /*)",
          "Bash(rm -rf ~)", "Bash(rm -rf ~/*)",
          "Bash(dd *)", "Bash(mkfs *)",
        ],
        defaultMode: "default",
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
      return data.context_window?.used_percentage ?? 0;
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

  async postLaunch(tmux: TmuxManager, windowId: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const pane = await tmux.capturePane();
        if (pane.includes("I am using this for local development")) {
          await tmux.sendSpecialKey("Enter");
          continue;
        }
        if (pane.includes("New MCP server found") || pane.includes("Use this and all future MCP servers")) {
          await tmux.sendSpecialKey("Enter");
          continue;
        }
        if (pane.includes("Listening for channel messages")) {
          return;
        }
        const lastLine = pane.trimEnd().split("\n").pop() ?? "";
        if (/[$%>]\s*$/.test(lastLine)) {
          return;
        }
      } catch {
        // Transient pane capture failure during startup — retry loop continues
      }
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
    } catch {
      // Best-effort cleanup — don't fail shutdown if .mcp.json is inaccessible
    }
  }

  // NOTE: writeSandboxShell() stays in daemon.ts (shared across backends)

  private writeStatusLineScript(): string {
    const statusFile = join(this.instanceDir, "statusline.json");
    const script = `#!/bin/bash\nINPUT=$(cat)\necho "$INPUT" > "${statusFile}"\necho "ok"`;
    const scriptPath = join(this.instanceDir, "statusline.sh");
    writeFileSync(scriptPath, script, { mode: 0o755 });
    return scriptPath;
  }
}
