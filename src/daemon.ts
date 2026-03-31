import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import type { InstanceConfig, RotationSnapshot, RotationSnapshotEvent } from "./types.js";
import { createLogger, type Logger } from "./logger.js";
import { TmuxManager } from "./tmux-manager.js";
import { TranscriptMonitor } from "./transcript-monitor.js";
import { ContextGuardian } from "./context-guardian.js";
import { IpcServer } from "./channel/ipc-bridge.js";
import { MessageBus } from "./channel/message-bus.js";
import { ToolTracker } from "./channel/tool-tracker.js";
import type { CliBackend, CliBackendConfig } from "./backend/types.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
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
  private healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private crashCount = 0;
  private lastCrashAt = 0;
  private lastSpawnAt = 0;
  private rapidCrashCount = 0;
  private healthCheckPaused = false;
  private spawning = false;
  // Context rotation quality tracking
  private rotationStartedAt = 0;
  private preRotationContextPct = 0;
  private hangDetector: HangDetector | null = null;
  // Model failover: override model on next spawn when rate-limited
  private modelOverride: string | undefined;
  // Context rotation v3: ring buffers for daemon-side snapshot
  private recentUserMessages: Array<{ text: string; ts: string }> = [];
  private recentEvents: RotationSnapshotEvent[] = [];
  private recentToolActivity: string[] = [];

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

    // 2. Tmux — ensure session, create window if not alive
    const sessionName = "agend";
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
      await this.tmux.pipeOutput(outputLog).catch(() => {});

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
      this.transcriptMonitor.on("tool_use", (name: string, input: unknown) => {
        this.logger.debug({ tool: name }, "Tool use");
        ackIfPending();
        this.hangDetector?.recordActivity();
        this.recordRecentEvent({ type: "tool_use", name, preview: this.summarizeTool(name, input) });
        this.recordRecentToolActivity(this.summarizeTool(name, input));
      });
      this.transcriptMonitor.on("tool_result", (name: string, _output: unknown) => {
        this.hangDetector?.recordActivity();
        this.recordRecentEvent({ type: "tool_result", name });
      });
      this.transcriptMonitor.on("assistant_text", (text: string) => {
        this.logger.debug({ text: text.slice(0, 200) }, "Claude response");
        ackIfPending();
        this.hangDetector?.recordActivity();
        this.recordRecentEvent({ type: "assistant_text", preview: text.slice(0, 100) });
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
      // v3: daemon-driven restart — no handover prompt, no validation
      this.guardian.on("restart_requested", async (reason: string) => {
        this.rotationStartedAt = Date.now();
        this.preRotationContextPct = this.readContextPercentage();
        this.logger.info({ reason, context_pct: this.preRotationContextPct }, "Restart requested");

        // Minimal idle barrier: let current step settle (best-effort, not a handover wait)
        await this.waitForIdle(5000);

        // Collect and write daemon-side snapshot
        const snapshot = this.writeRotationSnapshot(reason);

        // Save session id, kill and respawn
        this.saveSessionId();
        await this.tmux?.killWindow();
        this.transcriptMonitor?.resetOffset();

        // Clear ring buffers for new session
        this.recentUserMessages = [];
        this.recentEvents = [];
        this.recentToolActivity = [];

        await this.spawnClaudeWindow();

        // Track restart metrics
        const durationMs = Date.now() - this.rotationStartedAt;
        this.emit("restart_complete", {
          instance: this.name,
          reason,
          pre_restart_context_pct: this.preRotationContextPct,
          restart_duration_ms: durationMs,
          snapshot_user_message_count: snapshot.recent_user_messages?.length ?? 0,
          snapshot_event_count: snapshot.recent_events?.length ?? 0,
        });

        this.guardian?.markRestartComplete();
        this.logger.info({ reason, duration_ms: durationMs }, "Restart complete — fresh Claude session started");
      });

    }

    // Set AGEND_SOCKET_PATH env for MCP server
    process.env.AGEND_SOCKET_PATH = sockPath;

    // 10. Health check — detect crashed tmux window and respawn
    if (!this.config.lightweight) {
    // Health check disabled — Claude Code handles its own crash recovery.
    // The daemon-level respawn was causing orphan tmux windows and stale
    // window-id mismatches. If the CLI exits, it stays down until the
    // next fleet restart or manual intervention.
    }

    this.logger.info(`${this.name} ready`);
  }

  private startHealthCheck(): void {
    const { max_retries, backoff, reset_after } = this.config.restart_policy;
    if (max_retries <= 0) return; // restart disabled

    const scheduleNext = () => {
      this.healthCheckTimer = setTimeout(async () => {
        if (!this.tmux || this.guardian?.state === "RESTARTING" || this.spawning || this.healthCheckPaused) {
          scheduleNext();
          return;
        }

        const alive = await this.tmux.isWindowAlive();
        if (alive) {
          scheduleNext();
          return;
        }

        // Detect rapid crash: window died within 60s of spawn
        if (this.lastSpawnAt > 0 && Date.now() - this.lastSpawnAt < 60_000) {
          this.rapidCrashCount++;
        } else {
          this.rapidCrashCount = 0;
        }

        if (this.rapidCrashCount >= 3) {
          this.healthCheckPaused = true;
          this.logger.error(
            { rapidCrashCount: this.rapidCrashCount },
            "Claude keeps crashing shortly after launch (possible rate limit) — pausing respawn",
          );
          this.emit("crash_loop", this.name);
          return; // don't schedule next — paused
        }

        // Reset crash count if enough time has passed
        if (reset_after > 0 && Date.now() - this.lastCrashAt > reset_after) {
          this.crashCount = 0;
        }

        this.crashCount++;
        this.lastCrashAt = Date.now();

        if (this.crashCount > max_retries) {
          this.logger.error({ crashCount: this.crashCount, maxRetries: max_retries }, "Max crash retries exceeded — not respawning");
          return; // don't schedule next — given up
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
          // Clear stale session-id so respawn doesn't --resume a dead session
          const sidFile = join(this.instanceDir, "session-id");
          try { unlinkSync(sidFile); } catch { /* may not exist */ }
          // Kill any same-name windows before respawn to prevent orphans
          const windows = await TmuxManager.listWindows("agend");
          for (const w of windows) {
            if (w.name === this.name) {
              const tm = new TmuxManager("agend", w.id);
              await tm.killWindow();
            }
          }
          await this.spawnClaudeWindow();
          this.logger.info("Respawned Claude window after crash");
        } catch (err) {
          this.logger.error({ err }, "Failed to respawn Claude window");
        }

        scheduleNext();
      }, 30_000);
    };

    scheduleNext();
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping daemon instance");
    if (this.healthCheckTimer) { clearTimeout(this.healthCheckTimer); this.healthCheckTimer = null; }
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
    if (name.startsWith("mcp__agend__")) return ""; // skip channel tools
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

    this.ipcServer?.broadcast({
      type: "fleet_tool_status",
      instanceName: this.name,
      text,
      editMessageId: this.toolStatusMessageId,
    });
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
  pushChannelMessage(content: string, meta: Record<string, string>, _targetSession?: string): void {
    if (!this.tmux) {
      this.logger.warn("Cannot push channel message: tmux not running");
      return;
    }
    this.hangDetector?.recordInbound();
    // v3: record user messages for rotation snapshot
    this.recordRecentUserMessage(content, meta);

    // Format message with metadata prefix for the agent
    const user = meta.user || "unknown";
    const fromInstance = meta.from_instance;
    let formatted: string;
    if (fromInstance) {
      // Cross-instance message
      formatted = `[from:${fromInstance}] ${content}`;
    } else {
      // User message from Telegram/Discord
      formatted = `[user:${user}] ${content}`;
    }

    this.tmux.pasteText(formatted).catch(async (err) => {
      // Window ID may be stale after crash/respawn — try to find by name
      this.logger.warn({ err }, "pasteText failed, looking up window by name");
      try {
        const windows = await TmuxManager.listWindows("agend");
        const match = windows.find(w => w.name === this.name);
        if (match) {
          this.tmux = new TmuxManager("agend", match.id);
          writeFileSync(join(this.instanceDir, "window-id"), match.id);
          await this.tmux.pasteText(formatted);
          this.logger.info({ windowId: match.id }, "Recovered window ID and delivered message");
        }
      } catch (retryErr) {
        this.logger.error({ err: retryErr }, "Failed to recover window for message delivery");
      }
    });
    this.logger.debug({ user: meta.user, text: content.slice(0, 100) }, "Pushed channel message via tmux");
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
        "agend": {
          command: "node",
          args: [serverJs],
          env: { AGEND_SOCKET_PATH: sockPath },
        },
      },
      systemPrompt: this.buildSystemPrompt(),
      skipPermissions: this.config.skipPermissions,
      model: this.modelOverride ?? this.config.model,
    };
  }

  /** Combine fleet context with user-configured system prompt + previous session snapshot */
  private buildSystemPrompt(): string {
    const fleetContext = generateFleetSystemPrompt({
      instanceName: this.name,
      workingDirectory: this.config.working_directory,
    });
    let prompt = fleetContext;
    if (this.config.systemPrompt) {
      prompt += "\n\n" + this.config.systemPrompt;
    }
    // v3: inject previous session snapshot
    const snapshotBlock = this.buildSnapshotPrompt();
    if (snapshotBlock) {
      prompt += "\n\n" + snapshotBlock;
    }
    return prompt;
  }

  /** Spawn (or respawn) a Claude window in tmux */
  private async spawnClaudeWindow(): Promise<void> {
    this.spawning = true;
    try {
    // Clear tool status from previous session
    this.toolStatusLines = [];
    this.toolStatusMessageId = null;
    if (!this.backend) {
      throw new Error("No backend configured — cannot spawn Claude window");
    }
    const backendConfig = this.buildBackendConfig();
    this.backend.writeConfig(backendConfig);
    // Inject AGEND_INSTANCE_NAME via shell env (not .mcp.json) so internal sessions
    // are distinguishable from external sessions sharing the same .mcp.json
    let claudeCmd = `AGEND_INSTANCE_NAME=${this.name} ` + this.backend.buildCommand(backendConfig);

    const windowId = await this.tmux!.createWindow(claudeCmd, this.config.working_directory, this.name);
    const windowIdFile = join(this.instanceDir, "window-id");
    writeFileSync(windowIdFile, windowId);

    // Smart wait: poll tmux pane for prompt indicators, press Enter when found.
    // Minimum 3s wait to let CLI initialize, then poll up to 10s.
    await new Promise(r => setTimeout(r, 3000));
    const deadline = Date.now() + 7_000;
    let prompted = false;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const pane = await this.tmux!.capturePane();
        // Confirmation prompts that need Enter
        if (/Do you want|Yes.*No|Trust|trust|Enter to confirm|New MCP server/i.test(pane)) {
          prompted = true;
          break;
        }
        // CLI is ready (status bar visible = fully loaded)
        if (/bypass permissions|tokens|ok\s*$/m.test(pane)) {
          break; // ready, no Enter needed
        }
      } catch { break; }
    }
    if (prompted) {
      try { await this.tmux!.sendSpecialKey("Enter"); } catch { /* window may have exited */ }
    }
    this.lastSpawnAt = Date.now();
    } finally {
      this.spawning = false;
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
    return new Promise((resolve) => {
      const events = ["tool_use", "tool_result", "assistant_text"];
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

  // ── Context Rotation v3: Ring buffers ─────────────────────────

  private recordRecentUserMessage(content: string, meta: Record<string, string>): void {
    // Only record real user messages, not cross-instance messages
    if (!meta.user || meta.user.startsWith("instance:")) return;
    this.recentUserMessages.push({
      text: content.slice(0, 200),
      ts: meta.ts ?? new Date().toISOString(),
    });
    if (this.recentUserMessages.length > 10) this.recentUserMessages.shift();
  }

  private recordRecentEvent(event: RotationSnapshotEvent): void {
    this.recentEvents.push(event);
    if (this.recentEvents.length > 15) this.recentEvents.shift();
  }

  private recordRecentToolActivity(summary: string): void {
    if (!summary) return;
    this.recentToolActivity.push(summary);
    if (this.recentToolActivity.length > 10) this.recentToolActivity.shift();
  }

  // ── Context Rotation v3: Snapshot writer ──────────────────────

  writeRotationSnapshot(reason: string): RotationSnapshot {
    const statusline = this.readStatuslineData();
    const snapshot: RotationSnapshot = {
      instance: this.name,
      reason,
      created_at: new Date().toISOString(),
      working_directory: this.config.working_directory,
      session_id: this.backend?.getSessionId() ?? null,
      context_pct: this.readContextPercentage(),
      recent_user_messages: [...this.recentUserMessages],
      recent_events: [...this.recentEvents],
      recent_tool_activity: [...this.recentToolActivity],
      last_statusline: statusline ? {
        model: statusline.model?.display_name,
        cost_usd: statusline.cost?.total_cost_usd,
        five_hour_pct: statusline.rate_limits?.five_hour?.used_percentage,
        seven_day_pct: statusline.rate_limits?.seven_day?.used_percentage,
      } : undefined,
    };
    const snapshotPath = join(this.instanceDir, "rotation-state.json");
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    this.logger.info({
      reason,
      context_pct: snapshot.context_pct,
      user_msg_count: snapshot.recent_user_messages?.length ?? 0,
      event_count: snapshot.recent_events?.length ?? 0,
    }, "Snapshot written");
    return snapshot;
  }

  private readStatuslineData(): import("./types.js").StatusLineData | null {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      return JSON.parse(readFileSync(sf, "utf-8"));
    } catch {
      return null;
    }
  }

  // ── Context Rotation v3: Prompt injection ─────────────────────

  private buildSnapshotPrompt(): string | null {
    const snapshotPath = join(this.instanceDir, "rotation-state.json");
    try {
      if (!existsSync(snapshotPath)) return null;
      const snapshot: RotationSnapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));

      // Single-consume: delete after reading so it's not re-injected on
      // crash respawn, manual restart, or future rotations.
      try { unlinkSync(snapshotPath); } catch { /* best-effort */ }

      const lines: string[] = ["## Previous Session Snapshot", ""];
      lines.push(`Restart reason: ${snapshot.reason}`);
      if (snapshot.context_pct != null) lines.push(`Previous context usage: ${snapshot.context_pct}%`);
      if (snapshot.session_id) lines.push(`Previous session id: ${snapshot.session_id}`);
      lines.push(`Working directory: ${snapshot.working_directory}`);
      lines.push("");

      if (snapshot.recent_user_messages && snapshot.recent_user_messages.length > 0) {
        lines.push("Recent user messages:");
        for (const msg of snapshot.recent_user_messages) {
          lines.push(`- ${msg.text}`);
        }
        lines.push("");
      }

      if (snapshot.recent_events && snapshot.recent_events.length > 0) {
        lines.push("Recent activity:");
        for (const ev of snapshot.recent_events) {
          if (ev.type === "assistant_text") {
            lines.push(`- Assistant: ${ev.preview}`);
          } else {
            lines.push(`- ${ev.name}${ev.preview ? `: ${ev.preview}` : ""}`);
          }
        }
        lines.push("");
      }

      lines.push("Instruction:");
      lines.push("Resume work from this snapshot when relevant. Do not assume anything not stated here.");

      // Enforce 2000-char budget
      let result = lines.join("\n");
      if (result.length > 2000) {
        result = result.slice(0, 1997) + "...";
      }
      return result;
    } catch {
      return null;
    }
  }

}
