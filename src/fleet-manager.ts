import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { FleetConfig, InstanceConfig, CostGuardConfig, DailySummaryConfig } from "./types.js";
import type { RouteTarget } from "./meeting/types.js";
import { loadFleetConfig, DEFAULT_COST_GUARD, DEFAULT_DAILY_SUMMARY } from "./config.js";
import { EventLog } from "./event-log.js";
import { CostGuard, formatCents } from "./cost-guard.js";
import { TmuxManager } from "./tmux-manager.js";
import { TelegramAdapter } from "./channel/adapters/telegram.js";
import { AccessManager } from "./channel/access-manager.js";
import { IpcClient } from "./channel/ipc-bridge.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import { createLogger, type Logger } from "./logger.js";
import { processAttachments } from "./channel/attachment-handler.js";
import { routeToolCall } from "./channel/tool-router.js";
import { Scheduler } from "./scheduler/index.js";
import type { Schedule, SchedulerConfig } from "./scheduler/index.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./scheduler/index.js";
import type { FleetContext } from "./fleet-context.js";
import { TopicCommands } from "./topic-commands.js";
import { MeetingManager } from "./meeting-manager.js";
import type { HangDetector } from "./hang-detector.js";
import { DailySummary } from "./daily-summary.js";

const TMUX_SESSION = "ccd";

export class FleetManager implements FleetContext {
  private children: Map<string, import("node:child_process").ChildProcess> = new Map();
  private daemons: Map<string, InstanceType<typeof import("./daemon.js").Daemon>> = new Map();
  fleetConfig: FleetConfig | null = null;
  adapter: ChannelAdapter | null = null;
  routingTable: Map<number, RouteTarget> = new Map();
  instanceIpcClients: Map<string, IpcClient> = new Map();
  scheduler: Scheduler | null = null;
  private configPath: string = "";
  logger: Logger = createLogger("info");
  private topicCommands: TopicCommands;
  private meetingManager: MeetingManager;
  // sessionName → instanceName mapping for external sessions
  private sessionRegistry: Map<string, string> = new Map();
  eventLog: EventLog | null = null;
  costGuard: CostGuard | null = null;
  private statuslineWatchers = new Map<string, ReturnType<typeof setInterval>>();
  private instanceRateLimits = new Map<string, { five_hour_pct: number; seven_day_pct: number }>();
  private dailySummary: DailySummary | null = null;

  constructor(public dataDir: string) {
    this.topicCommands = new TopicCommands(this);
    this.meetingManager = new MeetingManager(this);
  }

  /** Load fleet.yaml and build routing table */
  loadConfig(configPath: string): FleetConfig {
    this.fleetConfig = loadFleetConfig(configPath);
    return this.fleetConfig;
  }

  /** Build topic routing table: { topicId -> RouteTarget } */
  buildRoutingTable(): Map<number, RouteTarget> {
    const table = new Map<number, RouteTarget>();
    if (!this.fleetConfig) return table;
    for (const [name, inst] of Object.entries(this.fleetConfig.instances)) {
      if (inst.topic_id != null) {
        table.set(inst.topic_id, { kind: "instance", name });
      }
    }
    return table;
  }

  getInstanceDir(name: string): string {
    return join(this.dataDir, "instances", name);
  }

  getInstanceStatus(name: string): "running" | "stopped" | "crashed" {
    const pidPath = join(this.getInstanceDir(name), "daemon.pid");
    if (!existsSync(pidPath)) return "stopped";
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      return "running";
    } catch {
      return "crashed";
    }
  }

  async startInstance(name: string, config: InstanceConfig, topicMode: boolean): Promise<void> {
    if (this.daemons.has(name)) {
      this.logger.info({ name }, "Instance already running, skipping");
      return;
    }

    const instanceDir = this.getInstanceDir(name);
    mkdirSync(instanceDir, { recursive: true });

    const { Daemon } = await import("./daemon.js");
    const { createBackend } = await import("./backend/factory.js");

    const backendName = config.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code";
    const backend = createBackend(backendName, instanceDir);
    const daemon = new Daemon(name, config, instanceDir, topicMode, backend);
    await daemon.start();
    this.daemons.set(name, daemon);

    daemon.on("rotation_quality", (data: Record<string, unknown>) => {
      this.eventLog?.insert(name, "context_rotation", data);
      this.logger.info({ name, ...data }, "Context rotation completed");
    });

    const hangDetector = daemon.getHangDetector();
    if (hangDetector) {
      hangDetector.on("hang", () => {
        this.eventLog?.insert(name, "hang_detected", {});
        this.logger.warn({ name }, "Instance appears hung");
        this.sendHangNotification(name);
      });
    }
  }

  async stopInstance(name: string): Promise<void> {
    const daemon = this.daemons.get(name);
    if (daemon) {
      await daemon.stop();
      this.daemons.delete(name);
    } else {
      const pidPath = join(this.getInstanceDir(name), "daemon.pid");
      if (existsSync(pidPath)) {
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        try { process.kill(pid, "SIGTERM"); } catch (e) { this.logger.debug({ err: e, pid }, "SIGTERM failed for stale process"); }
      }
    }
    // Clean up ephemeral instance resources (worktree, topic map)
    await this.meetingManager.cleanupEphemeral(name);
  }

  /** Load .env file from data dir into process.env */
  private loadEnvFile(): void {
    const envPath = join(this.dataDir, ".env");
    if (!existsSync(envPath)) return;
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx);
      const raw = trimmed.slice(eqIdx + 1);
      const value = raw.replace(/^["'](.*)["']$/, '$1');
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  /** Start all instances from fleet config */
  async startAll(configPath: string): Promise<void> {
    this.configPath = configPath;
    this.loadEnvFile();
    const fleet = this.loadConfig(configPath);
    const topicMode = fleet.channel?.mode === "topic";

    await TmuxManager.ensureSession(TMUX_SESSION);

    const pidPath = join(this.dataDir, "fleet.pid");
    writeFileSync(pidPath, String(process.pid), "utf-8");

    this.eventLog = new EventLog(join(this.dataDir, "events.db"));

    const costGuardConfig: CostGuardConfig = {
      ...DEFAULT_COST_GUARD,
      ...(fleet.defaults as Record<string, unknown>)?.cost_guard as Partial<CostGuardConfig> ?? {},
    };
    this.costGuard = new CostGuard(costGuardConfig, this.eventLog);
    this.costGuard.startMidnightReset();

    this.costGuard.on("warn", (instance: string, totalCents: number, limitCents: number) => {
      this.notifyInstanceTopic(instance, `⚠️ ${instance} cost: ${formatCents(totalCents)} / ${formatCents(limitCents)} (${Math.round(totalCents / limitCents * 100)}%)`);
    });

    this.costGuard.on("limit", (instance: string, totalCents: number, limitCents: number) => {
      this.notifyInstanceTopic(instance, `🛑 ${instance} daily limit ${formatCents(limitCents)} reached — pausing instance.`);
      this.eventLog?.insert(instance, "instance_paused", { reason: "cost_limit", cost_cents: totalCents });
      this.stopInstance(instance).catch(err => this.logger.error({ err, instance }, "Failed to pause instance on cost limit"));
    });

    const summaryConfig: DailySummaryConfig = {
      ...DEFAULT_DAILY_SUMMARY,
      ...(fleet.defaults as Record<string, unknown>)?.daily_summary as Partial<DailySummaryConfig> ?? {},
    };
    this.dailySummary = new DailySummary(summaryConfig, costGuardConfig.timezone, (text) => {
      if (!this.adapter || !this.fleetConfig?.channel?.group_id) return;
      this.adapter.sendText(String(this.fleetConfig.channel.group_id), text)
        .catch(e => this.logger.debug({ err: e }, "Failed to send daily summary"));
    }, () => {
      const instances = Object.keys(this.fleetConfig?.instances ?? {});
      const costMap = new Map<string, number>();
      for (const name of instances) {
        costMap.set(name, this.costGuard?.getDailyCostCents(name) ?? 0);
      }
      return DailySummary.generateText(
        this.eventLog!,
        instances,
        costMap,
        this.costGuard?.getFleetTotalCents() ?? 0,
      );
    });
    this.dailySummary.start();

    for (const [name, config] of Object.entries(fleet.instances)) {
      await this.startInstance(name, config, topicMode && !config.channel);
    }

    if (topicMode && fleet.channel) {
      await this.topicCommands.autoCreateTopics();
      this.routingTable = this.buildRoutingTable();
      const routeSummary = [...this.routingTable.entries()].map(([tid, target]) => `#${tid}→${target.name}`).join(", ");
      this.logger.info(`Routes: ${routeSummary}`);

      const schedulerConfig: SchedulerConfig = {
        ...DEFAULT_SCHEDULER_CONFIG,
        ...(this.fleetConfig?.defaults as Record<string, unknown>)?.scheduler as Partial<SchedulerConfig> ?? {},
      };

      this.scheduler = new Scheduler(
        join(this.dataDir, "scheduler.db"),
        (schedule) => this.handleScheduleTrigger(schedule),
        schedulerConfig,
        (name) => this.fleetConfig?.instances?.[name] != null,
      );
      this.scheduler.init();
      this.logger.info("Scheduler initialized");

      await this.startSharedAdapter(fleet);

      await new Promise(r => setTimeout(r, 3000));
      await this.connectToInstances(fleet);

      for (const name of Object.keys(fleet.instances)) {
        this.startStatuslineWatcher(name);
      }
    }

    // SIGHUP: reload scheduler (use once + re-register to avoid duplicates)
    const onSighup = () => {
      this.logger.info("Received SIGHUP, reloading scheduler...");
      this.scheduler?.reload();
      process.once("SIGHUP", onSighup);
    };
    process.once("SIGHUP", onSighup);

    const onRestart = () => {
      this.logger.info("Received SIGUSR2, initiating graceful restart...");
      this.restartInstances()
        .catch(err => this.logger.error({ err }, "Graceful restart failed"))
        .finally(() => process.once("SIGUSR2", onRestart));
    };
    process.once("SIGUSR2", onRestart);
  }

  /** Start the shared Telegram adapter for topic mode */
  private async startSharedAdapter(fleet: FleetConfig): Promise<void> {
    const channelConfig = fleet.channel!;
    const botToken = process.env[channelConfig.bot_token_env];
    if (!botToken) {
      this.logger.warn({ env: channelConfig.bot_token_env }, "Bot token env not set, skipping shared adapter");
      return;
    }

    const accessDir = join(this.dataDir, "access");
    mkdirSync(accessDir, { recursive: true });
    const accessManager = new AccessManager(
      channelConfig.access,
      join(accessDir, "access.json"),
    );
    const inboxDir = join(this.dataDir, "inbox");
    mkdirSync(inboxDir, { recursive: true });

    this.adapter = new TelegramAdapter({
      id: "tg-fleet",
      botToken,
      accessManager,
      inboxDir,
    });

    this.adapter.on("message", (msg: InboundMessage) => {
      this.handleInboundMessage(msg);
    });

    this.adapter.on("callback_query", async (data: { callbackData: string; chatId: string; threadId?: string; messageId: string }) => {
      if (data.callbackData.startsWith("hang:")) {
        const parts = data.callbackData.split(":");
        const action = parts[1];
        const instanceName = parts[2];
        if (action === "restart") {
          await this.stopInstance(instanceName);
          const config = this.fleetConfig?.instances[instanceName];
          if (config) {
            const topicMode = this.fleetConfig?.channel?.mode === "topic" && !config.channel;
            await this.startInstance(instanceName, config, topicMode);
            await new Promise(r => setTimeout(r, 3000));
            await this.connectIpcToInstance(instanceName);
          }
          this.adapter?.editMessage(data.chatId, data.messageId, `🔄 ${instanceName} restarted.`).catch(() => {});
        } else {
          this.adapter?.editMessage(data.chatId, data.messageId, `⏳ Continuing to wait for ${instanceName}.`).catch(() => {});
        }
        return;
      }
      this.topicCommands.handleCallbackQuery(data);
    });

    this.adapter.on("topic_closed", (data: { chatId: string; threadId: string }) => {
      this.topicCommands.handleTopicDeleted(parseInt(data.threadId, 10));
    });

    await this.topicCommands.registerBotCommands();
    await this.adapter.start();
    if (fleet.channel?.group_id) {
      (this.adapter as TelegramAdapter).setLastChatId(String(fleet.channel.group_id));
    }

    this.adapter.on("started", (username: string) => {
      this.logger.info(`Telegram bot @${username} polling`);
    });
    this.adapter.on("polling_conflict", ({ attempt, delay }: { attempt: number; delay: number }) => {
      this.logger.warn(`409 Conflict (attempt ${attempt}), retry in ${delay / 1000}s`);
    });
    this.adapter.on("handler_error", (err: unknown) => {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Telegram handler error");
    });

    this.startTopicCleanupPoller();
  }

  /** Connect IPC clients to each daemon instance's channel.sock */
  private async connectToInstances(fleet: FleetConfig): Promise<void> {
    for (const name of Object.keys(fleet.instances)) {
      await this.connectIpcToInstance(name);
    }
  }

  /** Connect IPC to a single instance with all handlers */
  async connectIpcToInstance(name: string): Promise<void> {
    const sockPath = join(this.getInstanceDir(name), "channel.sock");
    if (!existsSync(sockPath)) return;

    const ipc = new IpcClient(sockPath);
    try {
      await ipc.connect();
      this.instanceIpcClients.set(name, ipc);
      ipc.on("message", (msg: Record<string, unknown>) => {
        if (msg.type === "mcp_ready") {
          // Register external sessions (sessionName differs from instance name)
          const sessionName = msg.sessionName as string | undefined;
          if (sessionName && sessionName !== name) {
            this.sessionRegistry.set(sessionName, name);
            this.logger.info({ sessionName, instanceName: name }, "Registered external session");
          }
        } else if (msg.type === "fleet_outbound") {
          // Auto-register external session on first outbound message — covers the
          // race where mcp_ready arrived before fleet manager connected and query_sessions
          // fired before the MCP server reconnected.
          const sender = msg.senderSessionName as string | undefined;
          if (sender && sender !== name && !this.sessionRegistry.has(sender)) {
            this.sessionRegistry.set(sender, name);
            this.logger.info({ sessionName: sender, instanceName: name }, "Registered external session");
          }
          this.handleOutboundFromInstance(name, msg);
        } else if (msg.type === "fleet_approval_request") {
          this.handleApprovalFromInstance(name, msg);
        } else if (msg.type === "fleet_tool_status") {
          this.handleToolStatusFromInstance(name, msg);
        } else if (msg.type === "fleet_schedule_create" || msg.type === "fleet_schedule_list" ||
                   msg.type === "fleet_schedule_update" || msg.type === "fleet_schedule_delete") {
          this.handleScheduleCrud(name, msg);
        }
      });
      // Ask daemon for any sessions that registered before we connected
      // (fixes race condition where mcp_ready was broadcast before fleet manager connected)
      ipc.send({ type: "query_sessions" });
      this.logger.debug({ name }, "Connected to instance IPC");
      if (!this.statuslineWatchers.has(name)) {
        this.startStatuslineWatcher(name);
      }
    } catch (err) {
      this.logger.warn({ name, err }, "Failed to connect to instance IPC");
    }
  }

  /** Handle inbound message — transcribe voice if present, then route */
  private async handleInboundMessage(msg: InboundMessage): Promise<void> {
    const threadId = msg.threadId ? parseInt(msg.threadId, 10) : undefined;
    if (threadId == null) {
      // General topic: try topic commands first, then meeting commands
      if (await this.topicCommands.handleGeneralCommand(msg)) return;
      if (await this.meetingManager.handleCommand(msg)) return;
      return;
    }

    const target = this.routingTable.get(threadId);
    if (!target) {
      this.topicCommands.handleUnboundTopic(msg);
      return;
    }
    const instanceName = target.name;

    const { text, extraMeta } = await processAttachments(msg, this.adapter!, this.logger, instanceName);

    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc) {
      this.logger.warn({ instanceName }, "No IPC connection to instance");
      return;
    }

    if (this.adapter && msg.chatId && msg.messageId) {
      this.adapter.react(msg.chatId, msg.messageId, "👀")
        .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
    }

    ipc.send({
      type: "fleet_inbound",
      content: text,
      targetSession: instanceName, // Telegram messages → instance's own session
      meta: {
        chat_id: msg.chatId,
        message_id: msg.messageId,
        user: msg.username,
        user_id: msg.userId,
        ts: msg.timestamp.toISOString(),
        thread_id: msg.threadId ?? "",
        ...extraMeta,
      },
    });
    this.logger.info(`← ${instanceName} ${msg.username}: ${(text ?? "").slice(0, 100)}`);
  }

  /** Handle outbound tool calls from a daemon instance */
  private handleOutboundFromInstance(instanceName: string, msg: Record<string, unknown>): void {
    if (!this.adapter) return;
    const tool = msg.tool as string;
    const args = (msg.args ?? {}) as Record<string, unknown>;
    const requestId = msg.requestId as number | undefined;
    const fleetRequestId = msg.fleetRequestId as string | undefined;
    const senderSessionName = msg.senderSessionName as string | undefined;

    const respond = (result: unknown, error?: string) => {
      const ipc = this.instanceIpcClients.get(instanceName);
      if (fleetRequestId) {
        ipc?.send({ type: "fleet_outbound_response", fleetRequestId, result, error });
      } else {
        ipc?.send({ type: "fleet_outbound_response", requestId, result, error });
      }
    };

    // Resolve threadId from instance → topic_id mapping
    const ephemeralTopicId = this.meetingManager.getEphemeralTopicId(instanceName);
    const instanceConfig = this.fleetConfig?.instances[instanceName];
    const threadId = args.thread_id as string ?? (ephemeralTopicId ? String(ephemeralTopicId) : (instanceConfig?.topic_id ? String(instanceConfig.topic_id) : undefined));

    // Route standard channel tools (reply, react, edit_message, download_attachment)
    if (routeToolCall(this.adapter, tool, args, threadId, respond)) {
      if (tool === "reply") {
        this.logger.info(`→ ${instanceName} claude: ${(args.text as string ?? "").slice(0, 100)}`);
      }
      return;
    }

    // Fleet-specific tools
    switch (tool) {
      case "send_to_instance": {
        const targetName = args.instance_name as string;
        const message = args.message as string;
        const senderLabel = senderSessionName ?? instanceName;
        const isExternalSender = senderSessionName != null && senderSessionName !== instanceName;

        // Resolve target: could be an instance name or an external session name
        let targetIpc = this.instanceIpcClients.get(targetName);
        let targetSession: string = targetName; // default: target is the instance itself
        let targetInstanceName = targetName;

        if (!targetIpc) {
          // Check if target is an external session
          const hostInstance = this.sessionRegistry.get(targetName);
          if (hostInstance) {
            targetIpc = this.instanceIpcClients.get(hostInstance);
            targetSession = targetName; // deliver to the external session
            targetInstanceName = hostInstance;
          }
        }

        if (!targetIpc) {
          respond(null, `Instance or session not found: ${targetName}`);
          break;
        }

        targetIpc.send({
          type: "fleet_inbound",
          targetSession,
          content: message,
          meta: {
            chat_id: "",
            message_id: `xmsg-${Date.now()}`,
            user: `instance:${senderLabel}`,
            user_id: `instance:${senderLabel}`,
            ts: new Date().toISOString(),
            thread_id: "",
            from_instance: senderLabel,
          },
        });

        // Post to Telegram topics for visibility
        const groupId = this.fleetConfig?.channel?.group_id;
        if (groupId && this.adapter) {
          const senderTopicId = this.meetingManager.getEphemeralTopicId(instanceName)
            ?? this.fleetConfig?.instances[instanceName]?.topic_id;
          const targetTopicId = this.meetingManager.getEphemeralTopicId(targetInstanceName)
            ?? this.fleetConfig?.instances[targetInstanceName]?.topic_id;
          const preview = message.length > 200 ? message.slice(0, 200) + "…" : message;

          // Only post to sender topic if sender is the instance itself (not external)
          if (senderTopicId && !isExternalSender) {
            this.adapter.sendText(String(groupId), `→ ${targetName}: ${preview}`, {
              threadId: String(senderTopicId),
            }).catch(e => this.logger.debug({ err: e }, "Failed to post cross-instance notification"));
          }
          // Only post to target topic if target is an instance (not external session)
          if (targetTopicId && !this.sessionRegistry.has(targetName)) {
            this.adapter.sendText(String(groupId), `← ${senderLabel}: ${preview}`, {
              threadId: String(targetTopicId),
            }).catch(e => this.logger.debug({ err: e }, "Failed to post cross-instance notification"));
          }
        }

        this.logger.info(`✉ ${senderLabel} → ${targetName}: ${message.slice(0, 100)}`);
        respond({ sent: true, target: targetName });
        break;
      }

      case "list_instances": {
        const senderLabel = senderSessionName ?? instanceName;
        const instances = [...this.daemons.keys()]
          .filter(name => name !== instanceName && name !== senderLabel)
          .map(name => {
            const config = this.fleetConfig?.instances[name];
            return { name, type: "instance" as const, topic_id: config?.topic_id ?? null };
          });
        // Include external sessions (excluding self)
        const sessions = [...this.sessionRegistry.entries()]
          .filter(([sessionName]) => sessionName !== senderLabel)
          .map(([sessionName, hostInstance]) => ({
            name: sessionName, type: "session" as const, host: hostInstance,
          }));
        respond({ instances: [...instances, ...sessions] });
        break;
      }

      default:
        respond(null, `Unknown tool: ${tool}`);
    }
  }

  /** Handle approval request from a daemon instance */
  private handleApprovalFromInstance(instanceName: string, msg: Record<string, unknown>): void {
    this.logger.debug({ instanceName, approvalId: msg.approvalId }, "Received approval request from instance");
    if (!this.adapter) {
      this.logger.warn({ instanceName }, "No adapter — denying approval");
      this.sendApprovalResponse(instanceName, msg.approvalId as string, "deny");
      return;
    }

    const prompt = msg.prompt as { tool_name: string; description: string; input_preview?: string };
    const approvalId = msg.approvalId as string;
    const instanceConfig = this.fleetConfig?.instances[instanceName];
    const threadId = instanceConfig?.topic_id ? String(instanceConfig.topic_id) : undefined;

    this.adapter.sendApproval(prompt, (decision) => {
      this.sendApprovalResponse(instanceName, approvalId, decision);
    }, undefined, threadId).catch((err) => {
      this.logger.warn({ instanceName, err: (err as Error).message }, "Failed to send approval to Telegram");
      this.sendApprovalResponse(instanceName, approvalId, "deny");
    });
  }

  private sendApprovalResponse(instanceName: string, approvalId: string, decision: "approve" | "deny"): void {
    const ipc = this.instanceIpcClients.get(instanceName);
    ipc?.send({ type: "fleet_approval_response", approvalId, decision });
  }

  /** Handle tool status update from a daemon instance */
  private handleToolStatusFromInstance(instanceName: string, msg: Record<string, unknown>): void {
    if (!this.adapter) return;

    const text = msg.text as string;
    const editMessageId = msg.editMessageId as string | null;
    const instanceConfig = this.fleetConfig?.instances[instanceName];
    const threadId = instanceConfig?.topic_id ? String(instanceConfig.topic_id) : undefined;
    const chatId = (this.adapter as TelegramAdapter).getLastChatId();
    if (!chatId) return;

    if (editMessageId) {
      this.adapter.editMessage(chatId, editMessageId, text).catch(e => this.logger.debug({ err: e }, "Failed to edit tool status message"));
    } else {
      this.adapter.sendText(chatId, text, { threadId }).then((sent) => {
        const ipc = this.instanceIpcClients.get(instanceName);
        ipc?.send({ type: "fleet_tool_status_ack", messageId: sent.messageId });
      }).catch(e => this.logger.debug({ err: e }, "Failed to send tool status message"));
    }
  }

  // ===================== Scheduler =====================

  private async handleScheduleTrigger(schedule: Schedule): Promise<void> {
    const { target, reply_chat_id, reply_thread_id, message, label, id, source } = schedule;

    const RATE_LIMIT_DEFER_THRESHOLD = 85;
    const rl = this.instanceRateLimits.get(target);
    if (rl && rl.five_hour_pct > RATE_LIMIT_DEFER_THRESHOLD) {
      this.scheduler!.recordRun(id, "deferred", `5hr rate limit at ${rl.five_hour_pct}%`);
      this.eventLog?.insert(target, "schedule_deferred", {
        schedule_id: id,
        label,
        five_hour_pct: rl.five_hour_pct,
      });
      this.notifyInstanceTopic(target, `⏳ Schedule "${label ?? id}" deferred — rate limit at ${rl.five_hour_pct}%`);
      this.logger.info({ target, scheduleId: id, rateLimitPct: rl.five_hour_pct }, "Schedule deferred due to rate limit");
      return;
    }

    const defaults = this.fleetConfig?.defaults as Record<string, unknown> | undefined;
    const schedulerDefaults = defaults?.scheduler as Record<string, unknown> | undefined;

    const retryCount = (schedulerDefaults?.retry_count as number) ?? 3;
    const retryInterval = (schedulerDefaults?.retry_interval_ms as number) ?? 30_000;

    const deliver = (): boolean => {
      const ipc = this.instanceIpcClients.get(target);
      if (!ipc?.connected) return false;

      ipc.send({
        type: "fleet_schedule_trigger",
        payload: { schedule_id: id, message: `[排程任務] ${message}`, label },
        meta: { chat_id: reply_chat_id, thread_id: reply_thread_id, user: "scheduler" },
      });
      return true;
    };

    if (deliver()) {
      this.scheduler!.recordRun(id, "delivered");
      if (source !== target) this.notifySourceTopic(schedule);
      return;
    }

    for (let i = 0; i < retryCount; i++) {
      await new Promise((r) => setTimeout(r, retryInterval));
      if (deliver()) {
        this.scheduler!.recordRun(id, "delivered");
        if (source !== target) this.notifySourceTopic(schedule);
        return;
      }
    }

    this.scheduler!.recordRun(id, "instance_offline", `retry ${retryCount}x failed`);
    this.notifyScheduleFailure(schedule);
  }

  private notifySourceTopic(schedule: Schedule): void {
    if (!this.adapter) return;
    const text = `⏰ 排程「${schedule.label ?? schedule.id}」已觸發，目標實例：${schedule.target}`;
    this.adapter.sendText(schedule.reply_chat_id, text, {
      threadId: schedule.reply_thread_id ?? undefined,
    }).catch((err: unknown) => this.logger.error({ err }, "Failed to send cross-instance notification"));
  }

  private notifyScheduleFailure(schedule: Schedule): void {
    if (!this.adapter) return;
    const text = `⏰ 排程「${schedule.label ?? schedule.id}」觸發失敗：實例 ${schedule.target} 未在線。`;
    this.adapter.sendText(schedule.reply_chat_id, text, {
      threadId: schedule.reply_thread_id ?? undefined,
    }).catch((err: unknown) => this.logger.error({ err }, "Failed to send schedule failure notification"));
  }

  private handleScheduleCrud(instanceName: string, msg: Record<string, unknown>): void {
    const fleetRequestId = msg.fleetRequestId as string;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const meta = (msg.meta ?? {}) as Record<string, string>;
    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc) return;

    try {
      let result: unknown;

      switch (msg.type) {
        case "fleet_schedule_create": {
          const params = {
            cron: payload.cron as string,
            message: payload.message as string,
            source: instanceName,
            target: (payload.target as string) || instanceName,
            reply_chat_id: meta.chat_id,
            reply_thread_id: meta.thread_id || null,
            label: payload.label as string | undefined,
            timezone: payload.timezone as string | undefined,
          };
          result = this.scheduler!.create(params);
          break;
        }
        case "fleet_schedule_list":
          result = this.scheduler!.list(payload.target as string | undefined);
          break;
        case "fleet_schedule_update":
          result = this.scheduler!.update(payload.id as string, payload as Record<string, unknown>);
          break;
        case "fleet_schedule_delete":
          this.scheduler!.delete(payload.id as string);
          result = "ok";
          break;
      }

      ipc.send({ type: "fleet_schedule_response", fleetRequestId, result });
    } catch (err) {
      ipc.send({ type: "fleet_schedule_response", fleetRequestId, error: (err as Error).message });
    }
  }

  // ===================== Topic management =====================

  /** Create a Telegram Forum Topic. Returns the message_thread_id. */
  async createForumTopic(topicName: string): Promise<number> {
    const groupId = this.fleetConfig?.channel?.group_id;
    const botTokenEnv = this.fleetConfig?.channel?.bot_token_env;
    if (!groupId || !botTokenEnv) throw new Error("No group_id or bot_token configured");
    const botToken = process.env[botTokenEnv];
    if (!botToken) throw new Error(`Bot token env var ${botTokenEnv} not set`);

    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/createForumTopic`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: groupId, name: topicName }),
      },
    );
    const data = await res.json() as { ok: boolean; result?: { message_thread_id: number }; description?: string };
    if (!data.ok || !data.result) {
      throw new Error(`createForumTopic failed: ${data.description ?? "unknown error"}`);
    }
    return data.result.message_thread_id;
  }

  private topicCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Periodically check if bound topics still exist */
  private startTopicCleanupPoller(): void {
    this.topicCleanupTimer = setInterval(async () => {
      if (!this.fleetConfig?.channel?.group_id) return;
      const tgAdapter = this.adapter as TelegramAdapter;
      const groupId = this.fleetConfig.channel.group_id;

      const bot = tgAdapter.getBot();
      for (const [threadId, target] of this.routingTable) {
        try {
          const msg = await bot.api.sendMessage(groupId, "\u200B", {
            message_thread_id: threadId,
          });
          await bot.api.deleteMessage(groupId, msg.message_id).catch(e => this.logger.debug({ err: e }, "Failed to delete topic probe message"));
        } catch (err: unknown) {
          const errMsg = String(err);
          if (errMsg.includes("thread not found") || errMsg.includes("TOPIC_ID_INVALID")) {
            const targetName = target.kind === "instance" ? target.name : "meeting";
            this.logger.info({ threadId, target: targetName }, "Topic deleted — auto-unbinding");
            await this.topicCommands.handleTopicDeleted(threadId);
          }
        }
      }
    }, 5 * 60_000); // Check every 5 minutes (reduced from 60s to avoid API rate limits)
  }

  /** Save fleet config back to fleet.yaml */
  saveFleetConfig(): void {
    if (!this.fleetConfig || !this.configPath) return;
    const toSave: Record<string, unknown> = {};
    if (this.fleetConfig.project_roots) toSave.project_roots = this.fleetConfig.project_roots;
    if (this.fleetConfig.channel) toSave.channel = this.fleetConfig.channel;
    if (Object.keys(this.fleetConfig.defaults).length > 0) toSave.defaults = this.fleetConfig.defaults;
    toSave.instances = {};
    for (const [name, inst] of Object.entries(this.fleetConfig.instances)) {
      (toSave.instances as Record<string, unknown>)[name] = {
        working_directory: inst.working_directory,
        topic_id: inst.topic_id,
      };
    }
    writeFileSync(this.configPath, yaml.dump(toSave, { lineWidth: 120 }));
    this.logger.info({ path: this.configPath }, "Saved fleet config");
  }

  private startStatuslineWatcher(name: string): void {
    const statusFile = join(this.getInstanceDir(name), "statusline.json");
    const timer = setInterval(() => {
      try {
        const data = JSON.parse(readFileSync(statusFile, "utf-8"));
        this.costGuard?.updateCost(name, data.cost?.total_cost_usd ?? 0);
        const rl = data.rate_limits;
        if (rl) {
          this.instanceRateLimits.set(name, {
            five_hour_pct: rl.five_hour?.used_percentage ?? 0,
            seven_day_pct: rl.seven_day?.used_percentage ?? 0,
          });
        }
      } catch { /* file may not exist yet or be mid-write */ }
    }, 10_000);
    this.statuslineWatchers.set(name, timer);
  }

  private notifyInstanceTopic(instanceName: string, text: string): void {
    if (!this.adapter) return;
    const groupId = this.fleetConfig?.channel?.group_id;
    if (!groupId) return;
    const threadId = this.fleetConfig?.instances[instanceName]?.topic_id;
    this.adapter.sendText(String(groupId), text, {
      threadId: threadId != null ? String(threadId) : undefined,
    }).catch(e => this.logger.debug({ err: e }, "Failed to send notification"));
  }

  private async sendHangNotification(instanceName: string): Promise<void> {
    if (!this.adapter) return;
    const groupId = this.fleetConfig?.channel?.group_id;
    if (!groupId) return;
    const threadId = this.fleetConfig?.instances[instanceName]?.topic_id;

    const tgAdapter = this.adapter as TelegramAdapter;
    const { InlineKeyboard } = await import("grammy");
    const keyboard = new InlineKeyboard()
      .text("🔄 Force restart", `hang:restart:${instanceName}`)
      .text("⏳ Keep waiting", `hang:wait:${instanceName}`);

    await tgAdapter.sendTextWithKeyboard(
      String(groupId),
      `⚠️ ${instanceName} appears hung (no activity for 15+ minutes)`,
      keyboard,
      threadId != null ? String(threadId) : undefined,
    ).catch(e => this.logger.debug({ err: e }, "Failed to send hang notification"));
  }

  private clearStatuslineWatchers(): void {
    for (const [, timer] of this.statuslineWatchers) clearInterval(timer);
    this.statuslineWatchers.clear();
    this.instanceRateLimits.clear();
  }

  async stopAll(): Promise<void> {
    this.clearStatuslineWatchers();
    this.costGuard?.stop();
    this.dailySummary?.stop();

    if (this.topicCleanupTimer) {
      clearInterval(this.topicCleanupTimer);
      this.topicCleanupTimer = null;
    }

    this.scheduler?.shutdown();

    await Promise.allSettled(
      [...this.daemons.entries()].map(async ([name, daemon]) => {
        try {
          await daemon.gracefulStop();
        } catch (err) {
          this.logger.warn({ name, err }, "Graceful stop failed, force stopping");
          await daemon.stop();
        }
        this.daemons.delete(name);
        await this.meetingManager.cleanupEphemeral(name);
      })
    );

    for (const [, ipc] of this.instanceIpcClients) {
      await ipc.close();
    }
    this.instanceIpcClients.clear();

    if (this.adapter) {
      await this.adapter.stop();
      this.adapter = null;
    }

    this.eventLog?.close();

    const pidPath = join(this.dataDir, "fleet.pid");
    try { unlinkSync(pidPath); } catch (e) { this.logger.debug({ err: e }, "Failed to remove fleet PID file"); }
  }

  /**
   * Graceful restart: wait for all instances to be idle, then stop and start them.
   */
  async restartInstances(): Promise<void> {
    if (!this.configPath) {
      this.logger.error("Cannot restart: no config path (was startAll called?)");
      return;
    }
    const instanceNames = [...this.daemons.keys()];
    if (instanceNames.length === 0) {
      this.logger.info("No instances to restart");
      return;
    }

    this.logger.info(`Graceful restart: waiting for ${instanceNames.length} instances to idle...`);

    const groupId = this.fleetConfig?.channel?.group_id;
    if (groupId && this.adapter) {
      await this.adapter.sendText(String(groupId), `🔄 Graceful restart initiated — waiting for all instances to idle...`)
        .catch(e => this.logger.debug({ err: e }, "Failed to post restart notification"));
    }

    const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const idleDeadline = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("Idle wait timed out after 5 minutes")), IDLE_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        Promise.all(
          instanceNames.map(async (name) => {
            const daemon = this.daemons.get(name);
            if (daemon) {
              this.logger.info(`Waiting for ${name} to idle...`);
              await daemon.waitForIdle(10_000);
              this.logger.info(`${name} is idle`);
            }
          })
        ),
        idleDeadline,
      ]);
    } catch (err) {
      this.logger.warn({ err }, "Idle wait timed out — force restarting");
    } finally {
      clearTimeout(timeoutHandle!);
    }

    this.logger.info("All instances idle — restarting...");

    this.clearStatuslineWatchers();

    for (const [, ipc] of this.instanceIpcClients) {
      await ipc.close();
    }
    this.instanceIpcClients.clear();

    await Promise.allSettled(
      instanceNames.map(name => this.stopInstance(name))
    );

    const fleet = this.loadConfig(this.configPath);
    this.fleetConfig = fleet;
    const topicMode = fleet.channel?.mode === "topic";

    for (const [name, config] of Object.entries(fleet.instances)) {
      await this.startInstance(name, config, topicMode && !config.channel);
    }

    if (topicMode) {
      this.routingTable = this.buildRoutingTable();
      await new Promise(r => setTimeout(r, 3000));
      await this.connectToInstances(fleet);

      for (const name of Object.keys(fleet.instances)) {
        this.startStatuslineWatcher(name);
      }
    }

    this.logger.info("Graceful restart complete");
    if (groupId && this.adapter) {
      await this.adapter.sendText(String(groupId), `✅ Graceful restart complete — ${this.daemons.size} instances running`)
        .catch(e => this.logger.debug({ err: e }, "Failed to post restart completion notification"));
    }
  }
}
