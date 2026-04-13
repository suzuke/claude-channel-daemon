import { join, dirname, basename } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync, appendFileSync, statSync } from "node:fs";
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
import type { CliBackend, CliBackendConfig, ErrorPattern, StartupDialog } from "./backend/types.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import { getTmuxSession } from "./config.js";
import { routeToolCall } from "./channel/tool-router.js";
import { HangDetector } from "./hang-detector.js";
import type { TmuxControlClient } from "./tmux-control.js";
import { buildFleetInstructions } from "./instructions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Tool routing sets — module-level to avoid re-creation on every handleToolCall
const CROSS_INSTANCE_TOOLS = new Set(["send_to_instance", "list_instances", "start_instance", "create_instance", "delete_instance", "replace_instance", "request_information", "delegate_task", "report_result", "describe_instance"]);
const SCHEDULE_TOOLS = new Set(["create_schedule", "list_schedules", "update_schedule", "delete_schedule"]);
const DECISION_TOOLS = new Set(["post_decision", "list_decisions", "update_decision"]);
const TASK_TOOL = "task";

export class Daemon extends EventEmitter {
  private logger: Logger;
  private tmuxSessionName: string;
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
  // Tool status tracking for channel adapter
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
  private skipResume = false;
  /** Whether the last spawn started a fresh session (not resumed). */
  isNewSession = false;
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
  private snapshotConsumed = false;
  private pasteLock: Promise<void> = Promise.resolve();
  // PTY error pattern monitoring
  private errorMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private errorWaitingForRecovery = false; // true = error detected, waiting for ready pattern
  private errorDetectedAt = 0; // timestamp when error was first detected
  private lastFailoverAt = 0; // cooldown: prevent repeated failover triggers
  private static FAILOVER_COOLDOWN_MS = 5 * 60_000; // 5 minutes
  private lastErrorNotifiedAt = new Map<string, number>(); // per-type cooldown for all actions
  private static ERROR_COOLDOWN_MS = 5 * 60_000;

  /** Cheap hash for pane content dedup — not cryptographic, just identity check */
  private static cheapPaneHash(pane: string): string {
    return `${pane.length}:${pane.slice(-200)}`;
  }
  // Hash dedup: suppress stale error re-detection after recovery
  private lastRecoveryPaneHash: string | null = null;
  private lastRecoveredErrorType: string | null = null;
  private lastDetectedErrorType: string | null = null;

  constructor(
    private name: string,
    private config: InstanceConfig,
    private instanceDir: string,
    private topicMode = false,
    private backend?: CliBackend,
    private controlClient?: TmuxControlClient,
  ) {
    super();
    this.logger = createLogger(config.log_level);
    this.tmuxSessionName = getTmuxSession();
    this.messageBus = new MessageBus();
    this.messageBus.setLogger(this.logger);
  }

  async start(): Promise<void> {
    mkdirSync(this.instanceDir, { recursive: true });
    writeFileSync(join(this.instanceDir, "daemon.pid"), String(process.pid));
    this.logger.info(`Starting ${this.name}`);

    // P1: Read crash state from previous run — skip resume if last run was a crash loop
    const crashStatePath = join(this.instanceDir, "crash-state.json");
    try {
      if (existsSync(crashStatePath)) {
        const state = JSON.parse(readFileSync(crashStatePath, "utf-8"));
        if (state.resumeDisabled) {
          this.skipResume = true;
          this.logger.warn("Previous crash loop detected — starting without resume");
        }
        unlinkSync(crashStatePath);
      }
    } catch { /* corrupt file — ignore */ }

    // 1. IPC server — bridge between MCP server (Claude's child) and daemon
    const sockPath = join(this.instanceDir, "channel.sock");
    this.ipcServer = new IpcServer(sockPath, this.logger);
    // Forward IPC server errors as daemon events (prevents unhandled 'error' crash).
    // Guard: only forward post-listen errors — startup errors are handled by listen() rejection.
    let ipcListening = false;
    this.ipcServer.on("error", (err: Error) => {
      if (!ipcListening) return; // startup errors handled by listen() rejection
      this.logger.error({ err, name: this.name }, "IPC server error");
      this.emit("error", err);
    });
    await this.ipcServer.listen();
    ipcListening = true;

    // Permanent IPC dispatcher: routes responses to pending requests by type+id key
    this.ipcServer.on("message", (msg: Record<string, unknown>) => {
      const type = msg.type as string | undefined;
      if (!type) return;
      // Build lookup key matching the pattern used when registering
      let key: string | undefined;
      if ((type === "fleet_schedule_response" || type === "fleet_outbound_response" || type === "fleet_decision_response" || type === "fleet_task_response" || type === "fleet_display_name_response" || type === "fleet_description_response") && msg.fleetRequestId) {
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
        // Only update lastChatId/lastThreadId from real channel messages (non-empty chat_id).
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
    await TmuxManager.ensureSession(this.tmuxSessionName);
    this.tmux = new TmuxManager(this.tmuxSessionName, "");

    // Strategy A: always start fresh Claude window (MCP server has no reconnection)
    // Kill any existing window from previous run
    const windowIdFile = join(this.instanceDir, "window-id");
    if (existsSync(windowIdFile)) {
      const savedId = readFileSync(windowIdFile, "utf-8").trim();
      if (savedId) {
        const oldTmux = new TmuxManager(this.tmuxSessionName, savedId);
        if (await oldTmux.isWindowAlive()) {
          this.saveSessionId();
          await oldTmux.killWindow();
          this.logger.info({ savedId }, "Killed old tmux window for fresh start");
        }
      }
    }

    const resumed = await this.spawnClaudeWindow();
    this.isNewSession = !resumed;
    if (!resumed) {
      await this.injectSnapshotMessage();
    } else {
      // Clean up stale snapshot file — resume restored full context, snapshot not needed
      try { unlinkSync(join(this.instanceDir, "rotation-state.json")); } catch { /* may not exist */ }
    }

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

      this.guardian.on("status_update", () => {
        this.saveSessionId();
        this.hangDetector?.recordStatuslineUpdate();
      });
      // Context rotation removed: all CLI backends have built-in auto-compact.
      // Crash recovery (health check + respawn with snapshot) is retained below.

    }

    // NOTE: Do NOT set process.env.AGEND_SOCKET_PATH here — it pollutes the
    // shared fleet manager process env. Each daemon overwrites it, so the last
    // one wins, causing MCP servers (especially kiro-cli which inherits process
    // env) to connect to the wrong socket. The socket path is passed via
    // per-instance MCP config files or wrapper scripts instead.

    // 10. Health check — detect crashed tmux window and respawn
    // Re-enabled: orphan window issue fixed by killing same-name windows before respawn.
    // Without this, a dead CLI window goes undetected and messages are silently lost.
    if (!this.config.lightweight) {
      this.startHealthCheck();
      this.startErrorMonitor();
    }

    this.logger.info(`${this.name} ready`);
  }

  private startHealthCheck(): void {
    const { max_retries, backoff, reset_after } = this.config.restart_policy;
    if (max_retries <= 0) return; // restart disabled

    const scheduleNext = () => {
      this.healthCheckTimer = setTimeout(async () => {
        if (!this.tmux || this.spawning || this.healthCheckPaused) {
          scheduleNext();
          return;
        }

        const paneStatus = await this.tmux.getPaneStatus();
        if (paneStatus?.alive) {
          scheduleNext();
          return;
        }

        // paneStatus === null → window gone entirely (e.g. tmux server crash)
        // paneStatus.alive === false → pane dead, exit code available
        const exitCode = paneStatus?.exitCode;
        this.logger.debug({ exitCode }, `[health] pane exited with code: ${exitCode}`);

        // Normal exit (e.g. user Ctrl+C or /exit) — no crash, no respawn
        if (paneStatus && exitCode === 0) {
          this.logger.info("CLI exited normally (code 0) — pausing health check");
          await this.tmux.killWindow();
          this.healthCheckPaused = true;
          return;
        }

        // Distinguish tmux server crash from single window crash
        let crashType: "server" | "window" = "window";
        if (!paneStatus) {
          const serverAlive = await TmuxManager.sessionExists(this.tmuxSessionName);
          if (!serverAlive) {
            crashType = "server";
            this.logger.error("tmux server died — all windows lost");
            await new Promise(r => setTimeout(r, 2_000)); // let session stabilize
          } else {
            this.logger.warn({ exitCode }, "Claude window died (tmux server alive)");
          }
        } else {
          this.logger.warn({ exitCode }, "Claude process exited");
        }

        // Capture last output from dead pane before killing
        let lastOutput: string | undefined;
        if (paneStatus) {
          try {
            const raw = await this.tmux.capturePaneWithHistory(50);
            // Strip ANSI escape codes for readability
            const cleaned = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
            lastOutput = cleaned.trimEnd() || undefined;
          } catch { /* best effort */ }
        }

        // Kill the dead window (remain-on-exit keeps it around) before respawn
        if (paneStatus) {
          await this.tmux.killWindow();
        }

        // Append to crash history
        this.appendCrashHistory({ exitCode, lastOutput, crashType });

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
          // P1: Persist crash state so next process restart skips resume
          try {
            writeFileSync(join(this.instanceDir, "crash-state.json"), JSON.stringify({
              rapidCrashCount: this.rapidCrashCount,
              lastCrashAt: Date.now(),
              resumeDisabled: true,
            }));
          } catch { /* best effort */ }
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
          // Kill any same-name windows before respawn to prevent orphans.
          // Wrapped in try-catch: if tmux server is dead, listWindows throws —
          // must not block spawnClaudeWindow (which calls ensureSession).
          try {
            const windows = await TmuxManager.listWindows(this.tmuxSessionName);
            for (const w of windows) {
              if (w.name === this.name) {
                const tm = new TmuxManager(this.tmuxSessionName, w.id);
                await tm.killWindow();
              }
            }
          } catch { /* tmux server may be dead — ensureSession in trySpawn will recover */ }
          // Write snapshot before spawn — consumed only if resume fails
          this.writeRotationSnapshot("crash");
          // Try --resume first; spawnClaudeWindow falls back to fresh session if resume fails
          const resumed = await this.spawnClaudeWindow();
          if (!resumed) {
            // Resume failed → fresh session → inject snapshot for context
            await this.injectSnapshotMessage();
          } else {
            // Clean up stale snapshot — resume restored full context
            try { unlinkSync(join(this.instanceDir, "rotation-state.json")); } catch { /* may not exist */ }
          }
          this.logger.info({ resumed }, "Respawned Claude window after crash");
          this.emit("crash_respawn", this.name);
        } catch (err) {
          this.logger.error({ err }, "Failed to respawn Claude window");
        }

        scheduleNext();
      }, this.config.restart_policy.health_check_interval_ms ?? 30_000);
    };

    scheduleNext();
  }

  /**
   * Periodically scan PTY output for backend-defined error patterns.
   *
   * State machine to avoid false positives from stale buffer text:
   *   MONITORING → (error pattern match) → WAITING_FOR_RECOVERY → (ready pattern match) → MONITORING
   *
   * Only emits pty_error once per error occurrence. After the agent recovers
   * (ready pattern visible), it goes back to monitoring for new errors.
   */
  private startErrorMonitor(): void {
    const patterns = this.backend?.getErrorPatterns?.() ?? [];
    const dialogs = this.backend?.getRuntimeDialogs?.() ?? [];
    if (!patterns.length && !dialogs.length) return;
    if (!this.tmux) return;
    const readyPattern = this.backend!.getReadyPattern();

    this.errorMonitorTimer = setInterval(async () => {
      if (!this.tmux || this.spawning) return;
      try {
        const alive = await this.tmux.isWindowAlive();
        if (!alive) return;

        const pane = await this.tmux.capturePane();

        // Only scan text after the last prompt marker to avoid matching stale errors
        // that remain in the capture-pane buffer after recovery.
        let scanText = pane;
        const rpg = new RegExp(readyPattern.source, readyPattern.flags.includes("g") ? readyPattern.flags : readyPattern.flags + "g");
        let lastIdx = -1;
        let m: RegExpExecArray | null;
        while ((m = rpg.exec(pane)) !== null) lastIdx = m.index;
        if (lastIdx >= 0) scanText = pane.slice(lastIdx);

        // Auto-dismiss runtime dialogs (e.g. Codex rate limit model switch)
        for (const dialog of dialogs) {
          if (!dialog.pattern.test(pane)) continue;
          this.logger.info(`Auto-dismissing runtime dialog: ${dialog.description}`);
          const SPECIAL_KEYS = new Set(["Up", "Down", "Enter", "Escape"]);
          for (const key of dialog.keys) {
            if (SPECIAL_KEYS.has(key)) {
              await this.tmux.sendSpecialKey(key as "Enter" | "Escape" | "Up" | "Down");
            } else {
              await this.tmux.pasteText(key);
            }
            await new Promise(r => setTimeout(r, 200));
          }
          return; // Dialog dismissed, skip error checks this cycle
        }

        // State: waiting for recovery — check if agent is back to ready
        if (this.errorWaitingForRecovery) {
          if (readyPattern.test(pane)) {
            const downtime = Math.round((Date.now() - this.errorDetectedAt) / 1000);
            // Record pane hash at recovery to suppress stale re-detection
            this.lastRecoveryPaneHash = Daemon.cheapPaneHash(pane);
            this.lastRecoveredErrorType = this.lastDetectedErrorType;
            this.errorWaitingForRecovery = false;
            this.errorDetectedAt = 0;
            this.logger.info({ downtime_s: downtime }, "PTY error recovered — agent is ready again");
            this.emit("pty_recovered", { name: this.name, downtime_s: downtime });
          }
          return; // Don't check for errors while waiting for recovery
        }

        // State: monitoring — check for new errors
        const currentPaneHash = Daemon.cheapPaneHash(pane);
        for (const ep of patterns) {
          if (!ep.pattern.test(scanText)) continue;

          // Dedup: suppress if same error on same screen as last recovery
          if (this.lastRecoveryPaneHash && ep.type === this.lastRecoveredErrorType) {
            if (currentPaneHash === this.lastRecoveryPaneHash) {
              break; // same screen, same error → stale
            }
            // Screen changed — stop suppressing
            this.lastRecoveryPaneHash = null;
            this.lastRecoveredErrorType = null;
          }

          // Cooldown: skip if same error type was recently notified
          const lastNotified = this.lastErrorNotifiedAt.get(ep.type) ?? 0;
          if (Date.now() - lastNotified < Daemon.ERROR_COOLDOWN_MS) {
            this.logger.debug({ errorType: ep.type }, "PTY error suppressed (cooldown active)");
            break;
          }
          if (ep.action === "failover" && Date.now() - this.lastFailoverAt < Daemon.FAILOVER_COOLDOWN_MS) {
            this.logger.debug({ errorType: ep.type }, "PTY error suppressed (failover cooldown active)");
            break;
          }

          this.errorWaitingForRecovery = true;
          this.errorDetectedAt = Date.now();
          this.lastDetectedErrorType = ep.type;
          this.lastErrorNotifiedAt.set(ep.type, Date.now());
          if (ep.action === "failover") this.lastFailoverAt = Date.now();
          this.logger.warn({ errorType: ep.type, action: ep.action }, `PTY error detected: ${ep.message}`);
          this.emit("pty_error", { name: this.name, ...ep });

          break; // Only handle first match per scan
        }
      } catch {
        // capturePane can fail if window is transitioning — ignore
      }
    }, 30_000); // Check every 30 seconds
  }

  async stop(): Promise<void> {
    this.logger.info("Stopping daemon instance");
    if (this.healthCheckTimer) { clearTimeout(this.healthCheckTimer); this.healthCheckTimer = null; }
    if (this.errorMonitorTimer) { clearInterval(this.errorMonitorTimer); this.errorMonitorTimer = null; }
    if (this.toolStatusDebounce) { clearTimeout(this.toolStatusDebounce); this.toolStatusDebounce = null; }
    this.pendingIpcRequests.clear();
    this.hangDetector?.stop();
    this.transcriptMonitor?.stop();
    this.guardian?.stop();
    if (this.adapter) await this.adapter.stop();

    // Notify MCP servers of graceful shutdown (prevents reconnect attempts)
    this.ipcServer?.broadcast({ type: "shutdown" });

    // Quit CLI FIRST — this kills MCP server child processes cleanly.
    // IPC must stay open during quit so MCP servers receive the shutdown message.
    if (this.tmux) {
      this.saveSessionId();
      this.healthCheckPaused = true;
      let killed = false;
      const quitCmd = this.backend?.getQuitCommand();
      if (quitCmd) {
        await this.tmux.sendKeys(quitCmd);
        // Delay before Enter to prevent tmux server race when multiple
        // instances stop in parallel (same pattern as pasteText).
        await new Promise(r => setTimeout(r, 150));
        await this.tmux.sendSpecialKey("Enter");
        // Wait up to 10s for graceful exit
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          const status = await this.tmux.getPaneStatus();
          if (!status || !status.alive) { killed = true; break; }
        }
      }
      if (!killed) this.logger.warn("CLI did not exit gracefully within 10s, force killing window");
      // Always kill window — remain-on-exit keeps dead panes around after CLI exits
      await this.tmux.killWindow();
      const windowIdFile = join(this.instanceDir, "window-id");
      try { unlinkSync(windowIdFile); } catch (e) { this.logger.debug({ err: e }, "Failed to remove window-id file"); }
    }

    // Close IPC AFTER CLI has exited — MCP servers are already dead at this point
    await this.ipcServer?.close();

    // Clean up backend config files
    if (this.backend?.cleanup) {
      this.backend.cleanup(this.buildBackendConfig());
    }
    // Clean up checked-out repos
    try { rmSync(join(this.instanceDir, "repos"), { recursive: true, force: true }); } catch { /* best effort */ }

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

  /** Debounce tool status updates to avoid channel rate limits */
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
      formatted = `[from:${fromInstance}] ${content}\n(Reply using send_to_instance tool, NOT direct text)`;
    } else {
      const via = meta.source ? ` via ${meta.source}` : "";
      formatted = `[user:${user}${via}] ${content}\n(Reply using the reply tool — do NOT respond with direct text)`;
    }
    if (meta.reply_to_text) {
      formatted += `\n(reply_to: "${meta.reply_to_text}")`;
    }

    // Serialize deliveries: each message waits for the previous to complete,
    // and each waits for the CLI to be idle before pasting.
    this.pasteLock = this.pasteLock.then(() => this.deliverMessage(formatted)).catch(err => {
      this.logger.warn({ err: (err as Error).message }, "pasteLock delivery error — chain continues");
    });
    this.logger.debug({ user: meta.user, text: content.slice(0, 100) }, "Queued channel message for delivery");
  }

  /** Deliver a single message: wait for idle, then paste */
  private async deliverMessage(formatted: string): Promise<void> {
    const windowId = this.getWindowId();
    if (windowId && this.controlClient) {
      const idle = await this.controlClient.waitForIdle(windowId);
      if (!idle) {
        this.logger.warn("Delivering message after idle timeout (CLI may be busy)");
      }
    }

    const ok = await this.tmux!.pasteText(formatted);
    if (!ok) {
      // Window ID may be stale after crash/respawn — try to find by name
      this.logger.warn("pasteText failed, looking up window by name");
      try {
        const windows = await TmuxManager.listWindows(this.tmuxSessionName);
        const match = windows.find(w => w.name === this.name);
        if (match) {
          this.tmux = new TmuxManager(this.tmuxSessionName, match.id);
          writeFileSync(join(this.instanceDir, "window-id"), match.id);
          await this.controlClient?.registerWindow(match.id);
          await this.tmux.pasteText(formatted);
          this.logger.info({ windowId: match.id }, "Recovered window ID and delivered message");
        }
      } catch (retryErr) {
        this.logger.error({ err: retryErr }, "Failed to recover window for message delivery");
      }
    }
  }

  private getWindowId(): string | undefined {
    try {
      return readFileSync(join(this.instanceDir, "window-id"), "utf-8").trim() || undefined;
    } catch {
      return undefined;
    }
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

    // Repo checkout — handled locally in daemon (no fleet-manager)
    if (tool === "checkout_repo") {
      this.handleCheckoutRepo(args, respond);
      return;
    }
    if (tool === "release_repo") {
      this.handleReleaseRepo(args, respond);
      return;
    }

    if (tool === "set_display_name" || tool === "set_description") {
      const type = tool === "set_display_name" ? "fleet_set_display_name" : "fleet_set_description";
      const fleetReqId = `${tool === "set_display_name" ? "dn" : "desc"}_${requestId}`;
      this.ipcServer?.broadcast({
        type,
        payload: args,
        meta: { instance_name: this.name },
        fleetRequestId: fleetReqId,
      });
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(fleetReqId);
        respond(null, `${tool} timed out`);
      }, 10_000);
      this.pendingIpcRequests.set(fleetReqId, (respMsg) => {
        clearTimeout(timeout);
        respond(respMsg.result, respMsg.error as string | undefined);
      });
      return;
    }

    if (tool === TASK_TOOL) {
      const fleetReqId = `task_${requestId}`;
      this.ipcServer?.broadcast({
        type: "fleet_task",
        payload: args,
        meta: { instance_name: this.name },
        fleetRequestId: fleetReqId,
      });
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(fleetReqId);
        respond(null, "Task operation timed out after 30s");
      }, 30_000);
      this.pendingIpcRequests.set(fleetReqId, (respMsg) => {
        clearTimeout(timeout);
        respond(respMsg.result, respMsg.error as string | undefined);
      });
      return;
    }

    if (DECISION_TOOLS.has(tool)) {
      const typeMap: Record<string, string> = {
        post_decision: "fleet_decision_create",
        list_decisions: "fleet_decision_list",
        update_decision: "fleet_decision_update",
      };
      const fleetReqId = `dec_${requestId}`;
      this.ipcServer?.broadcast({
        type: typeMap[tool],
        payload: args,
        meta: { instance_name: this.name, working_directory: this.config.working_directory },
        fleetRequestId: fleetReqId,
      });
      const timeout = setTimeout(() => {
        this.pendingIpcRequests.delete(fleetReqId);
        respond(null, "Decision operation timed out after 30s");
      }, 30_000);
      this.pendingIpcRequests.set(fleetReqId, (respMsg) => {
        clearTimeout(timeout);
        respond(respMsg.result, respMsg.error as string | undefined);
      });
      return;
    }

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
        const crossTimeoutMs = (tool === "start_instance" || tool === "create_instance" || tool === "replace_instance") ? 60_000 : 30_000;
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

    // Context-bound routing: reply/react/edit_message always use the daemon's last known context.
    // chat_id and thread_id are not exposed in the tool schema — daemon is solely responsible for routing.
    // Must run before IPC forwarding so topic-mode (fleet manager) also receives the correct chat_id.
    if (["reply", "react", "edit_message"].includes(tool)) {
      if (!this.lastChatId) {
        respond(null, "No active chat context — awaiting inbound message");
        return;
      }
      args.chat_id = this.lastChatId;
      if (tool === "reply") args.thread_id = this.lastThreadId;
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

    // ── Resolve workflow and systemPrompt once, share between MCP env and instructions ──
    let resolvedWorkflow: string | false | undefined;
    if (this.config.workflow === false) {
      resolvedWorkflow = false;
    } else {
      const wf = this.config.workflow ?? "builtin";
      if (wf !== "builtin") {
        let content = wf;
        if (content.startsWith("file:")) {
          try { content = readFileSync(content.slice(5), "utf-8"); } catch { content = ""; }
        }
        resolvedWorkflow = content || undefined;
      }
    }

    let resolvedCustomPrompt: string | undefined;
    if (this.config.systemPrompt) {
      // Support comma-separated file: paths for prompt modularization:
      //   systemPrompt: "file:prompts/role.md, file:prompts/rules.md, file:prompts/context.md"
      const parts = this.config.systemPrompt.split(",").map((s: string) => s.trim());
      const resolved = parts.map((part: string) => {
        if (part.startsWith("file:")) {
          try { return readFileSync(part.slice(5), "utf-8"); } catch { return ""; }
        }
        return part;
      }).filter(Boolean);
      if (resolved.length > 0) resolvedCustomPrompt = resolved.join("\n\n");
    }

    let decisions: { title: string; content: string }[] | undefined;
    if (process.env.AGEND_DECISIONS) {
      try { decisions = JSON.parse(process.env.AGEND_DECISIONS); } catch { /* invalid JSON */ }
    }

    // ── MCP server env (dual-track: still passes env vars for MCP instructions fallback) ──
    const mcpEnv: Record<string, string> = {
      AGEND_SOCKET_PATH: sockPath,
      AGEND_INSTANCE_NAME: this.name,
      AGEND_WORKING_DIR: this.config.working_directory,
    };
    if (this.config.tool_set) mcpEnv.AGEND_TOOL_SET = this.config.tool_set;
    if (this.config.display_name) mcpEnv.AGEND_DISPLAY_NAME = this.config.display_name;
    if (this.config.description) mcpEnv.AGEND_DESCRIPTION = this.config.description;
    if (resolvedWorkflow === false) mcpEnv.AGEND_WORKFLOW = "false";
    else if (resolvedWorkflow) mcpEnv.AGEND_WORKFLOW = resolvedWorkflow;
    if (resolvedCustomPrompt) mcpEnv.AGEND_CUSTOM_PROMPT = resolvedCustomPrompt;
    if (process.env.AGEND_DECISIONS) mcpEnv.AGEND_DECISIONS = process.env.AGEND_DECISIONS;

    // ── Fleet instructions for additive system prompt injection ──
    const instructions = buildFleetInstructions({
      instanceName: this.name,
      workingDirectory: this.config.working_directory,
      displayName: this.config.display_name,
      description: this.config.description,
      customPrompt: resolvedCustomPrompt,
      workflow: resolvedWorkflow,
      decisions,
    });

    return {
      workingDirectory: this.config.working_directory,
      instanceDir: this.instanceDir,
      instanceName: this.name,
      mcpServers: {
        "agend": {
          command: "node",
          args: [serverJs],
          env: mcpEnv,
        },
      },
      skipPermissions: this.config.skipPermissions,
      model: this.modelOverride ?? this.config.model,
      skipResume: this.skipResume,
      instructions,
    };
  }

  /**
   * After CLI is ready, paste any pending session snapshot as the first
   * user input so the agent picks up where the previous session left off.
   * This replaces the old system-prompt injection approach.
   */
  private async injectSnapshotMessage(): Promise<void> {
    if (this.snapshotConsumed) return;
    const snapshot = this.buildSnapshotPrompt();
    if (!snapshot || !this.tmux) return;
    // Small delay to let the CLI fully render its ready prompt
    await new Promise(r => setTimeout(r, 1_000));
    try {
      await this.tmux.pasteText(`[system:session-snapshot]\n${snapshot}\n\nThis is a background context restore — do NOT reply to or acknowledge this message. Simply resume normal operation when the next user or instance message arrives.`);
      this.logger.info("Injected session snapshot as first message");
      this.emit("snapshot_injected", this.name);
    } catch (err) {
      this.logger.error({ err }, "Snapshot injection failed — session continues without context");
      this.emit("snapshot_failed", this.name);
    }
  }

  /** Spawn a CLI window. Returns true if --resume was used successfully. */
  private async spawnClaudeWindow(): Promise<boolean> {
    this.spawning = true;
    let resumedSuccessfully = false;
    try {
    this.toolStatusLines = [];
    this.toolStatusMessageId = null;
    if (!this.backend) {
      throw new Error("No backend configured — cannot spawn CLI window");
    }

    const attemptedResume = !this.skipResume;
    const alive = await this.trySpawn();
    if (!alive) {
      // First attempt failed (stale --resume, crash, rate limit, etc.)
      // Clean slate: clear session-id, skip resume, and retry once.
      this.logger.warn("CLI startup failed — clearing session-id and retrying without resume");
      const sidFile = join(this.instanceDir, "session-id");
      try { unlinkSync(sidFile); } catch { /* may not exist */ }
      this.skipResume = true;
      await this.tmux!.killWindow();

      const retryAlive = await this.trySpawn();
      if (!retryAlive) {
        await this.tmux!.killWindow();
        throw new Error("CLI failed to start after retry");
      }
    } else if (attemptedResume) {
      resumedSuccessfully = true;
    }

    this.lastSpawnAt = Date.now();
    this.skipResume = false; // CLI started successfully — reset for next spawn
    } finally {
      this.spawning = false;
    }
    return resumedSuccessfully;
  }

  /**
   * Spawn a CLI window and verify it reaches a ready state.
   * Uses control mode to wait for output, then checks pane content.
   * Handles confirmation dialogs (trust folder, bypass permissions).
   * Returns true if CLI is ready, false if it failed or got stuck.
   */
  private async trySpawn(): Promise<boolean> {
    const backendConfig = this.buildBackendConfig();

    // Detect instructions change → force new session for backends that don't
    // re-read instruction files on --resume (Codex, Gemini, Kiro).
    if (!backendConfig.skipResume && !this.backend!.instructionsReloadedOnResume && backendConfig.instructions) {
      const prevFile = join(this.instanceDir, "prev-instructions");
      let prev = "";
      try { prev = readFileSync(prevFile, "utf-8"); } catch {}
      if (prev && prev !== backendConfig.instructions) {
        this.logger.info("Instructions changed — skipping resume to reload");
        backendConfig.skipResume = true;
      }
      writeFileSync(prevFile, backendConfig.instructions);
    }

    this.backend!.writeConfig(backendConfig);
    this.backend!.preTrust?.(this.config.working_directory);
    const cmd = `TERM=xterm-256color AGEND_INSTANCE_NAME=${this.name} ` + this.backend!.buildCommand(backendConfig);

    // Ensure tmux session exists (may have been destroyed if all windows died)
    await TmuxManager.ensureSession(this.tmuxSessionName);
    const windowId = await this.tmux!.createWindow(cmd, this.config.working_directory, this.name);
    writeFileSync(join(this.instanceDir, "window-id"), windowId);

    // Enable remain-on-exit to capture exit codes on crash
    await this.tmux!.setRemainOnExit().catch(err => {
      this.logger.warn({ err }, "Failed to set remain-on-exit — exit codes will not be captured");
    });

    // Register with control client and wait for output + idle
    await this.controlClient?.registerWindow(windowId);
    if (this.controlClient) {
      const total = this.config.startup_timeout_ms ?? 25_000;
      const outputTimeout = Math.round(total * 0.6);
      const idleTimeout = total - outputTimeout;
      const hasOutput = await this.controlClient.waitForOutput(windowId, outputTimeout);
      if (!hasOutput) return false;
      await this.controlClient.waitForIdle(windowId, idleTimeout);
    } else {
      await new Promise(r => setTimeout(r, 10_000));
    }

    // Dismiss confirmation dialogs and verify CLI reached prompt.
    // With remain-on-exit, isWindowAlive() returns true even for dead panes,
    // but a startup crash would already be caught by waitForOutput/waitForIdle above.
    if (!await this.tmux!.isWindowAlive()) return false;
    return this.dismissDialogsUntilReady(3);
  }

  /**
   * Repeatedly check pane content, dismiss any confirmation dialogs,
   * and return true once CLI reaches a ready prompt.
   */
  private async dismissDialogsUntilReady(maxAttempts: number): Promise<boolean> {
    // Backend-specific startup dialogs, with hardcoded fallback for backward compat
    const startupDialogs: StartupDialog[] = this.backend?.getStartupDialogs?.() ?? [
      { pattern: /[❯›]\s*\d+\.\s*No/m, keys: ["Down", "Enter"], description: "Confirmation dialog — navigate past No" },
      { pattern: /[❯›]\s*Don't trust/m, keys: ["Up", "Up", "Enter"], description: "Trust dialog — navigate to trust option" },
      { pattern: /No, exit|No, quit|Don't trust|I accept|I trust|Yes, continue|Trust folder/i, keys: ["Enter"], description: "Generic confirmation dialog" },
      { pattern: /Resume Session/i, keys: ["Escape"], description: "Resume session picker — start fresh" },
    ];

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const pane = await this.tmux!.capturePane();

        // Try each startup dialog pattern before checking ready state
        let matched = false;
        for (const dialog of startupDialogs) {
          if (dialog.pattern.test(pane)) {
            this.logger.debug(`Dismissing startup dialog: ${dialog.description}`);
            for (const key of dialog.keys) {
              if (key === "Up" || key === "Down" || key === "Enter" || key === "Escape") {
                await this.tmux!.sendSpecialKey(key);
              } else {
                await this.tmux!.sendKeys(key);
              }
              await new Promise(r => setTimeout(r, 200));
            }
            // Wait for next screen to render
            if (this.controlClient) {
              const wid = readFileSync(join(this.instanceDir, "window-id"), "utf-8").trim();
              await this.controlClient.waitForIdle(wid, 10_000);
            } else {
              await new Promise(r => setTimeout(r, 3_000));
            }
            if (!await this.tmux!.isWindowAlive()) return false;
            matched = true;
            break;
          }
        }
        if (matched) continue;

        // CLI is ready (pattern defined by each backend)
        if (this.backend!.getReadyPattern().test(pane)) return true;

        // Fatal: command not found
        if (/command not found|not found/i.test(pane)) return false;
      } catch {
        return false;
      }
    }
    // Exhausted attempts — assume ok for unknown CLI prompts
    return true;
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
    this.snapshotConsumed = false;
    this.logger.info({
      reason,
      context_pct: snapshot.context_pct,
      user_msg_count: snapshot.recent_user_messages?.length ?? 0,
      event_count: snapshot.recent_events?.length ?? 0,
    }, "Snapshot written");
    return snapshot;
  }

  /** Collect ring buffer data for handover to a replacement instance. */
  collectHandoverContext(): string {
    const lines: string[] = [];
    if (this.recentUserMessages.length > 0) {
      lines.push("Recent user messages:");
      for (const msg of this.recentUserMessages) lines.push(`- ${msg.text}`);
      lines.push("");
    }
    if (this.recentEvents.length > 0) {
      lines.push("Recent activity:");
      for (const ev of this.recentEvents) {
        if (ev.type === "assistant_text") lines.push(`- Assistant: ${ev.preview}`);
        else lines.push(`- ${ev.name}${ev.preview ? `: ${ev.preview}` : ""}`);
      }
      lines.push("");
    }
    if (this.recentToolActivity.length > 0) {
      lines.push("Recent tool activity:");
      for (const t of this.recentToolActivity) lines.push(`- ${t}`);
      lines.push("");
    }
    const pct = this.readContextPercentage();
    if (pct != null) lines.push(`Context usage: ${pct}%`);
    return lines.join("\n").slice(0, 4000);
  }

  private appendCrashHistory(data: { exitCode?: number; lastOutput?: string; crashType: "server" | "window" }): void {
    try {
      const historyPath = join(this.instanceDir, "crash-history.jsonl");
      const entry = {
        timestamp: new Date().toISOString(),
        instance: this.name,
        crashType: data.crashType,
        exitCode: data.exitCode,
        lastOutput: data.lastOutput,
        crashCount: this.crashCount + 1,
        rapidCrashCount: this.rapidCrashCount,
      };
      appendFileSync(historyPath, JSON.stringify(entry) + "\n");

      // Rotate based on file size (cheaper than parsing every time)
      try {
        const stat = statSync(historyPath);
        if (stat.size > 512_000) {
          const content = readFileSync(historyPath, "utf-8");
          const lines = content.trim().split("\n").filter(Boolean);
          writeFileSync(historyPath, lines.slice(-50).join("\n") + "\n");
        }
      } catch { /* best effort */ }
    } catch { /* best effort */ }
  }

  private readStatuslineData(): import("./types.js").StatusLineData | null {
    try {
      const sf = join(this.instanceDir, "statusline.json");
      return JSON.parse(readFileSync(sf, "utf-8"));
    } catch {
      return null;
    }
  }

  // ── Repo Checkout ─────────────────────────────────────────

  private async handleCheckoutRepo(
    args: Record<string, unknown>,
    respond: (result: unknown, error?: string) => void,
  ): Promise<void> {
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFileCb);

    let source = (args.source as string).replace(/^~/, process.env.HOME || "~");
    const branch = (args.branch as string) || "HEAD";

    // Resolve instance name to working_directory via IPC query
    // If source doesn't look like a path, treat it as an instance name
    if (!source.startsWith("/")) {
      // Broadcast to get instance info — but we don't have fleet config in daemon.
      // Instead, rely on fleet manager to resolve. For now, reject non-path sources.
      respond(null, `Source must be an absolute path or ~-prefixed path. Use describe_instance to find a repo's working_directory.`);
      return;
    }

    // Verify it's a git repo
    try {
      await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: source });
    } catch {
      respond(null, `Not a git repository: ${source}`);
      return;
    }

    const repoDir = join(this.instanceDir, "repos");
    mkdirSync(repoDir, { recursive: true });
    const safeName = `${basename(source)}-${branch.replace(/\//g, "-")}`;
    const worktreePath = join(repoDir, safeName);

    try {
      // Resolve branch/ref to verify it exists
      await execFileAsync("git", ["rev-parse", "--verify", branch], { cwd: source });
      await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, branch], { cwd: source });
      const { stdout: commitHash } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: worktreePath });
      respond({ path: worktreePath, branch, source, commit: commitHash.trim() });
    } catch (err) {
      respond(null, `Failed to checkout: ${(err as Error).message}`);
    }
  }

  private async handleReleaseRepo(
    args: Record<string, unknown>,
    respond: (result: unknown, error?: string) => void,
  ): Promise<void> {
    const repoPath = args.path as string;
    const reposDir = join(this.instanceDir, "repos");

    // Safety: only allow releasing paths under our repos/ directory
    if (!repoPath.startsWith(reposDir)) {
      respond(null, `Cannot release path outside instance repos directory`);
      return;
    }

    try {
      const { execFile: execFileCb } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFileCb);
      await execFileAsync("git", ["worktree", "remove", "--force", repoPath]);
    } catch {
      // Fallback: rm directly if git worktree remove fails
      try { rmSync(repoPath, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    respond({ released: true, path: repoPath });
  }

  private buildSnapshotPrompt(): string | null {
    const snapshotPath = join(this.instanceDir, "rotation-state.json");
    try {
      if (!existsSync(snapshotPath)) return null;
      const snapshot: RotationSnapshot = JSON.parse(readFileSync(snapshotPath, "utf-8"));

      // Mark consumed in-memory to prevent re-injection on crash respawn.
      // Delete file so subsequent daemon restarts don't re-inject stale snapshot.
      this.snapshotConsumed = true;
      try { unlinkSync(snapshotPath); } catch { /* best effort */ }

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
