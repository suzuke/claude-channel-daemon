import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { FleetConfig, InstanceConfig } from "./types.js";
import { loadFleetConfig } from "./config.js";
import { TmuxManager } from "./tmux-manager.js";
import { TelegramAdapter } from "./channel/adapters/telegram.js";
import { AccessManager } from "./channel/access-manager.js";
import { IpcClient } from "./channel/ipc-bridge.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import { createLogger } from "./logger.js";

const BASE_PORT = 18400; // Start above 18321 to avoid conflict with official telegram plugin
const TMUX_SESSION = "ccd";

export class FleetManager {
  private children: Map<string, ChildProcess> = new Map();
  private daemons: Map<string, InstanceType<typeof import("./daemon.js").Daemon>> = new Map();
  private fleetConfig: FleetConfig | null = null;
  private adapter: ChannelAdapter | null = null;
  private routingTable: Map<number, string> = new Map();
  private instanceIpcClients: Map<string, IpcClient> = new Map();
  private pendingBindings: Map<number, string> = new Map(); // threadId → browsing state
  private configPath: string = "";
  private logger = createLogger("info");

  constructor(private dataDir: string) {}

  /** Load fleet.yaml and build routing table */
  loadConfig(configPath: string): FleetConfig {
    this.fleetConfig = loadFleetConfig(configPath);
    return this.fleetConfig;
  }

  /** Build topic routing table: { topicId -> instanceName } */
  buildRoutingTable(): Map<number, string> {
    const table = new Map<number, string>();
    if (!this.fleetConfig) return table;
    for (const [name, inst] of Object.entries(this.fleetConfig.instances)) {
      if (inst.topic_id != null) {
        table.set(inst.topic_id, name);
      }
    }
    return table;
  }

  /** Allocate approval ports — use explicit port if set, otherwise auto-increment (skip collisions) */
  allocatePorts(instances: Record<string, Partial<InstanceConfig>>): Record<string, number> {
    const ports: Record<string, number> = {};
    // First pass: collect explicit ports
    const usedPorts = new Set<number>();
    for (const config of Object.values(instances)) {
      if (config.approval_port) usedPorts.add(config.approval_port);
    }
    // Second pass: assign
    let auto = BASE_PORT;
    for (const [name, config] of Object.entries(instances)) {
      if (config.approval_port) {
        ports[name] = config.approval_port;
      } else {
        while (usedPorts.has(auto)) auto++;
        ports[name] = auto;
        usedPorts.add(auto);
        auto++;
      }
    }
    return ports;
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

  async startInstance(name: string, config: InstanceConfig, port: number, topicMode: boolean): Promise<void> {
    // Guard: already running
    if (this.daemons.has(name)) {
      this.logger.info({ name }, "Instance already running, skipping");
      return;
    }

    const instanceDir = this.getInstanceDir(name);
    mkdirSync(instanceDir, { recursive: true });

    config.approval_port = port;

    // Import Daemon dynamically to avoid circular deps
    const { Daemon } = await import("./daemon.js");
    const daemon = new Daemon(name, config, instanceDir, topicMode);
    await daemon.start();
    this.daemons.set(name, daemon);
  }

  async stopInstance(name: string): Promise<void> {
    const daemon = this.daemons.get(name);
    if (daemon) {
      await daemon.stop();
      this.daemons.delete(name);
      return;
    }
    // Try PID file fallback
    const pidPath = join(this.getInstanceDir(name), "daemon.pid");
    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }

  /** Start all instances from fleet config */
  async startAll(configPath: string): Promise<void> {
    this.configPath = configPath;
    const fleet = this.loadConfig(configPath);
    const topicMode = fleet.channel?.mode === "topic";
    const ports = this.allocatePorts(fleet.instances);

    // Ensure tmux session exists
    await TmuxManager.ensureSession(TMUX_SESSION);

    // Start all daemon instances
    for (const [name, config] of Object.entries(fleet.instances)) {
      await this.startInstance(name, config, ports[name], topicMode && !config.channel);
    }

    // Topic mode: start shared adapter + routing
    if (topicMode && fleet.channel) {
      this.routingTable = this.buildRoutingTable();
      this.logger.info({ routes: Object.fromEntries(this.routingTable) }, "Topic routing table");

      await this.startSharedAdapter(fleet);

      // Wait for daemon IPC servers to be ready, then connect
      await new Promise(r => setTimeout(r, 3000));
      await this.connectToInstances(fleet);
    }
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

    // Route inbound messages by threadId
    this.adapter.on("message", (msg: InboundMessage) => {
      const threadId = msg.threadId ? parseInt(msg.threadId, 10) : undefined;
      if (threadId == null) {
        this.logger.warn({ chatId: msg.chatId }, "Message without threadId — ignoring in topic mode");
        return;
      }

      const instanceName = this.routingTable.get(threadId);
      if (!instanceName) {
        // Check if auto-bind is already in progress for this topic
        if (this.pendingBindings.has(threadId)) return;
        // Auto-bind: show directory browser
        this.handleUnboundTopic(msg, threadId);
        return;
      }

      // Forward to instance via IPC
      const ipc = this.instanceIpcClients.get(instanceName);
      if (!ipc) {
        this.logger.warn({ instanceName }, "No IPC connection to instance");
        return;
      }

      ipc.send({
        type: "fleet_inbound",
        content: msg.text,
        meta: {
          chat_id: msg.chatId,
          message_id: msg.messageId,
          user: msg.username,
          user_id: msg.userId,
          ts: msg.timestamp.toISOString(),
          thread_id: msg.threadId ?? "",
        },
      });
      this.logger.info({ instanceName, user: msg.username, text: msg.text.slice(0, 80) }, "Routed to instance");
    });

    // Handle callback queries (directory browser selections)
    this.adapter.on("callback_query", (data: { callbackData: string; chatId: string; threadId?: string; messageId: string }) => {
      this.handleDirectorySelection(data);
    });

    // Handle topic deletion (auto-unbind)
    this.adapter.on("topic_closed", (data: { chatId: string; threadId: string }) => {
      this.handleTopicDeleted(parseInt(data.threadId, 10));
    });

    await this.adapter.start();
    this.logger.info("Shared Telegram adapter started");

    // Periodically check for deleted topics (Telegram may not always send events)
    this.startTopicCleanupPoller();
  }

  /** Connect IPC clients to each daemon instance's channel.sock */
  private async connectToInstances(fleet: FleetConfig): Promise<void> {
    for (const name of Object.keys(fleet.instances)) {
      const sockPath = join(this.getInstanceDir(name), "channel.sock");
      if (!existsSync(sockPath)) {
        this.logger.warn({ name, sockPath }, "Instance IPC socket not found");
        continue;
      }

      const ipc = new IpcClient(sockPath);
      try {
        await ipc.connect();
        this.instanceIpcClients.set(name, ipc);

        // Handle outbound tool calls from daemon → route to shared adapter
        ipc.on("message", (msg: Record<string, unknown>) => {
          if (msg.type === "fleet_outbound") {
            this.handleOutboundFromInstance(name, msg);
          }
        });

        this.logger.info({ name }, "Connected to instance IPC");
      } catch (err) {
        this.logger.warn({ name, err }, "Failed to connect to instance IPC");
      }
    }
  }

  /** Handle outbound tool calls from a daemon instance */
  private handleOutboundFromInstance(instanceName: string, msg: Record<string, unknown>): void {
    if (!this.adapter) return;
    const tool = msg.tool as string;
    const args = (msg.args ?? {}) as Record<string, unknown>;
    const requestId = msg.requestId as number;

    const chatId = args.chat_id as string ?? "";
    const respond = (result: unknown, error?: string) => {
      const ipc = this.instanceIpcClients.get(instanceName);
      ipc?.send({ type: "fleet_outbound_response", requestId, result, error });
    };

    // Resolve threadId from instance → topic_id mapping
    const instanceConfig = this.fleetConfig?.instances[instanceName];
    const threadId = args.thread_id as string ?? (instanceConfig?.topic_id ? String(instanceConfig.topic_id) : undefined);

    switch (tool) {
      case "reply":
        this.adapter.sendText(chatId, args.text as string ?? "", {
          threadId,
          replyTo: args.reply_to as string,
        }).then(sent => respond(sent))
          .catch(e => respond(null, e.message));
        break;
      case "react":
        this.adapter.react(chatId, args.message_id as string ?? "", args.emoji as string ?? "")
          .then(() => respond("ok"))
          .catch(e => respond(null, e.message));
        break;
      case "edit_message":
        this.adapter.editMessage(chatId, args.message_id as string ?? "", args.text as string ?? "")
          .then(() => respond("ok"))
          .catch(e => respond(null, e.message));
        break;
      case "download_attachment":
        this.adapter.downloadAttachment(args.file_id as string ?? "")
          .then(path => respond(path))
          .catch(e => respond(null, e.message));
        break;
      default:
        respond(null, `Unknown tool: ${tool}`);
    }
  }

  // ===================== Auto-bind =====================

  /** Show directory browser when message arrives in unbound topic */
  private async handleUnboundTopic(msg: InboundMessage, threadId: number): Promise<void> {
    if (!this.adapter) return;
    this.pendingBindings.set(threadId, "browsing");

    // List directories in common locations
    const dirs = this.listProjectDirectories();
    if (dirs.length === 0) {
      await this.adapter.sendText(msg.chatId, "No project directories found. Add instances to fleet.yaml manually.", {
        threadId: String(threadId),
      });
      return;
    }

    // Build inline keyboard with directory options
    const { InlineKeyboard } = await import("grammy");
    const keyboard = new InlineKeyboard();
    for (const dir of dirs.slice(0, 8)) { // Max 8 options
      const label = basename(dir);
      keyboard.text(label, `bind:${threadId}:${dir}`).row();
    }
    keyboard.text("❌ Cancel", `bind:${threadId}:cancel`).row();

    await this.adapter.sendText(
      msg.chatId,
      `📂 This topic is not bound to any project.\nSelect a working directory:`,
      { threadId: String(threadId) },
    );
    // Send keyboard as a separate message (adapter.sendText doesn't support inline keyboard directly)
    // Use the bot API directly via the adapter
    const tgAdapter = this.adapter as TelegramAdapter;
    await tgAdapter.sendTextWithKeyboard(
      msg.chatId,
      "Choose a project directory:",
      keyboard,
      String(threadId),
    );
  }

  /** Handle directory selection from inline keyboard */
  private async handleDirectorySelection(data: { callbackData: string; chatId: string; threadId?: string; messageId: string }): Promise<void> {
    const { callbackData, chatId } = data;
    if (!callbackData.startsWith("bind:")) return;

    const parts = callbackData.split(":");
    const threadId = parseInt(parts[1], 10);
    const dirPath = parts.slice(2).join(":");

    if (dirPath === "cancel") {
      this.pendingBindings.delete(threadId);
      await this.adapter?.editMessage(chatId, data.messageId, "Binding cancelled.");
      return;
    }

    // Guard: already bound
    if (this.routingTable.has(threadId)) {
      this.pendingBindings.delete(threadId);
      await this.adapter?.editMessage(chatId, data.messageId, "Already bound.");
      return;
    }

    // Create instance name from directory name
    const instanceName = basename(dirPath).toLowerCase().replace(/[^a-z0-9-]/g, "-");

    this.logger.info({ instanceName, threadId, dirPath }, "Auto-binding topic to project");

    // Update fleet config
    if (this.fleetConfig) {
      this.fleetConfig.instances[instanceName] = {
        working_directory: dirPath,
        topic_id: threadId,
        restart_policy: this.fleetConfig.defaults.restart_policy ?? { max_retries: 10, backoff: "exponential", reset_after: 300 },
        context_guardian: this.fleetConfig.defaults.context_guardian ?? { threshold_percentage: 80, max_age_hours: 4, strategy: "hybrid" },
        memory: this.fleetConfig.defaults.memory ?? { auto_summarize: false, watch_memory_dir: true, backup_to_sqlite: true },
        log_level: (this.fleetConfig.defaults.log_level as "info") ?? "info",
      };

      // Save to fleet.yaml
      this.saveFleetConfig();

      // Update routing table
      this.routingTable.set(threadId, instanceName);

      // Start the new instance
      const ports = this.allocatePorts(this.fleetConfig.instances);
      await this.startInstance(instanceName, this.fleetConfig.instances[instanceName], ports[instanceName], true);

      // Wait for IPC ready then connect
      await new Promise(r => setTimeout(r, 5000));
      const sockPath = join(this.getInstanceDir(instanceName), "channel.sock");
      if (existsSync(sockPath)) {
        const ipc = new IpcClient(sockPath);
        try {
          await ipc.connect();
          this.instanceIpcClients.set(instanceName, ipc);
          ipc.on("message", (ipcMsg: Record<string, unknown>) => {
            if (ipcMsg.type === "fleet_outbound") {
              this.handleOutboundFromInstance(instanceName, ipcMsg);
            }
          });
        } catch {}
      }

      this.pendingBindings.delete(threadId);
      await this.adapter?.editMessage(chatId, data.messageId,
        `✅ Bound to: ${dirPath}\nInstance: ${instanceName}`);
      this.logger.info({ instanceName, threadId }, "Topic auto-bound successfully");
    }
  }

  // ===================== Auto-unbind =====================

  /** Handle topic deletion — stop daemon and remove from config */
  private async handleTopicDeleted(threadId: number): Promise<void> {
    const instanceName = this.routingTable.get(threadId);
    if (!instanceName) return;

    this.logger.info({ instanceName, threadId }, "Topic deleted — auto-unbinding");

    // Stop the daemon
    await this.stopInstance(instanceName);

    // Remove from routing table
    this.routingTable.delete(threadId);

    // Remove from fleet config
    if (this.fleetConfig) {
      delete this.fleetConfig.instances[instanceName];
      this.saveFleetConfig();
    }

    // Close IPC connection
    const ipc = this.instanceIpcClients.get(instanceName);
    if (ipc) {
      await ipc.close();
      this.instanceIpcClients.delete(instanceName);
    }
  }

  // ===================== Helpers =====================

  /** List project directories from common locations */
  private listProjectDirectories(): string[] {
    const dirs: string[] = [];
    const searchPaths = [
      join(homedir(), "Documents"),
      join(homedir(), "Projects"),
      join(homedir(), "Documents/Hack"),
      join(homedir(), "src"),
      join(homedir(), "work"),
    ];

    for (const searchPath of searchPaths) {
      if (!existsSync(searchPath)) continue;
      try {
        const entries = readdirSync(searchPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            const fullPath = join(searchPath, entry.name);
            // Check if it looks like a project (has .git, package.json, etc.)
            if (
              existsSync(join(fullPath, ".git")) ||
              existsSync(join(fullPath, "package.json")) ||
              existsSync(join(fullPath, "Cargo.toml")) ||
              existsSync(join(fullPath, "go.mod")) ||
              existsSync(join(fullPath, "pyproject.toml"))
            ) {
              dirs.push(fullPath);
            }
          }
        }
      } catch {}
    }
    return dirs;
  }

  /** Save fleet config back to fleet.yaml */
  private saveFleetConfig(): void {
    if (!this.fleetConfig || !this.configPath) return;
    const toSave: Record<string, unknown> = {};
    if (this.fleetConfig.channel) toSave.channel = this.fleetConfig.channel;
    if (Object.keys(this.fleetConfig.defaults).length > 0) toSave.defaults = this.fleetConfig.defaults;
    toSave.instances = {};
    for (const [name, inst] of Object.entries(this.fleetConfig.instances)) {
      (toSave.instances as Record<string, unknown>)[name] = {
        working_directory: inst.working_directory,
        topic_id: inst.topic_id,
        ...(inst.approval_port ? { approval_port: inst.approval_port } : {}),
      };
    }
    writeFileSync(this.configPath, yaml.dump(toSave, { lineWidth: 120 }));
    this.logger.info({ path: this.configPath }, "Saved fleet config");
  }

  private topicCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Periodically check if bound topics still exist */
  private startTopicCleanupPoller(): void {
    this.topicCleanupTimer = setInterval(async () => {
      if (!this.fleetConfig?.channel?.group_id) return;
      const tgAdapter = this.adapter as TelegramAdapter;
      const groupId = this.fleetConfig.channel.group_id;

      for (const [threadId, instanceName] of this.routingTable) {
        try {
          // Try to get the topic info by sending a dummy request
          // If topic is deleted, Telegram returns 400 "Bad Request: message thread not found"
          // We use getForumTopicIconStickers as a lightweight check — but it doesn't work per-topic
          // Instead, try sending a chat action to the thread
          const bot = tgAdapter.getBot();
          await bot.api.sendChatAction(groupId, "typing", {
            message_thread_id: threadId,
          });
        } catch (err: unknown) {
          const errMsg = String(err);
          if (errMsg.includes("thread not found") || errMsg.includes("TOPIC_DELETED") || errMsg.includes("TOPIC_CLOSED")) {
            this.logger.info({ threadId, instanceName }, "Topic deleted — auto-unbinding");
            await this.handleTopicDeleted(threadId);
          }
        }
      }
    }, 60_000); // Check every 60 seconds
  }

  async stopAll(): Promise<void> {
    if (this.topicCleanupTimer) {
      clearInterval(this.topicCleanupTimer);
      this.topicCleanupTimer = null;
    }
    // Stop adapter
    if (this.adapter) {
      await this.adapter.stop();
      this.adapter = null;
    }
    // Close IPC connections
    for (const [, ipc] of this.instanceIpcClients) {
      await ipc.close();
    }
    this.instanceIpcClients.clear();
    // Stop daemon instances
    await Promise.allSettled(
      [...this.daemons.keys()].map(name => this.stopInstance(name))
    );
  }
}
