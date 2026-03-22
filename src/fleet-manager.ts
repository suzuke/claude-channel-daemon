import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const BASE_PORT = 18321;
const TMUX_SESSION = "ccd";

export class FleetManager {
  private children: Map<string, ChildProcess> = new Map();
  private daemons: Map<string, InstanceType<typeof import("./daemon.js").Daemon>> = new Map();
  private fleetConfig: FleetConfig | null = null;
  private adapter: ChannelAdapter | null = null;
  private routingTable: Map<number, string> = new Map();
  private instanceIpcClients: Map<string, IpcClient> = new Map();
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

  /** Allocate approval ports — use explicit port if set, otherwise auto-increment */
  allocatePorts(instances: Record<string, Partial<InstanceConfig>>): Record<string, number> {
    const ports: Record<string, number> = {};
    let auto = BASE_PORT;
    for (const [name, config] of Object.entries(instances)) {
      ports[name] = config.approval_port ?? auto++;
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
        this.logger.info({ threadId }, "Unbound topic — no instance for this threadId");
        // Could reply "topic not bound" here
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

    await this.adapter.start();
    this.logger.info("Shared Telegram adapter started");
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

    switch (tool) {
      case "reply":
        this.adapter.sendText(chatId, args.text as string ?? "", {
          threadId: args.thread_id as string,
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

  async stopAll(): Promise<void> {
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
