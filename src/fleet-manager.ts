import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { access } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { FleetConfig, InstanceConfig, CostGuardConfig, DailySummaryConfig } from "./types.js";
import type { RouteTarget } from "./meeting/types.js";
import { loadFleetConfig, DEFAULT_COST_GUARD, DEFAULT_DAILY_SUMMARY, DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { EventLog } from "./event-log.js";
import { CostGuard, formatCents } from "./cost-guard.js";
import { TmuxManager } from "./tmux-manager.js";
import { AccessManager } from "./channel/access-manager.js";
import { IpcClient } from "./channel/ipc-bridge.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import { createAdapter } from "./channel/factory.js";
import { createLogger, type Logger } from "./logger.js";
import { processAttachments } from "./channel/attachment-handler.js";
import { routeToolCall } from "./channel/tool-router.js";
import { Scheduler } from "./scheduler/index.js";
import type { Schedule, SchedulerConfig } from "./scheduler/index.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./scheduler/index.js";
import type { FleetContext } from "./fleet-context.js";
import { TopicCommands, sanitizeInstanceName } from "./topic-commands.js";
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

    // Auto-create general instance if none configured
    const hasGeneralTopic = Object.values(fleet.instances).some(inst => inst.general_topic === true);
    if (!hasGeneralTopic) {
      this.logger.info("Auto-creating general instance for General Topic");
      const generalDir = join(homedir(), ".claude-channel-daemon", "general");
      mkdirSync(generalDir, { recursive: true });
      const claudeMdPath = join(generalDir, "CLAUDE.md");
      if (!existsSync(claudeMdPath)) {
        writeFileSync(claudeMdPath, `# General Assistant

你是這個 CCD fleet 的通用入口。

## 行為準則

- 簡單任務（搜尋、翻譯、一般問答）：自己處理。
- 屬於特定專案的任務：用 list_instances() 找到對應 agent，需要時用 start_instance() 啟動，再用 send_to_instance() 委派。
- 需要多個 agent 協作的任務：協調各 agent 並行或串行執行，收集結果後彙整。
- 使用者想開新的專案 agent：用 create_instance() 建立。
- 收到其他 instance 委派的任務時，完成後一定要用 send_to_instance() 回報結果。

## 委派原則

只在有具體理由時才委派：
- 任務需要存取特定專案的檔案
- 任務可以從多 agent 平行執行中受益
- 保留自己的 context 更重要，把不相關的工作交出去
- 絕不把任務回委給委派你的 instance

自己能做的，就自己做。
`, "utf-8");
      }
      const generalConfig: InstanceConfig = {
        ...DEFAULT_INSTANCE_CONFIG,
        working_directory: generalDir,
        general_topic: true,
      };
      fleet.instances["general"] = generalConfig;
      this.saveFleetConfig();
    }

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

    this.adapter = await createAdapter(channelConfig, {
      id: "fleet",
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
    });

    this.adapter.on("topic_closed", (data: { chatId: string; threadId: string }) => {
      this.topicCommands.handleTopicDeleted(parseInt(data.threadId, 10));
    });

    await this.topicCommands.registerBotCommands();
    await this.adapter.start();
    if (fleet.channel?.group_id) {
      this.adapter.setChatId(String(fleet.channel.group_id));
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
        } else if (msg.type === "session_disconnected") {
          const sessionName = msg.sessionName as string | undefined;
          if (sessionName && this.sessionRegistry.has(sessionName)) {
            this.sessionRegistry.delete(sessionName);
            this.logger.info({ sessionName, instanceName: name }, "Unregistered external session");
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
          this.handleOutboundFromInstance(name, msg).catch(err => this.logger.error({ err }, "handleOutboundFromInstance error"));
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
  private findGeneralInstance(): string | undefined {
    if (!this.fleetConfig) return undefined;
    for (const [name, config] of Object.entries(this.fleetConfig.instances)) {
      if (config.general_topic === true) {
        return this.daemons.has(name) ? name : undefined;
      }
    }
    return undefined;
  }

  private async handleInboundMessage(msg: InboundMessage): Promise<void> {
    const threadId = msg.threadId ? parseInt(msg.threadId, 10) : undefined;
    if (threadId == null) {
      // General topic: check for /status command
      if (await this.topicCommands.handleGeneralCommand(msg)) return;

      // Forward to General Topic instance if configured
      const generalInstance = this.findGeneralInstance();
      if (generalInstance) {
        const { text, extraMeta } = await processAttachments(msg, this.adapter!, this.logger, generalInstance);
        const ipc = this.instanceIpcClients.get(generalInstance);
        if (ipc) {
          if (this.adapter && msg.chatId && msg.messageId) {
            this.adapter.react(msg.chatId, msg.messageId, "👀")
              .catch(e => this.logger.debug({ err: (e as Error).message }, "Auto-react failed"));
          }
          ipc.send({
            type: "fleet_inbound",
            content: text,
            targetSession: generalInstance,
            meta: {
              chat_id: msg.chatId,
              message_id: msg.messageId,
              user: msg.username,
              user_id: msg.userId,
              ts: msg.timestamp.toISOString(),
              thread_id: "",
              ...extraMeta,
            },
          });
          this.logger.info(`← ${generalInstance} ${msg.username}: ${(text ?? "").slice(0, 100)}`);
        }
      }
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
  private async handleOutboundFromInstance(instanceName: string, msg: Record<string, unknown>): Promise<void> {
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
          // Check if instance exists in config but is stopped
          const existsInConfig = targetName in (this.fleetConfig?.instances ?? {});
          if (existsInConfig) {
            respond(null, `Instance '${targetName}' is stopped. Use start_instance('${targetName}') to start it first.`);
          } else {
            respond(null, `Instance or session not found: ${targetName}`);
          }
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
        const allInstances = Object.entries(this.fleetConfig?.instances ?? {})
          .filter(([name]) => name !== instanceName && name !== senderLabel)
          .map(([name, config]) => ({
            name,
            type: "instance" as const,
            status: this.daemons.has(name) ? "running" : "stopped",
            working_directory: config.working_directory,
            topic_id: config.topic_id ?? null,
          }));
        // Include external sessions (excluding self)
        const externalSessions = [...this.sessionRegistry.entries()]
          .filter(([sessName]) => sessName !== senderLabel)
          .map(([sessName, hostInstance]) => ({
            name: sessName, type: "session" as const, host: hostInstance,
          }));
        respond({ instances: allInstances, external_sessions: externalSessions });
        break;
      }

      case "start_instance": {
        const targetName = args.name as string;

        // Already running?
        if (this.daemons.has(targetName)) {
          respond({ success: true, status: "already_running" });
          break;
        }

        // Exists in config?
        const targetConfig = this.fleetConfig?.instances[targetName];
        if (!targetConfig) {
          respond(null, `Instance '${targetName}' not found in fleet config`);
          break;
        }

        try {
          await this.startInstance(targetName, targetConfig, true);
          await this.connectIpcToInstance(targetName);
          respond({ success: true, status: "started" });
        } catch (err) {
          respond(null, `Failed to start instance '${targetName}': ${(err as Error).message}`);
        }
        break;
      }

      case "create_instance": {
        const directory = (args.directory as string).replace(/^~/, process.env.HOME || "~");
        const topicName = (args.topic_name as string) || basename(directory);

        // Validate directory exists
        try {
          await access(directory);
        } catch {
          respond(null, `Directory does not exist: ${directory}`);
          break;
        }

        // Check if already bound (normalize ~ in config paths for comparison)
        const expandHome = (p: string) => p.replace(/^~/, process.env.HOME || "~");
        const existingInstance = Object.entries(this.fleetConfig?.instances ?? {})
          .find(([_, config]) => expandHome(config.working_directory) === directory);
        if (existingInstance) {
          const [eName, eConfig] = existingInstance;
          respond({
            success: true,
            status: "already_exists",
            name: eName,
            topic_id: eConfig.topic_id,
            running: this.daemons.has(eName),
          });
          break;
        }

        // Sequential steps with rollback
        let createdTopicId: number | undefined;
        let newInstanceName: string | undefined;

        try {
          // Step a: Create Telegram topic
          createdTopicId = await this.createForumTopic(topicName);

          // Step b: Register in config
          newInstanceName = `${sanitizeInstanceName(basename(directory))}-t${createdTopicId}`;
          const instanceConfig = {
            ...this.fleetConfig!.defaults,
            working_directory: directory,
            topic_id: createdTopicId,
          } as InstanceConfig;
          this.fleetConfig!.instances[newInstanceName] = instanceConfig;
          this.routingTable.set(createdTopicId, { kind: "instance", name: newInstanceName });
          this.saveFleetConfig();

          // Step c: Start instance
          await this.startInstance(newInstanceName, instanceConfig, true);
          await this.connectIpcToInstance(newInstanceName);

          respond({
            success: true,
            name: newInstanceName,
            topic_id: createdTopicId,
          });
        } catch (err) {
          // Rollback in reverse order
          if (newInstanceName && this.daemons.has(newInstanceName)) {
            await this.stopInstance(newInstanceName).catch(() => {});
          }
          if (newInstanceName && this.fleetConfig?.instances[newInstanceName]) {
            delete this.fleetConfig.instances[newInstanceName];
            if (createdTopicId) this.routingTable.delete(createdTopicId);
            this.saveFleetConfig();
          }
          if (createdTopicId) {
            await this.deleteForumTopic(createdTopicId);
          }
          respond(null, `Failed to create instance: ${(err as Error).message}`);
        }
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

    this.adapter.sendApproval(prompt, (decision: "approve" | "approve_always" | "deny") => {
      this.sendApprovalResponse(instanceName, approvalId, decision);
    }, undefined, threadId).catch((err) => {
      this.logger.warn({ instanceName, err: (err as Error).message }, "Failed to send approval to Telegram");
      this.sendApprovalResponse(instanceName, approvalId, "deny");
    });
  }

  private sendApprovalResponse(instanceName: string, approvalId: string, decision: "approve" | "approve_always" | "deny"): void {
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
    const chatId = this.adapter.getChatId();
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

  /** Create a forum topic via the adapter. Returns the message_thread_id. */
  async createForumTopic(topicName: string): Promise<number> {
    if (!this.adapter?.createTopic) {
      throw new Error("Adapter does not support topic creation");
    }
    return this.adapter.createTopic(topicName);
  }

  private async deleteForumTopic(topicId: number): Promise<void> {
    try {
      const groupId = this.fleetConfig?.channel?.group_id;
      const botTokenEnv = this.fleetConfig?.channel?.bot_token_env;
      if (!groupId || !botTokenEnv) return;
      const botToken = process.env[botTokenEnv];
      if (!botToken) return;

      await fetch(
        `https://api.telegram.org/bot${botToken}/deleteForumTopic`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: groupId, message_thread_id: topicId }),
        },
      );
    } catch (err) {
      this.logger.warn({ err, topicId }, "Failed to delete forum topic during rollback");
    }
  }

  private topicCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Periodically check if bound topics still exist */
  private startTopicCleanupPoller(): void {
    this.topicCleanupTimer = setInterval(async () => {
      if (!this.fleetConfig?.channel?.group_id || !this.adapter?.topicExists) return;

      for (const [threadId, target] of this.routingTable) {
        try {
          const exists = await this.adapter.topicExists(threadId);
          if (!exists) {
            const targetName = target.kind === "instance" ? target.name : "meeting";
            this.logger.info({ threadId, target: targetName }, "Topic deleted — auto-unbinding");
            await this.topicCommands.handleTopicDeleted(threadId);
          }
        } catch (err) {
          this.logger.debug({ err, threadId }, "Topic existence check failed");
        }
      }
    }, 5 * 60_000);
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
      const serialized: Record<string, unknown> = {
        working_directory: inst.working_directory,
        topic_id: inst.topic_id,
      };
      if (inst.general_topic) {
        serialized.general_topic = true;
      }
      (toSave.instances as Record<string, unknown>)[name] = serialized;
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

    await this.adapter.notifyAlert(String(groupId), {
      type: "hang",
      instanceName,
      message: `⚠️ ${instanceName} appears hung (no activity for 15+ minutes)`,
      choices: [
        { id: `hang:restart:${instanceName}`, label: "🔄 Force restart" },
        { id: `hang:wait:${instanceName}`, label: "⏳ Keep waiting" },
      ],
    }, {
      threadId: threadId != null ? String(threadId) : undefined,
    }).catch(e => this.logger.debug({ err: e }, "Failed to send hang notification"));
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
