import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { InstanceConfig } from "./types.js";
import { createLogger, type Logger } from "./logger.js";
import { TmuxManager } from "./tmux-manager.js";
import { TranscriptMonitor } from "./transcript-monitor.js";
import { ContextGuardian } from "./context-guardian.js";
import { MemoryLayer } from "./memory-layer.js";
import { MemoryDb } from "./db.js";
import { IpcServer } from "./channel/ipc-bridge.js";
import { MessageBus } from "./channel/message-bus.js";
import { ToolTracker } from "./channel/tool-tracker.js";
import { ApprovalServer } from "./approval/approval-server.js";
import { TmuxPromptDetector } from "./approval/tmux-prompt-detector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class Daemon {
  private logger: Logger;
  private tmux: TmuxManager | null = null;
  private ipcServer: IpcServer | null = null;
  private messageBus: MessageBus;
  private transcriptMonitor: TranscriptMonitor | null = null;
  private toolTracker: ToolTracker | null = null;
  private approvalServer: ApprovalServer | null = null;
  private promptDetector: TmuxPromptDetector | null = null;
  private guardian: ContextGuardian | null = null;
  private memoryLayer: MemoryLayer | null = null;

  constructor(
    private name: string,
    private config: InstanceConfig,
    private instanceDir: string,
    private topicMode = false,
  ) {
    this.logger = createLogger(config.log_level);
    this.messageBus = new MessageBus();
  }

  async start(): Promise<void> {
    mkdirSync(this.instanceDir, { recursive: true });
    writeFileSync(join(this.instanceDir, "daemon.pid"), String(process.pid));
    this.logger.info({ name: this.name, pid: process.pid }, "Starting daemon instance");

    // 1. IPC server
    const sockPath = join(this.instanceDir, "channel.sock");
    this.ipcServer = new IpcServer(sockPath);
    await this.ipcServer.listen();

    // 2. Tmux — ensure session, create window if not alive
    const sessionName = "ccd";
    await TmuxManager.ensureSession(sessionName);
    this.tmux = new TmuxManager(sessionName, "");

    // Check if window already alive (daemon restart after crash)
    const windowIdFile = join(this.instanceDir, "window-id");
    let windowAlive = false;
    if (existsSync(windowIdFile)) {
      const savedId = readFileSync(windowIdFile, "utf-8").trim();
      if (savedId) {
        this.tmux = new TmuxManager(sessionName, savedId);
        windowAlive = await this.tmux.isWindowAlive();
      }
    }

    if (!windowAlive) {
      // Generate settings file
      this.writeSettings();
      // Build claude command — find plugin dir (dist/plugin or src/plugin depending on how we're run)
      // When run via tsx (dev), __dirname is src/; when run compiled, __dirname is dist/
      // Either way, the built plugin is in the project root's dist/plugin/
      let pluginDir = join(__dirname, "plugin");
      this.logger.info({ pluginDir, exists: existsSync(join(pluginDir, "ccd-channel", "server.js")) }, "Plugin dir check");
      if (!existsSync(join(pluginDir, "ccd-channel", "server.js"))) {
        // Fallback: look for dist/plugin relative to project root
        const projectRoot = join(__dirname, "..");
        pluginDir = join(projectRoot, "dist", "plugin");
        this.logger.info({ pluginDir, exists: existsSync(join(pluginDir, "ccd-channel", "server.js")) }, "Plugin dir fallback");
      }
      // Write MCP server config BEFORE starting Claude (so it finds the server)
      const mcpDir = join(this.config.working_directory, ".claude");
      mkdirSync(mcpDir, { recursive: true });
      const mcpConfigPath = join(mcpDir, ".mcp.json");
      let mcpConfig: { mcpServers?: Record<string, unknown> } = {};
      if (existsSync(mcpConfigPath)) {
        try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch {}
      }
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      const sockPath = join(this.instanceDir, "channel.sock");
      let serverJs = join(__dirname, "channel", "mcp-server.js");
      if (!existsSync(serverJs)) {
        serverJs = join(__dirname, "..", "dist", "channel", "mcp-server.js");
      }
      mcpConfig.mcpServers["ccd-channel"] = {
        command: "node",
        args: [serverJs],
        env: { CCD_SOCKET_PATH: sockPath },
      };
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
      this.logger.info({ mcpConfigPath }, "Wrote MCP server config");

      // Now start Claude
      const settingsPath = join(this.instanceDir, "claude-settings.json");
      const sessionIdFile = join(this.instanceDir, "session-id");
      let claudeCmd = `claude --settings ${settingsPath} --channels server:ccd-channel --dangerously-load-development-channels server:ccd-channel`;
      if (existsSync(sessionIdFile)) {
        const sid = readFileSync(sessionIdFile, "utf-8").trim();
        if (sid) claudeCmd += ` --resume ${sid}`;
      }
      const windowId = await this.tmux.createWindow(claudeCmd, this.config.working_directory);
      writeFileSync(windowIdFile, windowId);

      // Auto-confirm the development channels safety prompt
      await new Promise(r => setTimeout(r, 3000));
      await this.tmux.sendSpecialKey("Enter");
      this.logger.info("Auto-confirmed development channels prompt");
    }

    // 3. Pipe-pane for prompt detection
    const outputLog = join(this.instanceDir, "output.log");
    await this.tmux.pipeOutput(outputLog);

    // 4. Transcript monitor
    this.transcriptMonitor = new TranscriptMonitor(this.instanceDir, this.logger);

    // 5. Wire transcript events
    this.transcriptMonitor.on("tool_use", (name: string, input: unknown) => {
      this.logger.info({ tool: name }, "Tool use");
      this.toolTracker?.onToolUse(name, input);
    });
    this.transcriptMonitor.on("tool_result", (name: string, output: unknown) => {
      this.toolTracker?.onToolResult(name, output);
    });
    this.transcriptMonitor.on("assistant_text", (text: string) => {
      this.logger.info({ text: text.slice(0, 200) }, "Claude response");
      this.toolTracker?.reset();
    });
    this.transcriptMonitor.startPolling();

    // 6. Approval server
    const port = this.config.approval_port ?? 18321;
    this.approvalServer = new ApprovalServer(this.messageBus, port);
    await this.approvalServer.start();

    // 7. Prompt detector
    this.promptDetector = new TmuxPromptDetector(
      outputLog,
      this.tmux,
      (prompt) => this.messageBus.requestApproval(prompt),
      this.logger,
    );
    this.promptDetector.startPolling();

    // 8. Context guardian
    const statusFile = join(this.instanceDir, "statusline.json");
    this.guardian = new ContextGuardian(this.config.context_guardian, this.logger, statusFile);
    this.guardian.startWatching();
    this.guardian.startTimer();
    this.guardian.on("rotate", async (reason: string) => {
      this.logger.info({ reason }, "Context rotation triggered");
      this.transcriptMonitor?.resetOffset();
      // Clear session, restart tmux window
      const sessionIdFile = join(this.instanceDir, "session-id");
      try {
        unlinkSync(sessionIdFile);
      } catch {
        // Ignore if not found
      }
      await this.tmux?.killWindow();
      // Respawn (simplified — full implementation restarts window)
    });

    // 9. Memory layer
    if (this.config.memory.watch_memory_dir || this.config.memory.backup_to_sqlite) {
      const dbPath = join(this.instanceDir, "memory.db");
      const db = new MemoryDb(dbPath);
      const memDir =
        this.config.memory_directory ??
        join(
          homedir(),
          ".claude/projects",
          this.config.working_directory.replace(/\//g, "-").replace(/^-/, ""),
          "memory",
        );
      if (existsSync(memDir)) {
        this.memoryLayer = new MemoryLayer(memDir, db, this.logger);
        await this.memoryLayer.start();
      }
    }

    // Set CCD_SOCKET_PATH env for MCP server
    process.env.CCD_SOCKET_PATH = sockPath;

    this.logger.info({ name: this.name, port }, "Daemon instance started");
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping daemon instance");
    this.promptDetector?.stop();
    this.transcriptMonitor?.stop();
    this.guardian?.stop();
    if (this.memoryLayer) await this.memoryLayer.stop();
    await this.approvalServer?.stop();
    await this.ipcServer?.close();
    // Don't kill tmux window — let Claude keep running for crash resilience
    const pidPath = join(this.instanceDir, "daemon.pid");
    try {
      unlinkSync(pidPath);
    } catch {
      // Ignore if not found
    }
  }

  getMessageBus(): MessageBus {
    return this.messageBus;
  }

  private writeSettings(): void {
    const port = this.config.approval_port ?? 18321;
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: `curl -s -X POST http://127.0.0.1:${port}/approve -H 'Content-Type: application/json' -d @- --max-time 130 --connect-timeout 1 || echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"approval server unreachable"}}'`,
                timeout: 135000,
              },
            ],
          },
        ],
      },
      permissions: {
        allow: [
          "Read",
          "Edit",
          "Write",
          "Glob",
          "Grep",
          "Bash(*)",
          "WebFetch",
          "WebSearch",
          "Agent",
          "Skill",
          "mcp__ccd-channel__reply",
          "mcp__ccd-channel__react",
          "mcp__ccd-channel__edit_message",
          "mcp__ccd-channel__download_attachment",
        ],
        deny: [
          "Bash(rm -rf /)",
          "Bash(rm -rf /*)",
          "Bash(rm -rf ~)",
          "Bash(rm -rf ~/*)",
          "Bash(git push * --force *)",
          "Bash(git push --force *)",
          "Bash(git reset --hard *)",
          "Bash(git clean -fd *)",
          "Bash(git clean -f *)",
          "Bash(dd *)",
          "Bash(mkfs *)",
        ],
        defaultMode: "default",
      },
      statusLine: {
        type: "command",
        command: this.writeStatusLineScript(),
      },
    };
    writeFileSync(
      join(this.instanceDir, "claude-settings.json"),
      JSON.stringify(settings),
    );
  }

  private writeStatusLineScript(): string {
    const statusFile = join(this.instanceDir, "statusline.json");
    const script = `#!/bin/bash\nINPUT=$(cat)\necho "$INPUT" > "${statusFile}"\necho "ok"`;
    const scriptPath = join(this.instanceDir, "statusline.sh");
    writeFileSync(scriptPath, script, { mode: 0o755 });
    return scriptPath;
  }
}
