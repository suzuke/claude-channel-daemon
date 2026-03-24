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
import { TmuxPromptDetector } from "./approval/tmux-prompt-detector.js";
import type { CliBackend, CliBackendConfig } from "./backend/types.js";
import type { ApprovalStrategy } from "./backend/approval-strategy.js";
import { TelegramAdapter } from "./channel/adapters/telegram.js";
import { AccessManager } from "./channel/access-manager.js";
import type { ChannelAdapter, InboundMessage, ApprovalResponse } from "./channel/types.js";
import type { ContainerManager } from "./container-manager.js";
import { transcribe } from "./stt.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class Daemon {
  private logger: Logger;
  private tmux: TmuxManager | null = null;
  private ipcServer: IpcServer | null = null;
  private messageBus: MessageBus;
  private transcriptMonitor: TranscriptMonitor | null = null;
  private toolTracker: ToolTracker | null = null;
  private promptDetector: TmuxPromptDetector | null = null;
  private guardian: ContextGuardian | null = null;
  private memoryLayer: MemoryLayer | null = null;
  private adapter: ChannelAdapter | null = null;
  private pendingIpcRequests = new Map<string, (msg: Record<string, unknown>) => void>();
  // Track chatId/threadId from inbound messages for automatic outbound routing
  private lastChatId: string | undefined;
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
    private containerManager?: ContainerManager,
    private backend?: CliBackend,
    private approvalStrategyInstance?: ApprovalStrategy,
  ) {
    this.logger = createLogger(config.log_level);
    this.messageBus = new MessageBus();
    this.messageBus.setLogger(this.logger);
  }

  async start(): Promise<void> {
    mkdirSync(this.instanceDir, { recursive: true });
    writeFileSync(join(this.instanceDir, "daemon.pid"), String(process.pid));
    this.logger.info(`Starting ${this.name}`);

    // 1. IPC server — bridge between MCP server (Claude's child) and daemon
    const sockPath = join(this.instanceDir, "channel.sock");
    this.ipcServer = new IpcServer(sockPath, this.logger);
    await this.ipcServer.listen();

    // Permanent IPC dispatcher: routes responses to pending requests by type+id key
    this.ipcServer.on("message", (msg: Record<string, unknown>) => {
      const type = msg.type as string | undefined;
      if (!type) return;
      // Build lookup key matching the pattern used when registering
      let key: string | undefined;
      if (type === "fleet_schedule_response" && msg.fleetRequestId) {
        key = String(msg.fleetRequestId);
      } else if (type === "fleet_outbound_response" && msg.requestId != null) {
        key = `fleet_out_${msg.requestId}`;
      } else if (type === "fleet_approval_response" && msg.approvalId) {
        key = String(msg.approvalId);
      }
      if (key && this.pendingIpcRequests.has(key)) {
        const handler = this.pendingIpcRequests.get(key)!;
        this.pendingIpcRequests.delete(key);
        handler(msg);
      }
    });

    // IPC message relay: when daemon wants to push a channel message to Claude,
    // it broadcasts to all IPC clients (the MCP server is one of them).
    // When MCP server sends a tool_call, daemon handles it via the messageBus.
    this.ipcServer.on("message", (msg: Record<string, unknown>, socket: import("node:net").Socket) => {
      if (msg.type === "tool_call") {
        // MCP server forwarding a Claude tool call (reply, react, edit, download)
        this.handleToolCall(msg, socket);
      } else if (msg.type === "mcp_ready") {
        this.logger.debug("MCP channel server connected and ready");
      } else if (msg.type === "fleet_inbound") {
        // Fleet manager routed a message to us (topic mode)
        const meta = msg.meta as Record<string, string>;
        if (meta.chat_id) this.lastChatId = meta.chat_id;
        if (meta.thread_id) this.lastThreadId = meta.thread_id;
        this.pushChannelMessage(msg.content as string, meta);
      } else if (msg.type === "fleet_schedule_trigger") {
        const payload = msg.payload as Record<string, unknown>;
        const meta = msg.meta as Record<string, string>;
        this.lastChatId = meta.chat_id;
        this.lastThreadId = meta.thread_id;
        this.pushChannelMessage(payload.message as string, meta);
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

        // Wire inbound messages → transcribe voice if present, then push to Claude via IPC
        this.messageBus.on("message", async (msg: InboundMessage) => {
          if (msg.chatId) this.lastChatId = msg.chatId;
          if (msg.threadId) this.lastThreadId = msg.threadId;

          let text = msg.text;
          const extraMeta: Record<string, string> = {};

          if (this.adapter) {
            const tgAdapter = this.adapter as TelegramAdapter;

            // Auto-download photos so Claude can Read them directly
            const photoAttachment = msg.attachments?.find(a => a.kind === "photo");
            if (photoAttachment) {
              try {
                const localPath = await tgAdapter.downloadAttachment(photoAttachment.fileId);
                extraMeta.image_path = localPath;
              } catch (err) {
                this.logger.warn({ err: (err as Error).message }, "Photo download failed");
              }
            }

            // Transcribe voice/audio
            const voiceAttachment = msg.attachments?.find(a => a.kind === "voice" || a.kind === "audio");
            if (voiceAttachment) {
              const groqKey = process.env.GROQ_API_KEY;
              if (groqKey) {
                try {
                  const localPath = await tgAdapter.downloadAttachment(voiceAttachment.fileId);
                  const result = await transcribe(localPath, groqKey);
                  try { unlinkSync(localPath); } catch { /* ignore */ }
                  text = text ? `${text}\n\n[語音訊息] ${result.text}` : `[語音訊息] ${result.text}`;
                  this.logger.info({ transcription: result.text.slice(0, 80) }, "Voice transcribed");
                } catch (err) {
                  this.logger.warn({ err: (err as Error).message }, "Voice transcription failed");
                  text = text || "[語音訊息 — 轉錄失敗]";
                }
              } else {
                text = text || "[語音訊息 — 未設定 STT API key]";
              }
              extraMeta.attachment_file_id = voiceAttachment.fileId;
            }

            // Pass other attachment types as file_id for manual download
            const otherAttachment = msg.attachments?.find(a =>
              a.kind !== "photo" && a.kind !== "voice" && a.kind !== "audio",
            );
            if (otherAttachment) {
              extraMeta.attachment_file_id = otherAttachment.fileId;
            }
          }

          this.pushChannelMessage(text, {
            chat_id: msg.chatId,
            message_id: msg.messageId,
            user: msg.username,
            user_id: msg.userId,
            ts: msg.timestamp.toISOString(),
            ...(msg.threadId ? { thread_id: msg.threadId } : {}),
            ...extraMeta,
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
          this.saveSessionId();
          await oldTmux.killWindow();
          this.logger.info({ savedId }, "Killed old tmux window for fresh start");
        }
      }
    }

    await this.spawnClaudeWindow();

    // 3. Pipe-pane for prompt detection
    const outputLog = join(this.instanceDir, "output.log");
    await this.tmux.pipeOutput(outputLog);

    // 4. Transcript monitor
    this.transcriptMonitor = new TranscriptMonitor(this.instanceDir, this.logger);

    // 5. Wire transcript events (tool status in Telegram disabled for now)
    this.transcriptMonitor.on("tool_use", (name: string, _input: unknown) => {
      this.logger.debug({ tool: name }, "Tool use");
    });
    this.transcriptMonitor.on("tool_result", (_name: string, _output: unknown) => {
      // no-op
    });
    this.transcriptMonitor.on("assistant_text", (text: string) => {
      this.logger.debug({ text: text.slice(0, 200) }, "Claude response");
    });
    this.transcriptMonitor.startPolling();

    // 6. Approval server
    let port = this.config.approval_port ?? 18321;
    if (this.approvalStrategyInstance) {
      port = await this.approvalStrategyInstance.start();
      this.logger.debug({ port }, "Approval strategy started");
    }

    // 7. Prompt detector
    // In topic mode, messageBus has no adapters — must route via IPC like ApprovalServer does
    const requestApproval = (prompt: string): Promise<ApprovalResponse> => {
      if (this.topicMode && this.ipcServer) {
        return this.requestApprovalViaIpc(prompt);
      }
      return this.messageBus.requestApproval(prompt);
    };
    this.promptDetector = new TmuxPromptDetector(
      outputLog,
      this.tmux,
      requestApproval,
      this.logger,
      this.instanceDir,
    );
    this.promptDetector.startPolling();

    // 8. Context guardian
    const statusFile = join(this.instanceDir, "statusline.json");
    this.guardian = new ContextGuardian(this.config.context_guardian, this.logger, statusFile);
    this.guardian.startWatching();
    this.guardian.startTimer();

    this.guardian.on("status_update", () => this.saveSessionId());
    this.guardian.on("pending", async () => {
      this.logger.info("Context rotation pending — waiting for transcript to settle");
      await this.waitForTranscriptIdle(15000);
      this.logger.info("Claude is idle — signaling");
      this.guardian?.signalIdle();
    });

    this.guardian.on("request_handover", async () => {
      this.logger.info("Sending handover prompt to Claude");
      if (this.tmux) {
        const reason = this.guardian?.rotationReason ?? "context_full";
        const pct = this.readContextPercentage();
        const reasonMsg = reason === "max_age"
          ? `Scheduled rotation — session age limit reached (context usage: ${pct}%, NOT full).`
          : `Context rotation — usage at ${pct}%, approaching threshold.`;
        const prompt = `${reasonMsg} Use the reply tool to tell the user: quote the EXACT percentage ${pct}% and the reason (${reason === "max_age" ? "scheduled maintenance" : "context approaching limit"}). Do NOT change or invent numbers. Then save state to memory/handover.md`;
        await this.tmux.sendKeys(prompt);
        await new Promise(r => setTimeout(r, 500));
        await this.tmux.sendSpecialKey("Enter");
      }

      this.waitForHandoverSignal();
    });

    this.guardian.on("rotate", async () => {
      this.logger.info("Context rotation — killing and respawning Claude");
      this.saveSessionId();

      await this.tmux?.killWindow();
      this.transcriptMonitor?.resetOffset();
      await this.spawnClaudeWindow();
      this.guardian?.markRotationComplete();
      this.logger.info("Context rotation complete — fresh Claude session started");
    });

    // 9. Memory layer
    if (this.config.memory.watch_memory_dir || this.config.memory.backup_to_sqlite) {
      const dbPath = join(this.instanceDir, "memory.db");
      const db = new MemoryDb(dbPath);
      db.pruneOldBackups();
      const memDir =
        this.config.memory_directory ??
        join(
          homedir(),
          ".claude/projects",
          this.config.working_directory.replace(/\//g, "-").replace(/^-/, ""),
          "memory",
        );
      mkdirSync(memDir, { recursive: true });
      this.memoryLayer = new MemoryLayer(memDir, db, this.logger);
      await this.memoryLayer.start();
    }

    // Set CCD_SOCKET_PATH env for MCP server
    process.env.CCD_SOCKET_PATH = sockPath;

    this.logger.info(`${this.name} ready (port ${port})`);
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping daemon instance");
    this.promptDetector?.stop();
    this.transcriptMonitor?.stop();
    this.guardian?.stop();
    if (this.memoryLayer) await this.memoryLayer.stop();
    if (this.adapter) await this.adapter.stop();
    await this.approvalStrategyInstance?.stop();
    await this.ipcServer?.close();
    // Strategy A: kill window on stop, resume via --resume on next start
    // MCP server has no reconnection → keeping window alive would leave
    // Claude without channel/approval connectivity
    if (this.tmux) {
      this.saveSessionId();
      await this.tmux.killWindow();
      const windowIdFile = join(this.instanceDir, "window-id");
      try { unlinkSync(windowIdFile); } catch (e) { this.logger.debug({ err: e }, "Failed to remove window-id file"); }
    }
    // Clean up backend config files
    if (this.backend?.cleanup) {
      this.backend.cleanup(this.buildBackendConfig());
    }

    const pidPath = join(this.instanceDir, "daemon.pid");
    try {
      unlinkSync(pidPath);
    } catch (e) {
      this.logger.debug({ err: e }, "Failed to remove PID file");
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
      const chatId = this.lastChatId ?? "";
      if (!chatId) return; // No inbound message yet — nowhere to send
      if (!this.toolStatusMessageId) {
        adapter.sendText(chatId, text, { threadId: this.lastThreadId })
          .then(sent => { this.toolStatusMessageId = sent.messageId; })
          .catch(e => this.logger.debug({ err: e }, "Failed to send tool status message"));
      } else {
        adapter.editMessage(chatId, this.toolStatusMessageId, text)
          .catch(e => this.logger.debug({ err: e }, "Failed to edit tool status message"));
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
    this.logger.debug({ user: meta.user, text: content.slice(0, 100) }, "Pushed channel message to Claude");
  }

  /**
   * Handle a tool call from the MCP server (forwarded by Claude).
   * Routes to the channel adapter via MessageBus.
   */
  private handleToolCall(msg: Record<string, unknown>, socket: import("node:net").Socket): void {
    const tool = msg.tool as string;
    const args = (msg.args ?? {}) as Record<string, unknown>;
    const requestId = msg.requestId as number;

    this.logger.debug({ tool, requestId }, "Tool call from MCP server");

    // For now, log and respond. Full adapter routing will be wired in fleet manager.
    const respond = (result: unknown, error?: string) => {
      this.ipcServer?.send(socket, { requestId, result, error });
    };

    // Schedule tools → route to fleet manager
    const SCHEDULE_TOOLS = new Set(["create_schedule", "list_schedules", "update_schedule", "delete_schedule"]);

    if (SCHEDULE_TOOLS.has(tool)) {
      const typeMap: Record<string, string> = {
        create_schedule: "fleet_schedule_create",
        list_schedules: "fleet_schedule_list",
        update_schedule: "fleet_schedule_update",
        delete_schedule: "fleet_schedule_delete",
      };

      // Use fleetRequestId (not requestId) to avoid MCP server resolving the
      // pending tool call prematurely when it receives the broadcast.
      const fleetReqId = `sched_${requestId}`;
      this.ipcServer?.broadcast({
        type: typeMap[tool],
        payload: args,
        meta: { chat_id: this.lastChatId, thread_id: this.lastThreadId, instance_name: this.name },
        fleetRequestId: fleetReqId,
      });

      // Wait for fleet_schedule_response via pending request map
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(fleetReqId);
        respond(null, "Schedule operation timed out after 30s");
      }, 30_000);
      this.pendingIpcRequests.set(fleetReqId, (respMsg) => {
        clearTimeout(timeout);
        respond(respMsg.result, respMsg.error as string | undefined);
      });
      return;
    }

    // Route to adapter via MessageBus
    const adapters = this.messageBus.getAllAdapters();
    if (adapters.length === 0) {
      // Topic mode: forward to fleet manager via IPC (fleet manager connected as IPC client)
      // The fleet manager's IPC client receives this and routes to shared adapter
      const outboundKey = `fleet_out_${requestId}`;
      this.ipcServer?.broadcast({ type: "fleet_outbound", tool, args, requestId });
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(outboundKey);
        respond(null, "Fleet outbound timed out after 30s");
      }, 30_000);
      this.pendingIpcRequests.set(outboundKey, (respMsg) => {
        clearTimeout(timeout);
        respond(respMsg.result, respMsg.error as string | undefined);
      });
      return;
    }

    const adapter = adapters[0];
    const chatId = args.chat_id as string ?? "";

    switch (tool) {
      case "reply": {
        const files = Array.isArray(args.files) ? args.files as string[] : [];
        const threadId = args.thread_id as string ?? this.lastThreadId;
        adapter.sendText(chatId, args.text as string ?? "", {
          threadId,
          replyTo: args.reply_to as string,
        }).then(async (sent) => {
          for (const filePath of files) {
            await adapter.sendFile(chatId, filePath, { threadId });
          }
          respond(sent);
        }).catch(e => respond(null, e.message));
        break;
      }
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

  /** Topic mode: forward approval request to fleet manager via IPC (mirrors ApprovalServer logic) */
  private requestApprovalViaIpc(prompt: string): Promise<ApprovalResponse> {
    return new Promise((resolve) => {
      const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(approvalId);
        resolve({ decision: "deny", respondedBy: { channelType: "timeout", userId: "" } });
      }, 120_000);

      this.pendingIpcRequests.set(approvalId, (msg) => {
        clearTimeout(timeout);
        const d = msg.decision as string;
        const decision = d === "deny" ? "deny" as const : d === "always_allow" ? "always_allow" as const : "approve" as const;
        resolve({ decision, respondedBy: { channelType: "ipc", userId: "" } });
      });

      this.ipcServer?.broadcast({
        type: "fleet_approval_request",
        approvalId,
        instanceName: this.name,
        prompt,
      });
    });
  }


  /** Build config object for the CLI backend */
  private buildBackendConfig(): CliBackendConfig {
    const sockPath = join(this.instanceDir, "channel.sock");
    let serverJs = join(__dirname, "channel", "mcp-server.js");
    if (!existsSync(serverJs)) {
      serverJs = join(__dirname, "..", "dist", "channel", "mcp-server.js");
    }
    return {
      workingDirectory: this.config.working_directory,
      instanceDir: this.instanceDir,
      instanceName: this.name,
      approvalPort: this.config.approval_port ?? 18321,
      mcpServers: {
        "ccd-channel": {
          command: "node",
          args: [serverJs],
          env: { CCD_SOCKET_PATH: sockPath },
        },
      },
      approvalStrategy: this.approvalStrategyInstance!,
      containerManager: this.containerManager,
    };
  }

  /** Spawn (or respawn) a Claude window in tmux */
  private async spawnClaudeWindow(): Promise<void> {
    if (!this.backend) {
      throw new Error("No backend configured — cannot spawn Claude window");
    }
    const backendConfig = this.buildBackendConfig();
    this.backend.writeConfig(backendConfig);
    let claudeCmd = this.backend.buildCommand(backendConfig);

    // Sandbox shell is shared across backends — daemon handles it
    if (this.containerManager) {
      const shellPath = this.writeSandboxShell();
      claudeCmd = `CLAUDE_CODE_SHELL=${shellPath} ${claudeCmd}`;
    }

    const windowId = await this.tmux!.createWindow(claudeCmd, this.config.working_directory);
    const windowIdFile = join(this.instanceDir, "window-id");
    writeFileSync(windowIdFile, windowId);

    // Post-launch setup (auto-confirm prompts for Claude Code)
    if (this.backend.postLaunch) {
      this.backend.postLaunch(this.tmux!, windowId).then(() => {
        this.logger.debug("Post-launch setup completed");
      }).catch(err => {
        this.logger.warn({ err }, "Post-launch setup failed or timed out — manually run: tmux send-keys -t ccd:${this.tmux?.getWindowId()} Enter");
      });
    }
  }

  private saveSessionId(): void {
    const sid = this.backend?.getSessionId();
    if (sid) {
      writeFileSync(join(this.instanceDir, "session-id"), sid);
    }
  }

  private readContextPercentage(): number {
    return this.backend?.getContextUsage() ?? 0;
  }

  /** Debounce-based idle: resolves when no transcript events for `quietMs`. */
  private waitForTranscriptIdle(quietMs = 5000): Promise<void> {
    return new Promise((resolve) => {
      const events = ["tool_use", "tool_result", "assistant_text", "channel_message"];
      let timer: ReturnType<typeof setTimeout>;

      const done = () => {
        events.forEach(e => this.transcriptMonitor?.removeListener(e, reset));
        resolve();
      };
      const reset = () => {
        clearTimeout(timer);
        timer = setTimeout(done, quietMs);
      };

      timer = setTimeout(done, quietMs);
      events.forEach(e => this.transcriptMonitor?.on(e, reset));
    });
  }

  private async waitForHandoverSignal(): Promise<void> {
    // Wait for transcript activity to settle (no events for 5s = idle).
    // This is event-driven — no pane scraping needed.
    this.logger.info("Waiting for transcript to settle");
    await this.waitForTranscriptIdle(15000);
    this.logger.info("Transcript settled — handover complete");
    this.guardian?.signalHandoverComplete();
  }

  /** Generate sandbox-bash wrapper script that forwards Bash commands to Docker */
  private writeSandboxShell(): string {
    const scriptPath = join(this.instanceDir, "sandbox-bash");
    const script = `#!/bin/bash
# Sandbox shell: forwards Bash tool commands to the shared Docker container.
# Claude Code runs on host; only Bash execution is sandboxed.
exec docker exec -i -w "$(pwd)" ccd-shared /bin/bash "$@"
`;
    writeFileSync(scriptPath, script, { mode: 0o755 });
    return scriptPath;
  }

}
