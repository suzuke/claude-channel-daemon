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
import { TelegramAdapter } from "./channel/adapters/telegram.js";
import { AccessManager } from "./channel/access-manager.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";

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
  private adapter: ChannelAdapter | null = null;
  // Track the threadId from inbound messages for automatic outbound routing
  private lastThreadId: string | undefined;
  // Tool status tracking for Telegram
  private toolStatusMessageId: string | null = null;
  private toolStatusLines: string[] = [];
  private toolStatusDebounce: ReturnType<typeof setTimeout> | null = null;

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

    // 1. IPC server — bridge between MCP server (Claude's child) and daemon
    const sockPath = join(this.instanceDir, "channel.sock");
    this.ipcServer = new IpcServer(sockPath);
    await this.ipcServer.listen();

    // IPC message relay: when daemon wants to push a channel message to Claude,
    // it broadcasts to all IPC clients (the MCP server is one of them).
    // When MCP server sends a tool_call, daemon handles it via the messageBus.
    this.ipcServer.on("message", (msg: Record<string, unknown>, socket: import("node:net").Socket) => {
      if (msg.type === "tool_call") {
        // MCP server forwarding a Claude tool call (reply, react, edit, download)
        this.handleToolCall(msg, socket);
      } else if (msg.type === "mcp_ready") {
        this.logger.info("MCP channel server connected and ready");
      } else if (msg.type === "fleet_inbound") {
        // Fleet manager routed a message to us (topic mode)
        const meta = msg.meta as Record<string, string>;
        if (meta.thread_id) this.lastThreadId = meta.thread_id;
        this.pushChannelMessage(msg.content as string, meta);
      } else if (msg.type === "fleet_tool_status_ack") {
        // Fleet manager sent us the messageId for our tool status message
        this.toolStatusMessageId = msg.messageId as string;
      }
    });

    // 1b. Create Telegram adapter (DM mode only — in topic mode, fleet manager owns the adapter)
    if (!this.topicMode && this.config.channel) {
      const channelConfig = this.config.channel;
      const botToken = process.env[channelConfig.bot_token_env];
      if (botToken) {
        const accessDir = join(this.instanceDir, "access");
        mkdirSync(accessDir, { recursive: true });
        const accessManager = new AccessManager(
          channelConfig.access,
          join(accessDir, "access.json"),
        );
        const inboxDir = join(this.instanceDir, "inbox");
        mkdirSync(inboxDir, { recursive: true });
        this.adapter = new TelegramAdapter({
          id: `tg-${this.name}`,
          botToken,
          accessManager,
          inboxDir,
        });
        this.messageBus.register(this.adapter);

        // Wire inbound messages → push to Claude via IPC
        this.messageBus.on("message", (msg: InboundMessage) => {
          if (msg.threadId) this.lastThreadId = msg.threadId;
          this.pushChannelMessage(msg.text, {
            chat_id: msg.chatId,
            message_id: msg.messageId,
            user: msg.username,
            user_id: msg.userId,
            ts: msg.timestamp.toISOString(),
            ...(msg.threadId ? { thread_id: msg.threadId } : {}),
          });
        });

        await this.adapter.start();
        this.logger.info({ adapterId: this.adapter.id }, "Telegram adapter started");
      } else {
        this.logger.warn({ env: channelConfig.bot_token_env }, "Bot token env not set, skipping adapter");
      }
    }

    // 2. Tmux — ensure session, create window if not alive
    const sessionName = "ccd";
    await TmuxManager.ensureSession(sessionName);
    this.tmux = new TmuxManager(sessionName, "");

    // Strategy A: always start fresh Claude window (MCP server has no reconnection)
    // Kill any existing window from previous run
    const windowIdFile = join(this.instanceDir, "window-id");
    if (existsSync(windowIdFile)) {
      const savedId = readFileSync(windowIdFile, "utf-8").trim();
      if (savedId) {
        const oldTmux = new TmuxManager(sessionName, savedId);
        if (await oldTmux.isWindowAlive()) {
          // Capture session-id from statusline before killing
          try {
            const statusFile = join(this.instanceDir, "statusline.json");
            if (existsSync(statusFile)) {
              const data = JSON.parse(readFileSync(statusFile, "utf-8"));
              if (data.session_id) {
                writeFileSync(join(this.instanceDir, "session-id"), data.session_id);
              }
            }
          } catch {}
          await oldTmux.killWindow();
          this.logger.info({ savedId }, "Killed old tmux window for fresh start");
        }
      }
    }

    await this.spawnClaudeWindow();
    this.autoConfirmDevChannels();

    // 3. Pipe-pane for prompt detection
    const outputLog = join(this.instanceDir, "output.log");
    await this.tmux.pipeOutput(outputLog);

    // 4. Transcript monitor
    this.transcriptMonitor = new TranscriptMonitor(this.instanceDir, this.logger);

    // 5. Wire transcript events → tool status in Telegram
    this.transcriptMonitor.on("tool_use", (name: string, input: unknown) => {
      this.logger.info({ tool: name }, "Tool use");
      this.addToolStatus(name, input, "running");
    });
    this.transcriptMonitor.on("tool_result", (name: string, _output: unknown) => {
      this.addToolStatus(name, null, "done");
    });
    this.transcriptMonitor.on("assistant_text", (text: string) => {
      this.logger.info({ text: text.slice(0, 200) }, "Claude response");
      this.resetToolStatus();
    });
    this.transcriptMonitor.startPolling();

    // 6. Approval server
    const port = this.config.approval_port ?? 18321;
    this.approvalServer = new ApprovalServer({
      messageBus: this.messageBus,
      port,
      ipcServer: this.ipcServer,
      topicMode: this.topicMode,
      instanceName: this.name,
    });
    await this.approvalServer.start();

    // 7. Prompt detector
    this.promptDetector = new TmuxPromptDetector(
      outputLog,
      this.tmux,
      (prompt) => this.messageBus.requestApproval(prompt),
      this.logger,
    );
    this.promptDetector.startPolling();

    // 8. Capture session ID from statusline for resume
    const sessionIdFile = join(this.instanceDir, "session-id");
    this.guardian?.on("status_update", (status: Record<string, unknown>) => {
      const raw = readFileSync(join(this.instanceDir, "statusline.json"), "utf-8");
      try {
        const data = JSON.parse(raw);
        if (data.session_id) {
          writeFileSync(sessionIdFile, data.session_id);
        }
      } catch {}
    });

    // 9. Context guardian
    const statusFile = join(this.instanceDir, "statusline.json");
    this.guardian = new ContextGuardian(this.config.context_guardian, this.logger, statusFile);
    this.guardian.startWatching();
    this.guardian.startTimer();
    this.guardian.on("rotate", async (reason: string) => {
      this.logger.info({ reason }, "Context rotation triggered — sending /compact");

      // Step 1: Send /compact to let Claude compress context in-place
      if (this.tmux) {
        await this.tmux.sendKeys("/compact");
        await this.tmux.sendSpecialKey("Enter");
        this.logger.info("Sent /compact to Claude");

        // Wait for compact to finish (poll statusline for reduced context %)
        const compactTimeout = 60_000;
        const start = Date.now();
        while (Date.now() - start < compactTimeout) {
          await new Promise(r => setTimeout(r, 5000));
          try {
            const sf = join(this.instanceDir, "statusline.json");
            if (existsSync(sf)) {
              const data = JSON.parse(readFileSync(sf, "utf-8"));
              const pct = data.context_window?.used_percentage;
              if (pct != null && pct < this.config.context_guardian.threshold_percentage) {
                this.logger.info({ newUsage: pct }, "Compact succeeded — context below threshold");
                this.guardian?.markRotationComplete();
                return;
              }
            }
          } catch {}
        }

        this.logger.warn("Compact did not reduce context below threshold — restarting session");
      }

      // Step 2: If compact wasn't enough, kill and start fresh (no --resume)
      try {
        const sf = join(this.instanceDir, "statusline.json");
        if (existsSync(sf)) {
          const data = JSON.parse(readFileSync(sf, "utf-8"));
          if (data.session_id) {
            writeFileSync(join(this.instanceDir, "session-id"), data.session_id);
          }
        }
      } catch {}

      // Remove session-id so spawnClaudeWindow starts fresh
      const sessionIdFile = join(this.instanceDir, "session-id");
      try { unlinkSync(sessionIdFile); } catch {}

      await this.tmux?.killWindow();
      this.transcriptMonitor?.resetOffset();
      await this.spawnClaudeWindow();
      this.autoConfirmDevChannels();
      this.guardian?.markRotationComplete();
      this.logger.info({ reason }, "Context rotation complete — fresh Claude session started");
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
    if (this.adapter) await this.adapter.stop();
    await this.approvalServer?.stop();
    await this.ipcServer?.close();
    // Strategy A: kill window on stop, resume via --resume on next start
    // MCP server has no reconnection → keeping window alive would leave
    // Claude without channel/approval connectivity
    if (this.tmux) {
      // Capture session-id before killing (for --resume on next start)
      try {
        const statusFile = join(this.instanceDir, "statusline.json");
        if (existsSync(statusFile)) {
          const data = JSON.parse(readFileSync(statusFile, "utf-8"));
          if (data.session_id) {
            writeFileSync(join(this.instanceDir, "session-id"), data.session_id);
            this.logger.info({ sessionId: data.session_id }, "Saved session ID for resume");
          }
        }
      } catch {}
      await this.tmux.killWindow();
      const windowIdFile = join(this.instanceDir, "window-id");
      try { unlinkSync(windowIdFile); } catch {}
    }
    // Clean up .mcp.json — remove ccd-channel entry (keep other MCP servers)
    try {
      const mcpConfigPath = join(this.config.working_directory, ".mcp.json");
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
    } catch {}

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

  // ── Tool status tracking ──────────────────────────────────────

  private summarizeTool(name: string, input: unknown): string {
    const inp = input as Record<string, unknown> | null;
    if (!inp) return name;
    if (name === "Read") return `Read ${inp.file_path ?? ""}`;
    if (name === "Edit") return `Edit ${inp.file_path ?? ""}`;
    if (name === "Write") return `Write ${inp.file_path ?? ""}`;
    if (name === "Bash") return `$ ${String(inp.command ?? "").slice(0, 50)}`;
    if (name === "Glob") return `Glob ${inp.pattern ?? ""}`;
    if (name === "Grep") return `Grep ${inp.pattern ?? ""}`;
    if (name === "Agent") return "Agent (subagent)";
    if (name.startsWith("mcp__ccd-channel__")) return ""; // skip channel tools
    return name;
  }

  private addToolStatus(name: string, input: unknown, state: "running" | "done"): void {
    const summary = this.summarizeTool(name, input);
    if (!summary) return; // skip empty (e.g., channel tools)

    if (state === "running") {
      this.toolStatusLines.push(`⏳ ${summary}`);
    } else {
      // Mark the last matching tool as done
      for (let i = this.toolStatusLines.length - 1; i >= 0; i--) {
        if (this.toolStatusLines[i].includes(name) && this.toolStatusLines[i].startsWith("⏳")) {
          this.toolStatusLines[i] = this.toolStatusLines[i].replace("⏳", "✅");
          break;
        }
      }
    }
    this.debouncedSendToolStatus();
  }

  private resetToolStatus(): void {
    if (this.toolStatusDebounce) clearTimeout(this.toolStatusDebounce);
    this.toolStatusMessageId = null;
    this.toolStatusLines = [];
  }

  /** Debounce tool status updates to avoid Telegram rate limits */
  private debouncedSendToolStatus(): void {
    if (this.toolStatusDebounce) clearTimeout(this.toolStatusDebounce);
    this.toolStatusDebounce = setTimeout(() => this.sendToolStatus(), 500);
  }

  private sendToolStatus(): void {
    const text = this.toolStatusLines.join("\n");
    if (!text) return;

    if (this.topicMode) {
      // Topic mode: send via IPC to fleet manager
      this.ipcServer?.broadcast({
        type: "fleet_tool_status",
        instanceName: this.name,
        text,
        editMessageId: this.toolStatusMessageId,
      });
    } else {
      // DM mode: send directly via adapter
      const adapters = this.messageBus.getAllAdapters();
      if (adapters.length === 0) return;
      const adapter = adapters[0];
      const chatId = ""; // DM mode uses default chat
      if (!this.toolStatusMessageId) {
        adapter.sendText(chatId, text, { threadId: this.lastThreadId })
          .then(sent => { this.toolStatusMessageId = sent.messageId; })
          .catch(() => {});
      } else {
        adapter.editMessage(chatId, this.toolStatusMessageId, text).catch(() => {});
      }
    }
  }

  /** Called by fleet manager when tool status message is sent (returns messageId) */
  setToolStatusMessageId(messageId: string): void {
    this.toolStatusMessageId = messageId;
  }

  /**
   * Push an inbound channel message to Claude via the MCP server.
   * This broadcasts to all IPC clients — the MCP server picks it up
   * and forwards to Claude via notifications/claude/channel.
   */
  pushChannelMessage(content: string, meta: Record<string, string>): void {
    if (!this.ipcServer) {
      this.logger.warn("Cannot push channel message: IPC server not running");
      return;
    }
    this.ipcServer.broadcast({
      type: "channel_message",
      content,
      meta,
    });
    this.logger.info({ user: meta.user, text: content.slice(0, 100) }, "Pushed channel message to Claude");
  }

  /**
   * Handle a tool call from the MCP server (forwarded by Claude).
   * Routes to the channel adapter via MessageBus.
   */
  private handleToolCall(msg: Record<string, unknown>, socket: import("node:net").Socket): void {
    const tool = msg.tool as string;
    const args = (msg.args ?? {}) as Record<string, unknown>;
    const requestId = msg.requestId as number;

    this.logger.info({ tool, requestId }, "Tool call from MCP server");

    // For now, log and respond. Full adapter routing will be wired in fleet manager.
    const respond = (result: unknown, error?: string) => {
      this.ipcServer?.send(socket, { requestId, result, error });
    };

    // Route to adapter via MessageBus
    const adapters = this.messageBus.getAllAdapters();
    if (adapters.length === 0) {
      // Topic mode: forward to fleet manager via IPC (fleet manager connected as IPC client)
      // The fleet manager's IPC client receives this and routes to shared adapter
      this.ipcServer?.broadcast({ type: "fleet_outbound", tool, args, requestId });
      // Response will come back as fleet_outbound_response — relay to MCP server
      const onResponse = (respMsg: Record<string, unknown>) => {
        if (respMsg.type === "fleet_outbound_response" && respMsg.requestId === requestId) {
          respond(respMsg.result, respMsg.error as string | undefined);
          this.ipcServer?.removeListener("message", onResponse as (...a: unknown[]) => void);
        }
      };
      this.ipcServer?.on("message", onResponse as (...a: unknown[]) => void);
      return;
    }

    const adapter = adapters[0];
    const chatId = args.chat_id as string ?? "";

    switch (tool) {
      case "reply":
        adapter.sendText(chatId, args.text as string ?? "", {
          threadId: args.thread_id as string ?? this.lastThreadId,
          replyTo: args.reply_to as string,
        }).then(sent => respond(sent))
          .catch(e => respond(null, e.message));
        break;
      case "react":
        adapter.react(chatId, args.message_id as string ?? "", args.emoji as string ?? "")
          .then(() => respond("ok"))
          .catch(e => respond(null, e.message));
        break;
      case "edit_message":
        adapter.editMessage(chatId, args.message_id as string ?? "", args.text as string ?? "")
          .then(() => respond("ok"))
          .catch(e => respond(null, e.message));
        break;
      case "download_attachment":
        adapter.downloadAttachment(args.file_id as string ?? "")
          .then(path => respond(path))
          .catch(e => respond(null, e.message));
        break;
      default:
        respond(null, `Unknown tool: ${tool}`);
    }
  }

  /** Background polling to auto-confirm all Claude startup prompts */
  private async autoConfirmDevChannels(): Promise<void> {
    if (!this.tmux) return;
    for (let i = 0; i < 60; i++) { // max 60s — may have multiple prompts
      await new Promise(r => setTimeout(r, 1000));
      try {
        const pane = await this.tmux.capturePane();
        // Dev channels safety prompt
        if (pane.includes("I am using this for local development")) {
          await this.tmux.sendSpecialKey("Enter");
          this.logger.info("Auto-confirmed development channels prompt");
          continue; // may have more prompts after this
        }
        // MCP server trust prompt (first time in a project)
        if (pane.includes("New MCP server found") || pane.includes("Use this and all future MCP servers")) {
          await this.tmux.sendSpecialKey("Enter");
          this.logger.info("Auto-confirmed MCP server trust prompt");
          continue;
        }
        // Successfully started
        if (pane.includes("Listening for channel messages")) {
          this.logger.info("Claude started and listening for channels");
          return;
        }
      } catch {}
    }
    this.logger.warn(`Auto-confirm timed out — manually run: tmux send-keys -t ccd:${this.tmux.getWindowId()} Enter`);
  }

  /** Spawn (or respawn) a Claude window in tmux */
  private async spawnClaudeWindow(): Promise<void> {
    this.writeSettings();

    // Find MCP server JS
    let serverJs = join(__dirname, "channel", "mcp-server.js");
    if (!existsSync(serverJs)) {
      serverJs = join(__dirname, "..", "dist", "channel", "mcp-server.js");
    }
    let pluginDir = join(__dirname, "plugin");
    this.logger.info({ pluginDir, exists: existsSync(join(pluginDir, "ccd-channel", "server.js")) }, "Plugin dir check");
    if (!existsSync(join(pluginDir, "ccd-channel", "server.js"))) {
      pluginDir = join(__dirname, "..", "dist", "plugin");
      this.logger.info({ pluginDir, exists: existsSync(join(pluginDir, "ccd-channel", "server.js")) }, "Plugin dir fallback");
    }

    // Write .mcp.json
    const mcpConfigPath = join(this.config.working_directory, ".mcp.json");
    let mcpConfig: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(mcpConfigPath)) {
      try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch {}
    }
    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    const sockPath = join(this.instanceDir, "channel.sock");
    mcpConfig.mcpServers["ccd-channel"] = {
      command: "node",
      args: [serverJs],
      env: { CCD_SOCKET_PATH: sockPath },
    };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    this.logger.info({ mcpConfigPath }, "Wrote MCP server config");

    // Build claude command
    const settingsPath = join(this.instanceDir, "claude-settings.json");
    const sessionIdFile = join(this.instanceDir, "session-id");
    let claudeCmd = `claude --settings ${settingsPath} --dangerously-load-development-channels server:ccd-channel`;
    if (existsSync(sessionIdFile)) {
      const sid = readFileSync(sessionIdFile, "utf-8").trim();
      if (sid) claudeCmd += ` --resume ${sid}`;
    }

    const windowId = await this.tmux!.createWindow(claudeCmd, this.config.working_directory);
    const windowIdFile = join(this.instanceDir, "window-id");
    writeFileSync(windowIdFile, windowId);
  }

  private writeSettings(): void {
    const port = this.config.approval_port ?? 18321;
    const settings: Record<string, unknown> = {
      // Disable the official telegram plugin to avoid bot token polling conflict
      // Our daemon manages Telegram via its own adapter
      enabledPlugins: { "telegram@claude-plugins-official": false },
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
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
