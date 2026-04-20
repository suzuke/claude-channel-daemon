import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, rmSync, readdirSync, chmodSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgendHome } from "./paths.js";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { FleetConfig, InstanceConfig, CostGuardConfig, DailySummaryConfig, WebhookConfig } from "./types.js";
import { isProbeableRouteTarget, type RouteTarget } from "./fleet-context.js";
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
import type { HangDetector } from "./hang-detector.js";
import { DailySummary } from "./daily-summary.js";
import { WebhookEmitter } from "./webhook-emitter.js";
import { TmuxControlClient } from "./tmux-control.js";
import { safeHandler } from "./safe-async.js";
import { RoutingEngine } from "./routing-engine.js";
import { InstanceLifecycle, type LifecycleContext } from "./instance-lifecycle.js";
import { TopicArchiver, type ArchiverContext } from "./topic-archiver.js";
import { StatuslineWatcher, type StatuslineWatcherContext } from "./statusline-watcher.js";
import { outboundHandlers, type OutboundContext } from "./outbound-handlers.js";
import { handleWebRequest, broadcastSseEvent } from "./web-api.js";
import { handleAgentRequest, type AgentEndpointContext } from "./agent-endpoint.js";
import { ensureGeneralInstructions } from "./fleet-instructions.js";
import { rpcHandlers, summarizeToolCall, resolveDisplayName as rpcResolveDisplayName } from "./fleet-rpc-handlers.js";
import { ACTIVITY_VIEWER_HTML } from "./fleet-dashboard-html.js";
import { startHealthServer, getUiStatus as healthGetUiStatus } from "./fleet-health-server.js";

import { getTmuxSession } from "./config.js";

export function resolveReplyThreadId(
  argsThreadId: unknown,
  instanceConfig?: InstanceConfig,
): string | undefined {
  if (typeof argsThreadId === "string" && argsThreadId.length > 0) {
    return argsThreadId;
  }
  if (instanceConfig?.general_topic) {
    return undefined;
  }
  return instanceConfig?.topic_id != null ? String(instanceConfig.topic_id) : undefined;
}

export class FleetManager implements FleetContext, LifecycleContext, ArchiverContext, StatuslineWatcherContext, OutboundContext, AgentEndpointContext {
  private children: Map<string, import("node:child_process").ChildProcess> = new Map();
  readonly lifecycle: InstanceLifecycle;
  /** @deprecated Use lifecycle.daemons — kept for backward compat */
  get daemons() { return this.lifecycle.daemons; }
  fleetConfig: FleetConfig | null = null;
  adapter: ChannelAdapter | null = null;
  readonly routing = new RoutingEngine();
  get routingTable(): Map<string, RouteTarget> { return this.routing.map; }
  instanceIpcClients: Map<string, IpcClient> = new Map();
  scheduler: Scheduler | null = null;
  private configPath: string = "";
  logger: Logger = createLogger("info");
  private topicCommands: TopicCommands;
  // sessionName → instanceName mapping for external sessions
  sessionRegistry: Map<string, string> = new Map();
  eventLog: EventLog | null = null;
  costGuard: CostGuard | null = null;
  private statuslineWatcher: StatuslineWatcher;
  private dailySummary: DailySummary | null = null;
  private webhookEmitter: WebhookEmitter | null = null;

  // Topic icon + auto-archive state
  private topicIcons: { green?: string; blue?: string; red?: string } = {};
  private lastActivity = new Map<string, number>();
  private lastInboundUser = new Map<string, string>(); // instanceName → last username
  private topicArchiver: TopicArchiver;

  controlClient: TmuxControlClient | null = null;

  // Model failover state
  private failoverActive = new Map<string, string>(); // instance → current failover model

  // Health endpoint
  private healthServer: Server | null = null;
  private startedAt = 0;

  // Mirror topic: buffer cross-instance messages, flush every 3s
  private mirrorBuffer: string[] = [];
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;

  // Web UI: SSE clients + auth token
  private sseClients = new Set<import("node:http").ServerResponse>();
  private webToken: string | null = null;

  constructor(public dataDir: string) {
    this.lifecycle = new InstanceLifecycle(this);
    this.topicCommands = new TopicCommands(this);
    this.topicArchiver = new TopicArchiver(this);
    this.statuslineWatcher = new StatuslineWatcher(this);
  }

  // ── ArchiverContext bridge ────────────────────────────────────────────
  lastActivityMs(name: string): number {
    return this.lastActivity.get(name) ?? 0;
  }

  // ── LifecycleContext bridge methods ──────────────────────────────────────
  webhookEmit(event: string, name: string, data?: Record<string, unknown>): void {
    this.webhookEmitter?.emit(event, name, data);
  }

  // ── SysInfo ────────────────────────────────────────────────────────────
  getSysInfo(): import("./fleet-context.js").SysInfo {
    const mem = process.memoryUsage();
    const toMB = (b: number) => Math.round(b / 1024 / 1024 * 10) / 10;
    const instances = Object.keys(this.fleetConfig?.instances ?? {}).map(name => ({
      name,
      status: this.getInstanceStatus(name),
      ipc: this.instanceIpcClients.has(name),
      costCents: this.costGuard?.getDailyCostCents(name) ?? 0,
      rateLimits: this.statuslineWatcher.getRateLimits(name) ?? null,
    }));
    return {
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      memory_mb: { rss: toMB(mem.rss), heapUsed: toMB(mem.heapUsed), heapTotal: toMB(mem.heapTotal) },
      instances,
      fleet_cost_cents: this.costGuard?.getFleetTotalCents() ?? 0,
      fleet_cost_limit_cents: this.costGuard?.getLimitCents() ?? 0,
    };
  }

  /** Load fleet.yaml and build routing table */
  loadConfig(configPath: string): FleetConfig {
    this.fleetConfig = loadFleetConfig(configPath);
    this.warnOnUnresolvableProjectRoots();
    return this.fleetConfig;
  }

  /** Warn once about any project_roots that cannot be realpath'd. Without
   * this, a typo in fleet.yaml shows up as "Directory is not under
   * project_roots" at create-time, making the real problem invisible. */
  private warnedRoots = new Set<string>();
  private warnOnUnresolvableProjectRoots(): void {
    const roots = this.fleetConfig?.project_roots;
    if (!roots?.length) return;
    for (const r of roots) {
      if (this.warnedRoots.has(r)) continue;
      const raw = resolve(r.replace(/^~/, process.env.HOME || "~"));
      try {
        realpathSync(raw);
      } catch (err) {
        this.logger.warn(
          { root: r, resolved: raw, err: (err as Error).message },
          "project_roots entry cannot be resolved — instances rooted here will be rejected",
        );
        this.warnedRoots.add(r);
      }
    }
  }

  /** Build topic routing table: { topicId -> RouteTarget } */
  buildRoutingTable(): Map<string, RouteTarget> {
    if (this.fleetConfig) {
      this.routing.rebuild(this.fleetConfig);
    }
    return this.routing.map;
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
    if (config.general_topic) {
      ensureGeneralInstructions(config.working_directory, config.backend, this.logger);
    }
    await this.lifecycle.start(name, config, topicMode);
    // Auto-connect IPC — daemon.start() ensures socket is ready before resolving
    await this.connectIpcToInstance(name);
  }

  /**
   * Start instances with configurable concurrency and stagger delay.
   * Instances sharing the same working_directory are serialized within a group
   * to avoid config file races. Stagger delay is group-to-group, not instance-to-instance.
   * TODO: per-instance startup timeout (existing issue, not introduced here)
   */
  private async startInstancesWithConcurrency(
    entries: [string, InstanceConfig][],
    topicMode: boolean,
  ): Promise<void> {
    const raw = this.fleetConfig?.defaults?.startup;
    const concurrency = Math.max(1, Math.min(20, raw?.concurrency ?? 3));
    const staggerMs = Math.max(0, Math.min(30_000, raw?.stagger_delay_ms ?? 2000));

    const byWorkDir = new Map<string, [string, InstanceConfig][]>();
    for (const [name, config] of entries) {
      const dir = config.working_directory;
      if (!byWorkDir.has(dir)) byWorkDir.set(dir, []);
      byWorkDir.get(dir)!.push([name, config]);
    }
    const groups = [...byWorkDir.values()];

    let running = 0;
    let idx = 0;
    let lastStartAt = 0;
    let pendingTimer = false;

    await new Promise<void>((resolve) => {
      if (groups.length === 0) { resolve(); return; }
      const startNext = () => {
        if (pendingTimer) return;
        while (running < concurrency && idx < groups.length) {
          const now = Date.now();
          const elapsed = now - lastStartAt;
          if (lastStartAt > 0 && elapsed < staggerMs) {
            pendingTimer = true;
            setTimeout(() => { pendingTimer = false; startNext(); }, staggerMs - elapsed);
            return;
          }
          const group = groups[idx++];
          running++;
          lastStartAt = Date.now();
          (async () => {
            for (const [name, config] of group) {
              await this.startInstance(name, config, topicMode).catch((err) =>
                this.logger.error({ err, name }, "Failed to start instance"),
              );
            }
          })().finally(() => {
            running--;
            if (idx >= groups.length && running === 0) resolve();
            else startNext();
          });
        }
      };
      startNext();
    });
  }

  async stopInstance(name: string): Promise<void> {
    this.failoverActive.delete(name);
    return this.lifecycle.stop(name);
  }

  /** Restart a single instance, reloading fleet.yaml first to pick up config changes. */
  async restartSingleInstance(name: string): Promise<void> {
    if (this.configPath) {
      this.loadConfig(this.configPath);
      this.routing.rebuild(this.fleetConfig!);
    }
    const config = this.fleetConfig?.instances[name];
    if (!config) throw new Error(`Instance not found: ${name}`);
    await this.stopInstance(name);
    const topicMode = this.fleetConfig?.channel?.mode === "topic";
    await this.startInstance(name, config, topicMode ?? false);
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
      // .env file always wins over inherited shell env vars, so that
      // quickstart's newly written token overrides any stale value.
      process.env[key] = value;
    }
  }

  /** Start all instances from fleet config */
  async startAll(configPath: string): Promise<void> {
    this.configPath = configPath;
    this.loadEnvFile();
    const fleet = this.loadConfig(configPath);
    const topicMode = fleet.channel?.mode === "topic";

    // Set tmux socket isolation for custom AGEND_HOME
    const { getTmuxSocketName: getSocket } = await import("./paths.js");
    TmuxManager.setSocketName(getSocket());

    await TmuxManager.ensureSession(getTmuxSession());

    // Start tmux control mode client for idle detection
    if (!this.controlClient) {
      this.controlClient = new TmuxControlClient(getTmuxSession(), 2000, this.logger);
      this.controlClient.start();
    }
    // Stop any running daemons first (their health checks would respawn killed windows)
    for (const [name] of this.daemons) {
      await this.stopInstance(name);
    }

    // Then kill all remaining agend instance windows to prevent orphans.
    // Kill both known instance windows (stale from previous run) and orphaned
    // windows from deleted instances that are no longer in fleet.yaml.
    const agendNames = new Set(Object.keys(fleet.instances));
    agendNames.add("general");
    try {
      const existingWindows = await TmuxManager.listWindows(getTmuxSession());
      for (const w of existingWindows) {
        // Kill known instance windows (will be recreated)
        // Also kill orphaned windows: any window with a topic ID suffix (name-tNNNNN)
        // that isn't in the current config — these are leftovers from deleted instances
        const isKnownInstance = agendNames.has(w.name);
        const isOrphanedInstance = !isKnownInstance && /-t\d+$/.test(w.name);
        if (isKnownInstance || isOrphanedInstance) {
          if (isOrphanedInstance) this.logger.info({ window: w.name }, "Cleaning up orphaned tmux window");
          const tm = new TmuxManager(getTmuxSession(), w.id);
          await tm.killWindow();
        }
      }
    } catch (err) {
      this.logger.debug({ err }, "Startup tmux window cleanup failed (best effort)");
    }

    const pidPath = join(this.dataDir, "fleet.pid");
    writeFileSync(pidPath, String(process.pid), "utf-8");

    this.eventLog = new EventLog(join(this.dataDir, "events.db"));

    const costGuardConfig: CostGuardConfig = {
      ...DEFAULT_COST_GUARD,
      ...fleet.defaults.cost_guard,
    };
    this.costGuard = new CostGuard(costGuardConfig, this.eventLog);
    this.costGuard.startMidnightReset();

    const webhookConfigs: WebhookConfig[] = fleet.defaults.webhooks ?? [];
    if (webhookConfigs.length > 0) {
      this.webhookEmitter = new WebhookEmitter(webhookConfigs, this.logger);
      this.logger.info({ count: webhookConfigs.length }, "Webhook emitter initialized");
    }

    this.costGuard.on("warn", safeHandler((instance: string, totalCents: number, limitCents: number) => {
      this.notifyInstanceTopic(instance, `⚠️ ${instance} cost: ${formatCents(totalCents)} / ${formatCents(limitCents)} (${Math.round(totalCents / limitCents * 100)}%)`);
      this.webhookEmitter?.emit("cost_warning", instance, { cost_cents: totalCents, limit_cents: limitCents });
    }, this.logger, "costGuard.warn"));

    this.costGuard.on("limit", safeHandler(async (instance: string, totalCents: number, limitCents: number) => {
      this.notifyInstanceTopic(instance, `🛑 ${instance} daily limit ${formatCents(limitCents)} reached — pausing instance.`);
      this.eventLog?.insert(instance, "instance_paused", { reason: "cost_limit", cost_cents: totalCents });
      this.webhookEmitter?.emit("cost_limit", instance, { cost_cents: totalCents, limit_cents: limitCents });
      await this.stopInstance(instance);
    }, this.logger, "costGuard.limit"));

    const summaryConfig: DailySummaryConfig = {
      ...DEFAULT_DAILY_SUMMARY,
      ...fleet.defaults.daily_summary,
    };
    this.dailySummary = new DailySummary(summaryConfig, costGuardConfig.timezone, (text) => {
      if (!this.adapter || !this.fleetConfig?.channel?.group_id) return;
      this.adapter.sendText(String(this.fleetConfig.channel.group_id), text)
        .catch(e => this.logger.warn({ err: e }, "Failed to send daily summary"));
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
      const generalDir = join(getAgendHome(), "general");
      mkdirSync(generalDir, { recursive: true });
      const backendName = fleet.defaults.backend ?? "claude-code";
      ensureGeneralInstructions(generalDir, backendName, this.logger);
      const generalConfig: InstanceConfig = {
        ...DEFAULT_INSTANCE_CONFIG,
        working_directory: generalDir,
        general_topic: true,
      };
      fleet.instances["general"] = generalConfig;
      this.saveFleetConfig();
    }

    if (topicMode && fleet.channel) {
      const schedulerConfig: SchedulerConfig = {
        ...DEFAULT_SCHEDULER_CONFIG,
        ...this.fleetConfig?.defaults.scheduler,
      };

      this.scheduler = new Scheduler(
        join(this.dataDir, "scheduler.db"),
        (schedule) => this.handleScheduleTrigger(schedule),
        schedulerConfig,
        (name) => this.fleetConfig?.instances?.[name] != null,
        this.logger,
      );
      this.scheduler.init();
      this.logger.info("Scheduler initialized");

      // Inject active decisions as env var for MCP instructions.
      // Snapshotted at startup — new decisions via post_decision are available
      // through list_decisions tool but not auto-injected until restart.
      try {
        const decisions = this.scheduler.db.listDecisions("", { includeArchived: false });
        if (decisions.length > 0) {
          const capped = decisions.slice(0, 20).map(d => ({ title: d.title, content: (d.content ?? "").slice(0, 200) }));
          process.env.AGEND_DECISIONS = JSON.stringify(capped);
          this.logger.info({ count: decisions.length, injected: capped.length }, "Injected active decisions into env");
        }
      } catch (err) {
        this.logger.debug({ err }, "Decision injection skipped (no decisions db or query failed)");
      }
    }

    await this.startInstancesWithConcurrency(Object.entries(fleet.instances), topicMode);

    if (topicMode && fleet.channel) {

      await this.startSharedAdapter(fleet);

      // Auto-create topics AFTER adapter is ready (needs adapter.createTopic)
      await this.topicCommands.autoCreateTopics();
      const routeSummary = this.routing.rebuild(this.fleetConfig!);
      this.logger.info(`Routes: ${routeSummary}`);

      // Resolve topic icon emoji IDs and start idle archive poller
      await this.resolveTopicIcons();
      this.topicArchiver.startPoller();

      // IPC is already wired by startInstancesWithConcurrency → startInstance →
      // connectIpcToInstance. The previous 3s sleep + connectToInstances loop
      // was redundant.

      for (const name of Object.keys(fleet.instances)) {
        this.startStatuslineWatcher(name);
      }

      // Notify General topic that fleet is up
      const total = Object.keys(fleet.instances).length;
      const started = this.daemons.size;
      const failedNames = Object.keys(fleet.instances).filter(n => !this.daemons.has(n));
      const generalName = this.findGeneralInstance();
      const generalThreadId = generalName ? fleet.instances[generalName]?.topic_id : undefined;
      if (this.adapter && fleet.channel?.group_id) {
        const text = failedNames.length === 0
          ? `Fleet ready. ${started}/${total} instances running.`
          : `Fleet ready. ${started}/${total} instances running. Failed: ${failedNames.join(", ")}`;
        this.adapter.sendText(String(fleet.channel.group_id), text, {
          threadId: generalThreadId != null ? String(generalThreadId) : undefined,
        }).catch(e => this.logger.warn({ err: e }, "Failed to send fleet start notification"));
      }
    }

    // Health HTTP endpoint
    {
      const port = fleet.health_port ?? 19280;
      const hs = startHealthServer(this, port);
      this.healthServer = hs.server;
      this.webToken = hs.webToken;
      this.startedAt = hs.startedAt;
    }

    // SIGHUP: hot-reload instance config (add/remove/restart instances)
    const onSighup = () => {
      this.logger.info("Received SIGHUP, hot-reloading config...");
      this.reconcileInstances()
        .catch(err => this.logger.error({ err }, "SIGHUP config reload failed"));
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

    // SIGUSR1: full process reload (graceful stop → exit → CLI restarts)
    const onFullRestart = () => {
      this.logger.info("Received SIGUSR1, initiating full restart (process reload)...");
      this.gracefulShutdownForReload()
        .then(() => {
          this.logger.info("Full restart: shutdown complete, exiting for reload");
          process.exit(0);
        })
        .catch(err => {
          this.logger.error({ err }, "Full restart: graceful shutdown failed");
          process.exit(1);
        });
    };
    process.once("SIGUSR1", onFullRestart);
  }

  /** Start the shared channel adapter for topic mode */
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

    this.adapter.on("message", safeHandler(async (msg: InboundMessage) => {
      await this.handleInboundMessage(msg);
    }, this.logger, "adapter.message"));

    this.adapter.on("callback_query", safeHandler(async (data: { callbackData: string; chatId: string; threadId?: string; messageId: string }) => {
      if (data.callbackData.startsWith("hang:")) {
        const parts = data.callbackData.split(":");
        const action = parts[1];
        const instanceName = parts[2];
        if (action === "restart") {
          await this.stopInstance(instanceName);
          const config = this.fleetConfig?.instances[instanceName];
          if (config) {
            const topicMode = this.fleetConfig?.channel?.mode === "topic";
            await this.startInstance(instanceName, config, topicMode);
            // startInstance already calls connectIpcToInstance
          }
          this.adapter?.editMessage(data.chatId, data.messageId, `🔄 ${instanceName} restarted.`).catch(() => {});
        } else {
          this.adapter?.editMessage(data.chatId, data.messageId, `⏳ Continuing to wait for ${instanceName}.`).catch(() => {});
        }
        return;
      }
    }, this.logger, "adapter.callback_query"));

    this.adapter.on("topic_closed", safeHandler(async (data: { chatId: string; threadId: string }) => {
      // Skip unbind if we archived this topic ourselves
      if (this.topicArchiver.isArchived(data.threadId)) return;
      await this.topicCommands.handleTopicDeleted(data.threadId);
    }, this.logger, "adapter.topic_closed"));

    await this.topicCommands.registerBotCommands();
    await this.adapter.start();
    if (fleet.channel?.group_id) {
      this.adapter.setChatId(String(fleet.channel.group_id));
    }

    this.adapter.on("started", safeHandler((username: string) => {
      this.logger.info(`Bot @${username} polling started. Ensure no other service is polling this bot token.`);
    }, this.logger, "adapter.started"));
    this.adapter.on("polling_conflict", safeHandler(({ attempt, delay }: { attempt: number; delay: number }) => {
      this.logger.warn(`409 Conflict (attempt ${attempt}), retry in ${delay / 1000}s`);
    }, this.logger, "adapter.polling_conflict"));
    this.adapter.on("handler_error", safeHandler((err: unknown) => {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Adapter handler error");
    }, this.logger, "adapter.handler_error"));

    this.startTopicCleanupPoller();

    // Prune stale external sessions every 5 minutes
    this.sessionPruneTimer = setInterval(() => {
      this.pruneStaleExternalSessions().catch(err =>
        this.logger.debug({ err }, "Session prune failed"));
    }, 5 * 60 * 1000);
  }

  /** Connect IPC to a single instance with all handlers */
  async connectIpcToInstance(name: string): Promise<void> {
    // Close existing client to prevent socket leak on reconnect
    const existing = this.instanceIpcClients.get(name);
    if (existing) {
      try { existing.close(); } catch (err) { this.logger.debug({ err, name }, "IPC client close failed (likely already closed)"); }
      this.instanceIpcClients.delete(name);
    }

    const sockPath = join(this.getInstanceDir(name), "channel.sock");
    if (!existsSync(sockPath)) return;

    const ipc = new IpcClient(sockPath);
    try {
      await ipc.connect();
      this.instanceIpcClients.set(name, ipc);
      ipc.on("message", safeHandler(async (msg: Record<string, unknown>) => {
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
          await this.handleOutboundFromInstance(name, msg);
        } else if (msg.type === "fleet_tool_status") {
          this.handleToolStatusFromInstance(name, msg);
        } else if (msg.type === "fleet_schedule_create" || msg.type === "fleet_schedule_list" ||
                   msg.type === "fleet_schedule_update" || msg.type === "fleet_schedule_delete") {
          rpcHandlers.handleScheduleCrud(this, name, msg);
        } else if (msg.type === "fleet_decision_create" || msg.type === "fleet_decision_list" ||
                   msg.type === "fleet_decision_update") {
          rpcHandlers.handleDecisionCrud(this, name, msg);
        } else if (msg.type === "fleet_task") {
          rpcHandlers.handleTaskCrud(this, name, msg);
        } else if (msg.type === "fleet_set_display_name") {
          rpcHandlers.handleSetDisplayName(this, name, msg);
        } else if (msg.type === "fleet_set_description") {
          rpcHandlers.handleSetDescription(this, name, msg);
        }
      }, this.logger, `ipc.message[${name}]`));
      // Ask daemon for any sessions that registered before we connected
      // (fixes race condition where mcp_ready was broadcast before fleet manager connected)
      ipc.send({ type: "query_sessions" });
      this.logger.debug({ name }, "Connected to instance IPC");
      if (!this.statuslineWatcher.has(name)) {
        this.statuslineWatcher.watch(name);
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
    const threadId = msg.threadId || undefined;
    if (threadId == null) {
      // General topic: check for /status command
      if (await this.topicCommands.handleGeneralCommand(msg)) return;

      // Forward to General Topic instance if configured
      const generalInstance = this.findGeneralInstance();
      if (generalInstance) {
        this.warnIfRateLimited(generalInstance, msg);
        const { text, extraMeta } = await processAttachments(msg, this.adapter!, this.logger, generalInstance, this.fleetConfig?.stt);
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
              source: msg.source,
              ...(msg.replyToText ? { reply_to_text: msg.replyToText } : {}),
              ...extraMeta,
            },
          });
          this.lastInboundUser.set(generalInstance, msg.username);
          this.logger.info(`${msg.username} → ${generalInstance}: ${(text ?? "").slice(0, 100)}`);
          this.eventLog?.logActivity("message", msg.username, (text ?? "").slice(0, 200), generalInstance);
          this.emitSseEvent("message", {
            instance: generalInstance, sender: msg.username,
            text: (text ?? "").slice(0, 2000), ts: new Date().toISOString(),
          });
        }
      }
      return;
    }

    const target = this.routing.resolve(threadId);
    if (!target) {
      this.topicCommands.handleUnboundTopic(msg);
      return;
    }
    const instanceName = target.name;

    // Reopen archived topic before routing
    if (this.topicArchiver.isArchived(threadId)) {
      await this.topicArchiver.reopen(threadId, instanceName);
    }

    this.touchActivity(instanceName);
    this.setTopicIcon(instanceName, "blue");

    this.warnIfRateLimited(instanceName, msg);

    const { text, extraMeta } = await processAttachments(msg, this.adapter!, this.logger, instanceName, this.fleetConfig?.stt);

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
      targetSession: instanceName, // Channel messages → instance's own session
      meta: {
        chat_id: msg.chatId,
        message_id: msg.messageId,
        user: msg.username,
        user_id: msg.userId,
        ts: msg.timestamp.toISOString(),
        thread_id: msg.threadId ?? "",
        source: msg.source,
        ...(msg.replyToText ? { reply_to_text: msg.replyToText } : {}),
        ...extraMeta,
      },
    });
    this.lastInboundUser.set(instanceName, msg.username);
    this.logger.info(`${msg.username} → ${instanceName}: ${(text ?? "").slice(0, 100)}`);
    this.eventLog?.logActivity("message", msg.username, (text ?? "").slice(0, 200), instanceName);
    this.emitSseEvent("message", {
      instance: instanceName, sender: msg.username,
      text: (text ?? "").slice(0, 2000), ts: new Date().toISOString(),
    });
  }

  /** Handle outbound tool calls from a daemon instance */
  /** Warn (but don't block) when rate limits are high. 30-min debounce per instance. */
  private rateLimitWarnedAt = new Map<string, number>();
  private warnIfRateLimited(instanceName: string, msg: InboundMessage): void {
    const rl = this.statuslineWatcher.getRateLimits(instanceName);
    if (!rl) return;
    let warning = "";
    if (rl.five_hour_pct >= 95) {
      warning = `⚠️ ${instanceName} at ${Math.round(rl.five_hour_pct)}% of 5h rate limit. Responses may be slower.`;
    } else if (rl.seven_day_pct >= 95) {
      warning = `⚠️ ${instanceName} at ${Math.round(rl.seven_day_pct)}% weekly usage. Responses may be slower or fail.`;
    }
    if (!warning) return;
    const lastWarn = this.rateLimitWarnedAt.get(instanceName) ?? 0;
    if (Date.now() - lastWarn < 30 * 60_000) return;
    this.rateLimitWarnedAt.set(instanceName, Date.now());
    if (this.adapter && msg.chatId) {
      this.adapter.sendText(msg.chatId, warning, { threadId: msg.threadId ?? undefined }).catch(() => {});
    }
  }

  /** Handle outbound tool calls from a daemon instance */
  private async handleOutboundFromInstance(instanceName: string, msg: Record<string, unknown>): Promise<void> {
    if (!this.adapter) return;
    this.touchActivity(instanceName);
    this.setTopicIcon(instanceName, "green");
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

    // Resolve threadId: use sender's topic_id if sender is a known fleet instance,
    // fall back to general topic if sender is unknown, or IPC owner if no sender.
    const senderInstanceName = senderSessionName && this.fleetConfig?.instances[senderSessionName]
      ? senderSessionName
      : null;
    const routingConfig = senderInstanceName
      ? this.fleetConfig?.instances[senderInstanceName]
      : (senderSessionName ? undefined : this.fleetConfig?.instances[instanceName]);
    const threadId = resolveReplyThreadId(args.thread_id, routingConfig);

    // Route standard channel tools (reply, react, edit_message, download_attachment)
    if (routeToolCall(this.adapter, tool, args, threadId, respond)) {
      if (tool === "reply") {
        const replyTo = this.lastInboundUser.get(instanceName) ?? "user";
        this.logger.info(`${instanceName} → ${replyTo}: ${(args.text as string ?? "").slice(0, 100)}`);
        this.emitSseEvent("message", {
          instance: instanceName, sender: senderSessionName ?? instanceName,
          text: (args.text as string ?? "").slice(0, 2000),
          ts: new Date().toISOString(),
        });
      }
      return;
    }

    // Log tool calls for activity visualization
    const senderLabel = senderSessionName ?? instanceName;
    this.eventLog?.logActivity("tool_call", senderLabel, summarizeToolCall(tool, args));

    // Dispatch fleet-specific tools via handler map
    const handler = outboundHandlers.get(tool);
    if (handler) {
      await handler(this, args, respond, { instanceName, requestId, fleetRequestId, senderSessionName });
    } else {
      respond(null, `Unknown tool: ${tool}`);
    }
  }

  /** Handle tool status update from a daemon instance */
  private handleToolStatusFromInstance(instanceName: string, msg: Record<string, unknown>): void {
    if (!this.adapter) return;

    const text = msg.text as string;
    const editMessageId = msg.editMessageId as string | null;
    const senderSessionName = msg.senderSessionName as string | undefined;
    const senderInstanceName = senderSessionName && this.fleetConfig?.instances[senderSessionName]
      ? senderSessionName
      : null;
    const routingConfig = senderInstanceName
      ? this.fleetConfig?.instances[senderInstanceName]
      : (senderSessionName ? undefined : this.fleetConfig?.instances[instanceName]);
    const threadId = routingConfig?.topic_id ? String(routingConfig.topic_id) : undefined;
    const chatId = this.adapter.getChatId();
    if (!chatId) return;

    if (editMessageId) {
      this.adapter.editMessage(chatId, editMessageId, text).catch(e => this.logger.debug({ err: e }, "Failed to edit tool status message"));
    } else {
      this.adapter.sendText(chatId, text, { threadId }).then((sent) => {
        const ipc = this.instanceIpcClients.get(instanceName);
        ipc?.send({ type: "fleet_tool_status_ack", messageId: sent.messageId });
      }).catch(e => this.logger.warn({ err: e }, "Failed to send tool status message"));
    }
  }

  // ===================== Scheduler =====================

  private async handleScheduleTrigger(schedule: Schedule): Promise<void> {
    const { target, reply_chat_id, reply_thread_id, message, label, id, source } = schedule;

    const RATE_LIMIT_DEFER_THRESHOLD = 85;
    const rl = this.statuslineWatcher.getRateLimits(target);
    if (rl && rl.five_hour_pct > RATE_LIMIT_DEFER_THRESHOLD) {
      this.scheduler!.recordRun(id, "deferred", `5hr rate limit at ${rl.five_hour_pct}%`);
      this.eventLog?.insert(target, "schedule_deferred", {
        schedule_id: id,
        label,
        five_hour_pct: rl.five_hour_pct,
      });
      this.webhookEmitter?.emit("schedule_deferred", target, { schedule_id: id, label, five_hour_pct: rl.five_hour_pct });
      this.notifyInstanceTopic(target, `⏳ Schedule "${label ?? id}" deferred — rate limit at ${rl.five_hour_pct}%`);
      this.logger.info({ target, scheduleId: id, rateLimitPct: rl.five_hour_pct }, "Schedule deferred due to rate limit");
      return;
    }

    const schedulerDefaults = this.fleetConfig?.defaults.scheduler;

    const retryCount = schedulerDefaults?.retry_count ?? 3;
    const retryInterval = schedulerDefaults?.retry_interval_ms ?? 30_000;

    const deliver = (): boolean => {
      const ipc = this.instanceIpcClients.get(target);
      if (!ipc?.connected) return false;

      ipc.send({
        type: "fleet_schedule_trigger",
        payload: { schedule_id: id, message: `[Scheduled] ${message}`, label },
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
    const text = `⏰ Schedule "${schedule.label ?? schedule.id}" triggered, target: ${schedule.target}`;
    this.adapter.sendText(schedule.reply_chat_id, text, {
      threadId: schedule.reply_thread_id ?? undefined,
    }).catch((err: unknown) => this.logger.error({ err }, "Failed to send cross-instance notification"));
  }

  private notifyScheduleFailure(schedule: Schedule): void {
    if (!this.adapter) return;
    const text = `⏰ Schedule "${schedule.label ?? schedule.id}" trigger failed: instance ${schedule.target} is offline.`;
    this.adapter.sendText(schedule.reply_chat_id, text, {
      threadId: schedule.reply_thread_id ?? undefined,
    }).catch((err: unknown) => this.logger.error({ err }, "Failed to send schedule failure notification"));
  }

  // ── Fleet RPC handlers ────────────────────────────────────────────────
  // Implementations live in fleet-rpc-handlers.ts; these forwarders preserve
  // the signatures required by AgentEndpointContext + WebApiContext.

  resolveDisplayName(instanceName: string): string {
    return rpcResolveDisplayName(this, instanceName);
  }

  async handleScheduleCrudHttp(instance: string, op: string, args: Record<string, unknown>): Promise<unknown> {
    return rpcHandlers.handleScheduleCrudHttp(this, instance, op, args);
  }

  async handleDecisionCrudHttp(instance: string, op: string, args: Record<string, unknown>): Promise<unknown> {
    return rpcHandlers.handleDecisionCrudHttp(this, instance, op, args);
  }

  async handleTaskCrudHttp(instance: string, args: Record<string, unknown>): Promise<unknown> {
    return rpcHandlers.handleTaskCrudHttp(this, instance, args);
  }

  async handleSetDisplayNameHttp(instance: string, name: string): Promise<unknown> {
    return rpcHandlers.handleSetDisplayNameHttp(this, instance, name);
  }

  async handleSetDescriptionHttp(instance: string, description: string): Promise<unknown> {
    return rpcHandlers.handleSetDescriptionHttp(this, instance, description);
  }


  // ===================== Topic management =====================

  /** Create a forum topic via the adapter. Returns the message_thread_id. */
  async createForumTopic(topicName: string): Promise<number | string> {
    if (!this.adapter?.createTopic) {
      throw new Error("Adapter does not support topic creation");
    }
    return this.adapter.createTopic(topicName);
  }

  async deleteForumTopic(topicId: number | string): Promise<void> {
    try {
      if (!this.adapter?.deleteTopic) return;
      await this.adapter.deleteTopic(topicId);
    } catch (err) {
      this.logger.warn({ err, topicId }, "Failed to delete forum topic during rollback");
    }
  }

  private topicCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private sessionPruneTimer: ReturnType<typeof setInterval> | null = null;

  /** Periodically check if bound topics still exist */
  private startTopicCleanupPoller(): void {
    this.topicCleanupTimer = setInterval(async () => {
      if (!this.fleetConfig?.channel?.group_id || !this.adapter?.topicExists) return;

      for (const [threadId, target] of this.routing.entries()) {
        try {
          if (!isProbeableRouteTarget(target)) {
            continue;
          }
          const exists = await this.adapter.topicExists(threadId);
          if (!exists) {
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
    if (this.fleetConfig.health_port) toSave.health_port = this.fleetConfig.health_port;
    if (Object.keys(this.fleetConfig.defaults).length > 0) toSave.defaults = this.fleetConfig.defaults;
    if (this.fleetConfig.teams && Object.keys(this.fleetConfig.teams).length > 0) {
      toSave.teams = this.fleetConfig.teams;
    }
    if (this.fleetConfig.templates && Object.keys(this.fleetConfig.templates).length > 0) {
      toSave.templates = this.fleetConfig.templates;
    }
    if (this.fleetConfig.profiles && Object.keys(this.fleetConfig.profiles).length > 0) {
      toSave.profiles = this.fleetConfig.profiles;
    }
    toSave.instances = {};
    for (const [name, inst] of Object.entries(this.fleetConfig.instances)) {
      const serialized: Record<string, unknown> = {
        working_directory: inst.working_directory,
        topic_id: inst.topic_id,
      };
      // Preserve all optional user-configured fields so saveFleetConfig() never silently drops them
      if (inst.general_topic) serialized.general_topic = true;
      if (inst.description) serialized.description = inst.description;
      if (inst.tags?.length) serialized.tags = inst.tags;
      if (inst.model) serialized.model = inst.model;
      if (inst.model_failover?.length) serialized.model_failover = inst.model_failover;
      if (inst.worktree_source) serialized.worktree_source = inst.worktree_source;
      if (inst.backend) serialized.backend = inst.backend;
      if (inst.systemPrompt) serialized.systemPrompt = inst.systemPrompt;
      if (inst.skipPermissions) serialized.skipPermissions = inst.skipPermissions;
      if (inst.lightweight) serialized.lightweight = inst.lightweight;
      if (inst.cost_guard) serialized.cost_guard = inst.cost_guard;
      if (inst.workflow !== undefined) serialized.workflow = inst.workflow;
      if (inst.agent_mode) serialized.agent_mode = inst.agent_mode;
      (toSave.instances as Record<string, unknown>)[name] = serialized;
    }
    writeFileSync(this.configPath, yaml.dump(toSave, { lineWidth: 120 }));
    this.logger.info({ path: this.configPath }, "Saved fleet config");
  }

  async removeInstance(name: string): Promise<void> {
    // Clean up schedules (scheduler is fleet-level, not lifecycle-level)
    const config = this.fleetConfig?.instances[name];
    if (this.scheduler && config?.topic_id) {
      const count = this.scheduler.deleteByInstanceOrThread(name, String(config.topic_id));
      if (count > 0) {
        this.logger.info({ name, count }, "Cleaned up schedules for deleted instance");
      }
    }
    // Clean up team memberships
    if (this.fleetConfig?.teams) {
      for (const [teamName, team] of Object.entries(this.fleetConfig.teams)) {
        const idx = team.members.indexOf(name);
        if (idx !== -1) {
          team.members.splice(idx, 1);
          this.logger.info({ team: teamName, instance: name }, "Removed deleted instance from team");
        }
        if (team.members.length === 0) {
          delete this.fleetConfig.teams[teamName];
          this.logger.info({ team: teamName }, "Deleted empty team");
        }
      }
    }

    await this.lifecycle.remove(name);

    // Clean up per-instance tracking maps so they don't grow unbounded
    // as instances are created and deleted over the lifetime of the fleet.
    this.lastActivity.delete(name);
    this.lastInboundUser.delete(name);
    this.rateLimitWarnedAt.delete(name);

    // Clean up statusline watcher + instance directory
    this.statuslineWatcher.unwatch(name);
    try {
      rmSync(this.getInstanceDir(name), { recursive: true, force: true });
    } catch (err) {
      this.logger.debug({ err, name }, "Instance dir cleanup failed");
    }
  }

  startStatuslineWatcher(name: string): void {
    this.statuslineWatcher.watch(name);
  }

  // ── Model failover ──────────────────────────────────────────────────────

  private static FAILOVER_TRIGGER_PCT = 90;
  private static FAILOVER_RECOVER_PCT = 50;

  checkModelFailover(name: string, fiveHourPct: number): void {
    const config = this.fleetConfig?.instances[name];
    if (!config?.model_failover?.length) return;

    const daemon = this.daemons.get(name);
    if (!daemon) return;

    const failoverList = config.model_failover;
    const primaryModel = failoverList[0];
    const currentFailover = this.failoverActive.get(name);

    if (fiveHourPct >= FleetManager.FAILOVER_TRIGGER_PCT && !currentFailover) {
      // Trigger failover: pick next model in list
      const fallbackModel = failoverList.length > 1 ? failoverList[1] : undefined;
      if (!fallbackModel) return;

      this.failoverActive.set(name, fallbackModel);
      daemon.setModelOverride(fallbackModel);
      this.logger.info({ instance: name, from: primaryModel, to: fallbackModel, ratePct: fiveHourPct },
        "Model failover triggered");
      this.eventLog?.insert(name, "model_failover", {
        from: primaryModel, to: fallbackModel, five_hour_pct: fiveHourPct,
      });
      this.webhookEmitter?.emit("model_failover", name, { from: primaryModel, to: fallbackModel, five_hour_pct: fiveHourPct });
      this.notifyInstanceTopic(name,
        `⚡ Rate limit ${fiveHourPct}% — next rotation will use ${fallbackModel} (was ${primaryModel})`);

    } else if (fiveHourPct < FleetManager.FAILOVER_RECOVER_PCT && currentFailover) {
      // Recover: switch back to primary
      this.failoverActive.delete(name);
      daemon.setModelOverride(undefined);
      this.logger.info({ instance: name, restored: primaryModel, ratePct: fiveHourPct },
        "Model failover recovered");
      this.eventLog?.insert(name, "model_recovered", {
        restored: primaryModel, five_hour_pct: fiveHourPct,
      });
      this.webhookEmitter?.emit("model_recovered", name, { restored: primaryModel, five_hour_pct: fiveHourPct });
      this.notifyInstanceTopic(name,
        `✅ Rate limit recovered (${fiveHourPct}%) — next rotation will use ${primaryModel}`);
    }
  }

  notifyInstanceTopic(instanceName: string, text: string): void {
    if (!this.adapter) return;
    const groupId = this.fleetConfig?.channel?.group_id;
    if (!groupId) return;
    const threadId = this.fleetConfig?.instances[instanceName]?.topic_id;
    this.adapter.sendText(String(groupId), text, {
      threadId: threadId != null ? String(threadId) : undefined,
    }).catch(e => this.logger.warn({ err: e, instanceName }, "Failed to send instance topic notification"));
  }

  queueMirrorMessage(text: string): void {
    const mirrorTopicId = this.fleetConfig?.channel?.mirror_topic_id;
    if (mirrorTopicId == null || !this.adapter) return;
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
    this.mirrorBuffer.push(`[${ts}] ${text}`);
    if (!this.mirrorTimer) {
      this.mirrorTimer = setTimeout(() => {
        const batch = this.mirrorBuffer.join("\n");
        this.mirrorBuffer = [];
        this.mirrorTimer = null;
        const groupId = this.fleetConfig?.channel?.group_id;
        if (groupId && this.adapter) {
          this.adapter.sendText(String(groupId), batch, {
            threadId: String(mirrorTopicId),
          }).catch(e => this.logger.debug({ err: e }, "Mirror topic send failed"));
        }
      }, 3000);
    }
  }

  /** Push an SSE event to all connected Web UI clients. */
  emitSseEvent(event: string, data: unknown): void {
    broadcastSseEvent(this.sseClients, event, data, (err) =>
      this.logger.debug({ err }, "SSE client write failed; evicting"),
    );
  }

  listClaimedTasks(assignee: string): Array<{ id: string; title: string }> {
    try {
      return this.scheduler?.db.listTasks({ assignee, status: "claimed" }) ?? [];
    } catch { return []; }
  }

  async sendHangNotification(instanceName: string): Promise<void> {
    if (!this.adapter) return;
    const groupId = this.fleetConfig?.channel?.group_id;
    if (!groupId) return;
    const threadId = this.fleetConfig?.instances[instanceName]?.topic_id;

    this.setTopicIcon(instanceName, "red");

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
    }).catch(e => this.logger.warn({ err: e }, "Failed to send hang notification"));
  }

  // ── Topic icon + auto-archive ─────────────────────────────────────────────


  /** Fetch forum topic icon stickers and pick emoji IDs for each state */
  private async resolveTopicIcons(): Promise<void> {
    if (!this.adapter?.getTopicIconStickers) return;
    try {
      const stickers = await this.adapter.getTopicIconStickers();
      if (stickers.length === 0) return;

      // getForumTopicIconStickers returns a fixed set of available icons.
      // Try to match by emoji character, fall back to positional.
      const find = (targets: string[]) =>
        stickers.find((s) => targets.some((t) => s.emoji.includes(t)));

      const green = find(["🟢", "✅", "💚"]);
      const blue = find(["🔵", "💙", "📘"]);
      const red = find(["🔴", "❌", "💔"]);

      this.topicIcons = {
        green: green?.customEmojiId ?? stickers[0]?.customEmojiId,
        blue: blue?.customEmojiId ?? stickers[1]?.customEmojiId ?? stickers[0]?.customEmojiId,
        red: red?.customEmojiId ?? stickers[Math.min(5, stickers.length - 1)]?.customEmojiId,
      };
      this.logger.info({ icons: this.topicIcons }, "Resolved topic icon emoji IDs");
    } catch (err) {
      this.logger.debug({ err }, "Failed to resolve topic icons (non-fatal)");
    }
  }

  /** Set topic icon based on instance state */
  setTopicIcon(instanceName: string, state: "green" | "blue" | "red" | "remove"): void {
    const topicId = this.fleetConfig?.instances[instanceName]?.topic_id;
    if (topicId == null || !this.adapter?.editForumTopic) return;

    const emojiId = state === "remove" ? "" : this.topicIcons[state];
    if (emojiId == null && state !== "remove") return; // no icon resolved

    this.adapter.editForumTopic(topicId, { iconCustomEmojiId: emojiId })
      .catch((e) => this.logger.debug({ err: e, instanceName, state }, "Topic icon update failed"));
  }

  /** Track activity timestamp for idle detection */
  touchActivity(instanceName: string): void {
    this.lastActivity.set(instanceName, Date.now());
  }

  /** Start periodic idle archive checker */
  // archiveIdleTopics / reopenArchivedTopic → delegated to TopicArchiver

  private clearStatuslineWatchers(): void {
    this.statuslineWatcher.stopAll();
    this.failoverActive.clear();
  }

  async stopAll(): Promise<void> {
    this.clearStatuslineWatchers();
    this.costGuard?.stop();
    this.dailySummary?.stop();

    if (this.topicCleanupTimer) {
      clearInterval(this.topicCleanupTimer);
      this.topicCleanupTimer = null;
    }
    if (this.sessionPruneTimer) {
      clearInterval(this.sessionPruneTimer);
      this.sessionPruneTimer = null;
    }
    if (this.mirrorTimer) {
      clearTimeout(this.mirrorTimer);
      this.mirrorTimer = null;
      this.mirrorBuffer = [];
    }
    this.topicArchiver.stop();

    this.scheduler?.shutdown();

    // Stop instances sequentially to avoid tmux send-keys race conditions.
    // Each stop sends quit + Enter via separate tmux commands; parallel stops
    // can cause the Enter to arrive before the quit text is processed.
    for (const [name, daemon] of this.daemons) {
      try {
        await daemon.stop();
      } catch (err) {
        this.logger.warn({ name, err }, "Stop failed");
      }
      this.daemons.delete(name);
    }

    for (const [, ipc] of this.instanceIpcClients) {
      await ipc.close();
    }
    this.instanceIpcClients.clear();

    if (this.adapter) {
      await this.adapter.stop();
      this.adapter = null;
    }

    this.controlClient?.stop();
    this.controlClient = null;

    if (this.healthServer) {
      this.healthServer.close();
      this.healthServer = null;
    }

    this.eventLog?.close();

    const pidPath = join(this.dataDir, "fleet.pid");
    try { unlinkSync(pidPath); } catch (e) { this.logger.debug({ err: e }, "Failed to remove fleet PID file"); }
  }

  /**
   * Prune stale external sessions by re-querying each daemon for live sessions.
   * Sessions in the registry that are no longer reported by any daemon are removed.
   */
  async pruneStaleExternalSessions(): Promise<number> {
    const liveSessions = new Set<string>();

    // Ask each daemon for its currently connected external sessions
    const queries = [...this.instanceIpcClients.entries()].map(([_name, ipc]) => {
      if (!ipc.connected) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          ipc.removeListener("message", handler);
          resolve();
        };
        const handler = (msg: Record<string, unknown>) => {
          if (msg.type !== "query_sessions_response") return;
          for (const s of msg.sessions as string[]) liveSessions.add(s);
          finish();
        };
        const timeout = setTimeout(finish, 5000);
        ipc.on("message", handler);
        ipc.send({ type: "query_sessions" });
      });
    });

    await Promise.all(queries);

    // Remove sessions not found in any daemon
    let pruned = 0;
    for (const [sessionName] of this.sessionRegistry) {
      if (!liveSessions.has(sessionName)) {
        this.sessionRegistry.delete(sessionName);
        this.logger.info({ sessionName }, "Pruned stale external session");
        pruned++;
      }
    }
    if (pruned > 0) {
      this.logger.info({ pruned, remaining: this.sessionRegistry.size }, "Session registry pruned");
    }
    return pruned;
  }

  /**
   * Graceful shutdown for full reload: wait for idle, notify, then stop everything.
   * The caller is expected to exit the process after this resolves.
   */
  async gracefulShutdownForReload(): Promise<void> {
    const instanceNames = [...this.daemons.keys()];
    if (instanceNames.length === 0) {
      this.logger.info("No instances to stop");
      await this.stopAll();
      return;
    }

    this.logger.info(`Full restart: waiting for ${instanceNames.length} instances to idle...`);

    const groupId = this.fleetConfig?.channel?.group_id;
    if (groupId && this.adapter) {
      await this.adapter.sendText(String(groupId), `🔄 Full restart initiated — waiting for all instances to idle, then reloading process...`)
        .catch(e => this.logger.warn({ err: e }, "Failed to post full restart notification"));
    }

    // Wait for idle with 5-minute timeout
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
      this.logger.warn({ err }, "Idle wait timed out — force stopping");
    } finally {
      clearTimeout(timeoutHandle!);
    }

    this.logger.info("All instances idle — stopping for reload...");
    await this.stopAll();

    // Clean up tmux session if no foreign windows remain
    try {
      const remaining = await TmuxManager.listWindows(getTmuxSession());
      if (remaining.length <= 1) {
        await TmuxManager.killSession(getTmuxSession());
        this.logger.info("Killed tmux session (clean)");
      } else {
        this.logger.warn({ remaining: remaining.map(w => w.name) }, "Windows remain after stopAll — skipping session kill");
      }
    } catch (err) {
      this.logger.debug({ err }, "Exit tmux session cleanup failed (best effort)");
    }
  }

  /**
   * Graceful restart: wait for all instances to be idle, then stop and start them.
   */
  /**
   * Hot-reload: re-read fleet.yaml and reconcile running instances.
   * Starts new, stops removed, restarts modified instances.
   * Fleet-level config (access, cost_guard, etc.) requires /restart to take effect.
   */
  private async reconcileInstances(): Promise<void> {
    if (!this.configPath) return;
    const oldConfig = this.fleetConfig;
    this.loadConfig(this.configPath);
    this.routing.rebuild(this.fleetConfig!);
    this.scheduler?.reload();

    const newInstances = this.fleetConfig!.instances;
    const topicMode = this.fleetConfig?.channel?.mode === "topic";

    // Detect fleet-level config changes and warn
    const oldFleetLevel = JSON.stringify({ channel: oldConfig?.channel, defaults: oldConfig?.defaults });
    const newFleetLevel = JSON.stringify({ channel: this.fleetConfig?.channel, defaults: this.fleetConfig?.defaults });
    if (oldFleetLevel !== newFleetLevel) {
      this.logger.warn("Fleet-level config changed (channel/defaults) — use /restart for full effect");
    }

    // Stop removed instances
    for (const name of this.daemons.keys()) {
      if (!(name in newInstances)) {
        this.logger.info({ name }, "Instance removed from config — stopping");
        await this.stopInstance(name).catch(err =>
          this.logger.error({ err, name }, "Failed to stop removed instance"));
      }
    }

    // Start new + restart modified instances
    for (const [name, config] of Object.entries(newInstances)) {
      if (!this.daemons.has(name)) {
        // New instance — startInstance already calls connectIpcToInstance
        this.logger.info({ name }, "New instance in config — starting");
        await this.startInstance(name, config, topicMode).catch(err =>
          this.logger.error({ err, name }, "Failed to start new instance"));
      } else if (oldConfig?.instances[name]) {
        // Restart if any config field changed
        if (JSON.stringify(oldConfig.instances[name]) !== JSON.stringify(config)) {
          this.logger.info({ name }, "Instance config changed — restarting");
          await this.stopInstance(name).catch(() => {});
          await this.startInstance(name, config, topicMode).catch(err =>
            this.logger.error({ err, name }, "Failed to restart modified instance"));
        }
      }
    }

    this.logger.info({ running: this.daemons.size, configured: Object.keys(newInstances).length }, "Reconcile complete");
  }

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
    const generalName = this.findGeneralInstance();
    const generalThreadId = generalName ? this.fleetConfig?.instances[generalName]?.topic_id : undefined;
    const notifyOpts = { threadId: generalThreadId != null ? String(generalThreadId) : undefined };
    if (groupId && this.adapter) {
      await this.adapter.sendText(String(groupId), `🔄 Graceful restart initiated — waiting for all instances to idle...`, notifyOpts)
        .catch(e => this.logger.warn({ err: e }, "Failed to post restart notification"));
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

    // Kill remaining orphan windows to prevent stale state on restart
    try {
      const agendNames = new Set(instanceNames);
      agendNames.add("general");
      const existingWindows = await TmuxManager.listWindows(getTmuxSession());
      for (const w of existingWindows) {
        if (agendNames.has(w.name)) {
          const tm = new TmuxManager(getTmuxSession(), w.id);
          await tm.killWindow();
        }
      }
    } catch (err) {
      this.logger.debug({ err }, "Restart tmux window cleanup failed (best effort)");
    }

    const fleet = this.loadConfig(this.configPath);
    this.fleetConfig = fleet;
    const topicMode = fleet.channel?.mode === "topic";

    await this.startInstancesWithConcurrency(Object.entries(fleet.instances), topicMode);

    if (topicMode) {
      this.routing.rebuild(this.fleetConfig!);
      // startInstance already calls connectIpcToInstance, no need for connectToInstances here

      for (const name of Object.keys(fleet.instances)) {
        this.startStatuslineWatcher(name);
      }
    }

    this.logger.info("Graceful restart complete");
    if (groupId && this.adapter) {
      const total = Object.keys(fleet.instances).length;
      const started = this.daemons.size;
      const failedNames = Object.keys(fleet.instances).filter(n => !this.daemons.has(n));
      const restartText = failedNames.length === 0
        ? `Fleet ready. ${started}/${total} instances running.`
        : `Fleet ready. ${started}/${total} instances running. Failed: ${failedNames.join(", ")}`;
      await this.adapter.sendText(String(groupId), restartText, notifyOpts)
        .catch(e => this.logger.warn({ err: e }, "Failed to post restart completion notification"));

      // Notify each instance's channel — tailor message based on session state
      const instances = Object.entries(this.fleetConfig?.instances ?? {});
      this.logger.info({ count: instances.length }, "Sending restart notification to instances");
      for (const [name, config] of instances) {
        const threadId = config.topic_id != null ? String(config.topic_id) : undefined;
        const daemon = this.daemons.get(name);
        const isNewSession = daemon?.isNewSession ?? false;
        const msg = isNewSession
          ? "Fleet restart complete. Configuration changed — starting fresh session."
          : "Fleet restart complete. Continue from where you left off.";

        // Send to topic so the message appears in the instance's channel
        if (threadId) {
          this.adapter.sendText(String(groupId), msg, { threadId })
            .catch(e => this.logger.warn({ err: e, name, threadId }, "Failed to post per-instance restart notification"));
        }

        // Push to daemon IPC so the CLI session receives the message
        const ipc = this.instanceIpcClients.get(name);
        if (ipc?.connected) {
          ipc.send({
            type: "fleet_inbound",
            content: msg,
            meta: {
              chat_id: String(groupId),
              thread_id: threadId ?? "",
              ts: new Date().toISOString(),
            },
          });
        }
      }
    }
  }

  getUiStatus(): unknown {
    return healthGetUiStatus(this, this.startedAt);
  }

}

