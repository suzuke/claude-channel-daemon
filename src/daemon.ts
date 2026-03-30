import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { InstanceConfig } from "./types.js";
import { createLogger, type Logger } from "./logger.js";
import { TmuxManager } from "./tmux-manager.js";
import { TranscriptMonitor } from "./transcript-monitor.js";
import { ContextGuardian } from "./context-guardian.js";
import { IpcServer } from "./channel/ipc-bridge.js";
import { MessageBus } from "./channel/message-bus.js";
import { ToolTracker } from "./channel/tool-tracker.js";
import type { CliBackend, CliBackendConfig } from "./backend/types.js";
import { createAdapter } from "./channel/factory.js";
import { AccessManager } from "./channel/access-manager.js";
import type { ChannelAdapter, InboundMessage, ApprovalResponse, PermissionPrompt } from "./channel/types.js";
import { processAttachments } from "./channel/attachment-handler.js";
import { routeToolCall } from "./channel/tool-router.js";
import { generateFleetSystemPrompt } from "./fleet-system-prompt.js";
import { HangDetector } from "./hang-detector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class Daemon extends EventEmitter {
  private logger: Logger;
  private tmux: TmuxManager | null = null;
  private ipcServer: IpcServer | null = null;
  private messageBus: MessageBus;
  private transcriptMonitor: TranscriptMonitor | null = null;
  private toolTracker: ToolTracker | null = null;
  private guardian: ContextGuardian | null = null;
  private adapter: ChannelAdapter | null = null;
  private pendingIpcRequests = new Map<string, (msg: Record<string, unknown>) => void>();
  // Track chatId/threadId from inbound messages for automatic outbound routing
  private lastChatId: string | undefined;
  private lastThreadId: string | undefined;
  // Pending ack: react 🫡 on first transcript activity after receiving a message
  private pendingAckMessage: { chatId: string; messageId: string } | null = null;
  // Tool status tracking for Telegram
  private toolStatusMessageId: string | null = null;
  private toolStatusLines: string[] = [];
  private toolStatusDebounce: ReturnType<typeof setTimeout> | null = null;
  // Session identity: map IPC socket → sessionName (from mcp_ready)
  private socketSessionNames = new Map<import("node:net").Socket, string>();
  // Crash recovery
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private crashCount = 0;
  private lastCrashAt = 0;
  // Context rotation quality tracking
  private rotationStartedAt = 0;
  private preRotationContextPct = 0;
  private hangDetector: HangDetector | null = null;
  // Model failover: override model on next spawn when rate-limited
  private modelOverride: string | undefined;

  constructor(
    private name: string,
    private config: InstanceConfig,
    private instanceDir: string,
    private topicMode = false,
    private backend?: CliBackend,
  ) {
    super();
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
      if ((type === "fleet_schedule_response" || type === "fleet_outbound_response") && msg.fleetRequestId) {
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
      } else if (msg.type === "permission_request") {
        this.handlePermissionRequest(msg, socket);
      } else if (msg.type === "mcp_ready") {
        const sessionName = msg.sessionName as string | undefined;
        if (sessionName) {
          this.socketSessionNames.set(socket, sessionName);
          socket.on("close", () => {
            this.socketSessionNames.delete(socket);
            // Notify fleet manager so it can clean up sessionRegistry
            if (sessionName !== this.name) {
              this.ipcServer?.broadcast({ type: "session_disconnected", sessionName });
            }
          });
        }
        this.logger.debug({ sessionName }, "MCP channel server connected and ready");
        // Notify FleetManager's IPC client that MCP is ready
        this.ipcServer?.broadcast({ type: "mcp_ready", sessionName });
      } else if (msg.type === "query_sessions") {
        // Fleet manager asks for all registered session names (catches sessions
        // that sent mcp_ready before fleet manager connected).
        const sessions: string[] = [];
        for (const [s, sessionName] of this.socketSessionNames) {
          if (!s.destroyed && sessionName !== this.name) {
            // Individual mcp_ready for initial registration path
            this.ipcServer?.send(socket, { type: "mcp_ready", sessionName });
            sessions.push(sessionName);
          }
        }
        // Batch response for prune path
        this.ipcServer?.send(socket, { type: "query_sessions_response", sessions });
      } else if (msg.type === "fleet_inbound") {
        // Fleet manager routed a message to us (topic mode)
        const meta = msg.meta as Record<string, string>;
        const targetSession = msg.targetSession as string | undefined;
        // Only update lastChatId/lastThreadId from real Telegram messages (non-empty chat_id).
        // Cross-instance messages have empty chat_id and must not overwrite these.
        if (meta.chat_id) this.lastChatId = meta.chat_id;
        if (meta.chat_id && meta.thread_id) this.lastThreadId = meta.thread_id;
        this.pushChannelMessage(msg.content as string, meta, targetSession);
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

    // @deprecated DM mode — will be removed in a future version
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
        this.adapter = await createAdapter(this.config.channel!, {
          id: `dm-${this.name}`,
          botToken,
          accessManager,
          inboxDir,
        });
        this.messageBus.register(this.adapter);

        // Wire inbound messages → transcribe voice if present, then push to Claude via IPC
        this.messageBus.on("message", async (msg: InboundMessage) => {
          if (msg.chatId) this.lastChatId = msg.chatId;
          if (msg.threadId) this.lastThreadId = msg.threadId;

          // Auto-react 👀 so sender knows the message was received
          if (this.adapter && msg.chatId && msg.messageId) {
            this.adapter.react(msg.chatId, msg.messageId, "👀")
              .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
            this.pendingAckMessage = { chatId: msg.chatId, messageId: msg.messageId };
          }

          let text = msg.text;
          let extraMeta: Record<string, string> = {};

          if (this.adapter) {
            const result = await processAttachments(msg, this.adapter, this.logger);
            text = result.text;
            extraMeta = result.extraMeta;
          }

          this.pushChannelMessage(text, {
            chat_id: msg.chatId,
            message_id: msg.messageId,
            user: msg.username,
            user_id: msg.userId,
            ts: msg.timestamp.toISOString(),
            ...(msg.threadId ? { thread_id: msg.threadId } : {}),
            ...(msg.replyToText ? { reply_to_text: msg.replyToText } : {}),
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

    if (!this.config.lightweight) {
      // 3. Pipe-pane for prompt detection
      const outputLog = join(this.instanceDir, "output.log");
      await this.tmux.pipeOutput(outputLog);

      // 4. Transcript monitor
      this.transcriptMonitor = new TranscriptMonitor(this.instanceDir, this.logger);

      // 5. Wire transcript events
      const ackIfPending = () => {
        if (!this.pendingAckMessage || !this.adapter) return;
        const { chatId, messageId } = this.pendingAckMessage;
        this.pendingAckMessage = null;
        this.adapter.react(chatId, messageId, "🫡")
          .catch(e => this.logger.debug({ err: (e as Error).message }, "Ack react failed"));
      };
      this.transcriptMonitor.on("tool_use", (name: string, _input: unknown) => {
        this.logger.debug({ tool: name }, "Tool use");
        ackIfPending();
        this.hangDetector?.recordActivity();
      });
      this.transcriptMonitor.on("tool_result", (_name: string, _output: unknown) => {
        this.hangDetector?.recordActivity();
      });
      this.transcriptMonitor.on("assistant_text", (text: string) => {
        this.logger.debug({ text: text.slice(0, 200) }, "Claude response");
        ackIfPending();
        this.hangDetector?.recordActivity();
      });
      this.transcriptMonitor.startPolling();

      // Hang detector
      this.hangDetector = new HangDetector(15);
      this.hangDetector.start();

      // 8. Context guardian
      const statusFile = join(this.instanceDir, "statusline.json");
      this.guardian = new ContextGuardian(this.config.context_guardian, this.logger, statusFile);
      this.guardian.startWatching();
      this.guardian.startTimer();

      this.guardian.on("status_update", () => {
        this.saveSessionId();
        this.hangDetector?.recordStatuslineUpdate();
      });
      this.guardian.on("pending", async () => {
        this.logger.info("Context rotation pending — waiting for transcript to settle");
        await this.waitForTranscriptIdle(15000);
        this.logger.info("Claude is idle — signaling");
        this.guardian?.signalIdle();
      });

      this.guardian.on("request_handover", async () => {
        this.rotationStartedAt = Date.now();
        this.preRotationContextPct = this.readContextPercentage();
        this.logger.info("Sending handover prompt to Claude");
        if (this.tmux) {
          const reason = this.guardian?.rotationReason ?? "context_full";
          const pct = this.readContextPercentage();
          const notifyLine = reason === "max_age"
            ? `Scheduled rotation — session age limit reached (context usage: ${pct}%, NOT full).`
            : `Context rotation — usage at ${pct}%, approaching threshold. Use the reply tool to tell the user: quote the EXACT percentage ${pct}% and the reason (context approaching limit). Do NOT change or invent numbers.`;
          const prompt = `${notifyLine} Save state to memory/handover.md using this EXACT structure:\n\n## Active Tasks\nWhat you are working on right now.\n\n## Progress\nWhat is done, what remains.\n\n## Decisions\nImportant decisions made and why.\n\n## Next Steps\nWhat the next session should do first.\n\n## Blockers\nOpen questions or issues (write "None" if none).${reason === "max_age" ? " Do NOT notify the user." : ""}`;
          await this.tmux.sendKeys(prompt);
          await new Promise(r => setTimeout(r, 500));
          await this.tmux.sendSpecialKey("Enter");
        }

        this.waitForHandoverSignal();
      });

      this.guardian.on("rotate", async () => {
        this.logger.info("Context rotation — killing and respawning Claude");
        this.saveSessionId();

        // Track rotation quality
        const durationMs = Date.now() - this.rotationStartedAt;
        const validation = this.validateHandover();
        let handoverStatus: "complete" | "timeout" | "empty" = "empty";
        if (validation.wordCount > 0) {
          handoverStatus = validation.valid ? "complete" : "timeout";
        }
        this.emit("rotation_quality", {
          instance: this.name,
          handover_status: handoverStatus,
          duration_ms: durationMs,
          previous_context_pct: this.preRotationContextPct,
          missing_sections: validation.missing,
          word_count: validation.wordCount,
        });

        await this.tmux?.killWindow();
        this.transcriptMonitor?.resetOffset();
        await this.spawnClaudeWindow();
        this.guardian?.markRotationComplete();
        this.logger.info("Context rotation complete — fresh Claude session started");
      });

    }

    // Set CCD_SOCKET_PATH env for MCP server
    process.env.CCD_SOCKET_PATH = sockPath;

    // 10. Health check — detect crashed tmux window and respawn
    if (!this.config.lightweight) {
      this.startHealthCheck();
    }

    this.logger.info(`${this.name} ready`);
  }

  private startHealthCheck(): void {
    const { max_retries, backoff, reset_after } = this.config.restart_policy;
    if (max_retries <= 0) return; // restart disabled

    this.healthCheckTimer = setInterval(async () => {
      if (!this.tmux || this.guardian?.state === "ROTATING") return;

      const alive = await this.tmux.isWindowAlive();
      if (alive) return;

      // Reset crash count if enough time has passed
      if (reset_after > 0 && Date.now() - this.lastCrashAt > reset_after) {
        this.crashCount = 0;
      }

      this.crashCount++;
      this.lastCrashAt = Date.now();

      if (this.crashCount > max_retries) {
        this.logger.error({ crashCount: this.crashCount, maxRetries: max_retries }, "Max crash retries exceeded — not respawning");
        return;
      }

      // Calculate backoff delay
      const delay = backoff === "exponential"
        ? Math.min(1000 * Math.pow(2, this.crashCount - 1), 60_000)
        : 1000 * this.crashCount;

      this.logger.warn({ crashCount: this.crashCount, delay }, "Claude window died — respawning after backoff");

      await new Promise(r => setTimeout(r, delay));

      try {
        this.saveSessionId();
        this.transcriptMonitor?.resetOffset();
        await this.spawnClaudeWindow();
        this.logger.info("Respawned Claude window after crash");
      } catch (err) {
        this.logger.error({ err }, "Failed to respawn Claude window");
      }
    }, 10_000); // Check every 10 seconds
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping daemon instance");
    if (this.healthCheckTimer) { clearInterval(this.healthCheckTimer); this.healthCheckTimer = null; }
    if (this.toolStatusDebounce) { clearTimeout(this.toolStatusDebounce); this.toolStatusDebounce = null; }
    this.pendingIpcRequests.clear();
    this.hangDetector?.stop();
    this.transcriptMonitor?.stop();
    this.guardian?.stop();
    if (this.adapter) await this.adapter.stop();
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

  getHangDetector(): HangDetector | null {
    return this.hangDetector;
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
      // @deprecated DM mode: send directly via adapter
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
   * Push an inbound channel message to a specific MCP session.
   * If targetSession is provided, only send to the matching socket.
   * Otherwise send to the instance's own session (this.name).
   */
  pushChannelMessage(content: string, meta: Record<string, string>, targetSession?: string): void {
    if (!this.ipcServer) {
      this.logger.warn("Cannot push channel message: IPC server not running");
      return;
    }
    const msg = { type: "channel_message", content, meta };
    const target = targetSession ?? this.name;
    const socket = this.findSocketBySession(target);
    if (socket) {
      this.ipcServer.send(socket, msg);
    } else if (targetSession && targetSession !== this.name) {
      // Target session specified but not connected — don't broadcast to avoid
      // delivering cross-instance messages to the wrong Claude session.
      this.logger.warn({ targetSession }, "Target session not connected, message dropped");
    } else {
      // Own session not yet registered — broadcast as fallback
      this.ipcServer.broadcast(msg);
    }
    this.logger.debug({ user: meta.user, targetSession: target, text: content.slice(0, 100) }, "Pushed channel message");
  }

  /** Find the IPC socket for a given sessionName */
  private findSocketBySession(sessionName: string): import("node:net").Socket | undefined {
    for (const [socket, name] of this.socketSessionNames) {
      if (name === sessionName && !socket.destroyed) return socket;
    }
    return undefined;
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
    const CROSS_INSTANCE_TOOLS = new Set(["send_to_instance", "list_instances", "start_instance", "create_instance", "delete_instance", "request_information", "delegate_task", "report_result", "describe_instance"]);
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

    if (CROSS_INSTANCE_TOOLS.has(tool)) {
      // Route to fleet manager via IPC (topic mode only)
      if (this.topicMode && this.ipcServer) {
        // Use fleetRequestId (not requestId) to avoid MCP server resolving the
        // pending tool call prematurely when it receives the broadcast.
        const fleetReqId = `xmsg_${requestId}`;
        const senderSessionName = this.socketSessionNames.get(socket);
        this.ipcServer.broadcast({
          type: "fleet_outbound",
          tool,
          args,
          fleetRequestId: fleetReqId,
          senderSessionName,
        });
        const crossTimeoutMs = (tool === "start_instance" || tool === "create_instance") ? 60_000 : 30_000;
        const timeout = setTimeout(() => {
          this.pendingIpcRequests.delete(fleetReqId);
          respond(null, `Cross-instance operation timed out after ${crossTimeoutMs / 1000}s`);
        }, crossTimeoutMs);
        this.pendingIpcRequests.set(fleetReqId, (respMsg) => {
          clearTimeout(timeout);
          respond(respMsg.result, respMsg.error as string | undefined);
        });
      } else {
        respond(null, "Cross-instance messaging requires topic mode");
      }
      return;
    }

    // Route to adapter via MessageBus
    const adapters = this.messageBus.getAllAdapters();
    if (adapters.length === 0) {
      // Topic mode: forward to fleet manager via IPC (fleet manager connected as IPC client)
      // The fleet manager's IPC client receives this and routes to shared adapter.
      // Use fleetRequestId (not requestId) to avoid other MCP sessions on this daemon
      // from prematurely resolving their pending requests when they receive the broadcast.
      const fleetReqId = `tool_${requestId}`;
      const outboundKey = fleetReqId;
      this.ipcServer?.broadcast({ type: "fleet_outbound", tool, args, fleetRequestId: fleetReqId });
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

    if (!routeToolCall(adapter, tool, args, this.lastThreadId, respond)) {
      respond(null, `Unknown tool: ${tool}`);
    }
  }

  /** Handle a permission_request IPC message from the MCP server */
  private async handlePermissionRequest(msg: Record<string, unknown>, socket: import("node:net").Socket): Promise<void> {
    const requestId = msg.requestId as number;
    const request_id = msg.request_id as string;
    const prompt: PermissionPrompt = {
      tool_name: msg.tool_name as string,
      description: msg.description as string,
      input_preview: msg.input_preview as string | undefined,
    };

    try {
      let result: ApprovalResponse;
      if (this.topicMode && this.ipcServer) {
        result = await this.requestApprovalViaIpc(prompt);
      } else {
        result = await this.messageBus.requestApproval(prompt);
      }

      const isApprove = result.decision === "approve" || result.decision === "approve_always";
      const behavior = isApprove ? "allow" : "deny";
      this.ipcServer?.send(socket, {
        requestId,
        result: { request_id, behavior },
      });

      if (result.decision === "approve_always") {
        this.addToolPermission(prompt.tool_name);
      }

      // If denied due to timeout, inform Claude so it can distinguish from explicit rejection
      if (behavior === "deny" && result.respondedBy?.channelType === "timeout") {
        this.pushChannelMessage(
          `[System] Permission request for \`${prompt.tool_name}\` timed out — user may be away.`,
          { chat_id: this.lastChatId ?? "", ts: new Date().toISOString() },
        );
      }
    } catch (err) {
      this.ipcServer?.send(socket, {
        requestId,
        result: { request_id, behavior: "deny" },
      });
    }
  }

  /** Topic mode: forward approval request to fleet manager via IPC */
  private requestApprovalViaIpc(prompt: PermissionPrompt): Promise<ApprovalResponse> {
    return new Promise((resolve) => {
      const approvalId = `approval-${randomUUID()}`;

      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(approvalId);
        resolve({ decision: "deny", respondedBy: { channelType: "timeout", userId: "" } });
      }, 120_000);

      this.pendingIpcRequests.set(approvalId, (msg) => {
        clearTimeout(timeout);
        const d = msg.decision as string;
        const decision = d === "approve" ? "approve" as const
          : d === "approve_always" ? "approve_always" as const
          : "deny" as const;
        resolve({ decision, respondedBy: { channelType: "fleet", userId: "" } });
      });

      this.ipcServer?.broadcast({
        type: "fleet_approval_request",
        approvalId,
        instanceName: this.name,
        prompt,
      });
    });
  }


  /** Add a tool to the persistent permission allow list in claude-settings.json */
  private addToolPermission(toolName: string): void {
    const settingsPath = join(this.instanceDir, "claude-settings.json");
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const allow: string[] = settings.permissions?.allow ?? [];
      if (!allow.includes(toolName)) {
        allow.push(toolName);
        settings.permissions.allow = allow;
        writeFileSync(settingsPath, JSON.stringify(settings));
        this.logger.info({ toolName }, "Added tool to permission allow list");
      }
    } catch (err) {
      this.logger.warn({ err, toolName }, "Failed to update claude-settings.json");
    }
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
      mcpServers: {
        "ccd-channel": {
          command: "node",
          args: [serverJs],
          env: { CCD_SOCKET_PATH: sockPath },
        },
      },
      systemPrompt: this.buildSystemPrompt(),
      skipPermissions: this.config.skipPermissions,
      model: this.modelOverride ?? this.config.model,
    };
  }

  /** Combine fleet context with user-configured system prompt */
  private buildSystemPrompt(): string {
    const fleetContext = generateFleetSystemPrompt({
      instanceName: this.name,
      workingDirectory: this.config.working_directory,
    });
    if (this.config.systemPrompt) {
      return fleetContext + "\n\n" + this.config.systemPrompt;
    }
    return fleetContext;
  }

  /** Spawn (or respawn) a Claude window in tmux */
  private async spawnClaudeWindow(): Promise<void> {
    // Clear tool status from previous session
    this.toolStatusLines = [];
    this.toolStatusMessageId = null;
    if (!this.backend) {
      throw new Error("No backend configured — cannot spawn Claude window");
    }
    const backendConfig = this.buildBackendConfig();
    this.backend.writeConfig(backendConfig);
    // Inject CCD_INSTANCE_NAME via shell env (not .mcp.json) so internal sessions
    // are distinguishable from external sessions sharing the same .mcp.json
    let claudeCmd = `CCD_INSTANCE_NAME=${this.name} ` + this.backend.buildCommand(backendConfig);

    const windowId = await this.tmux!.createWindow(claudeCmd, this.config.working_directory, this.name);
    const windowIdFile = join(this.instanceDir, "window-id");
    writeFileSync(windowIdFile, windowId);

    // Grace period for Claude Code to render any confirmation prompts,
    // then auto-confirm by sending Enter (dismisses "I am using this for
    // local development" and "New MCP server found" prompts).
    await new Promise(r => setTimeout(r, 10_000));
    try { await this.tmux!.sendSpecialKey("Enter"); } catch { /* window may have exited */ }
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

  /** Set a model override for next spawn (used by failover logic) */
  setModelOverride(model: string | undefined): void {
    this.modelOverride = model;
  }

  /** Get the currently active model override */
  getModelOverride(): string | undefined {
    return this.modelOverride;
  }

  /** Public wrapper for graceful restart — wait for instance to be idle. */
  waitForIdle(quietMs = 5000): Promise<void> {
    return this.waitForTranscriptIdle(quietMs);
  }

  /** Send a save-state prompt to Claude, wait for it to settle, then stop. */
  async gracefulStop(): Promise<void> {
    if (this.tmux && await this.tmux.isWindowAlive()) {
      this.logger.info("Sending save-state prompt before shutdown");
      await this.tmux.sendKeys("The system is shutting down. Please save any important state to memory files now. You have 30 seconds.");
      await new Promise(r => setTimeout(r, 500));
      await this.tmux.sendSpecialKey("Enter");

      await Promise.race([
        this.waitForTranscriptIdle(10_000),
        new Promise(r => setTimeout(r, 30_000)),
      ]);
    }
    await this.stop();
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

    // Validate handover quality and retry once if needed
    const validation = this.validateHandover();
    if (!validation.valid && this.tmux) {
      this.logger.warn(
        { missing: validation.missing },
        "Handover missing required sections — retrying with explicit prompt",
      );
      const retryPrompt = `Your handover.md is missing these sections: ${validation.missing.join(", ")}. Rewrite memory/handover.md and include ALL of these sections: ## Active Tasks, ## Progress, ## Decisions, ## Next Steps, ## Blockers. Each section must have content.`;
      await this.tmux.sendKeys(retryPrompt);
      await new Promise(r => setTimeout(r, 500));
      await this.tmux.sendSpecialKey("Enter");
      await this.waitForTranscriptIdle(15000);
      const retry = this.validateHandover();
      if (!retry.valid) {
        this.logger.warn({ missing: retry.missing }, "Handover still incomplete after retry — proceeding anyway");
      }
    }

    this.logger.info("Transcript settled — handover complete");
    this.guardian?.signalHandoverComplete();
  }

  private validateHandover(): { valid: boolean; missing: string[]; wordCount: number } {
    const memDir = this.getMemoryDir();
    const path = join(memDir, "handover.md");
    try {
      const content = readFileSync(path, "utf-8");
      const requiredSections = ["Active Tasks", "Progress", "Decisions", "Next Steps", "Blockers"];
      const contentLower = content.toLowerCase();
      const missing = requiredSections.filter(s => !contentLower.includes(s.toLowerCase()));
      const wordCount = content.split(/\s+/).filter(Boolean).length;
      const valid = missing.length === 0 && wordCount >= 20;
      return { valid, missing, wordCount };
    } catch {
      return { valid: false, missing: ["file not found"], wordCount: 0 };
    }
  }

  private getMemoryDir(): string {
    return this.config.memory_directory ?? join(
      homedir(),
      ".claude/projects",
      this.config.working_directory.replace(/\//g, "-"),
      "memory",
    );
  }

}
