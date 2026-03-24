import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { FleetConfig, InstanceConfig } from "./types.js";
import { loadFleetConfig, DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { TmuxManager } from "./tmux-manager.js";
import { TelegramAdapter } from "./channel/adapters/telegram.js";
import { AccessManager } from "./channel/access-manager.js";
import { IpcClient } from "./channel/ipc-bridge.js";
import type { ChannelAdapter, InboundMessage } from "./channel/types.js";
import { createLogger } from "./logger.js";
import { transcribe } from "./stt.js";
import { Scheduler } from "./scheduler/index.js";
import type { Schedule, SchedulerConfig } from "./scheduler/index.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./scheduler/index.js";
import { ContainerManager } from "./container-manager.js";

const BASE_PORT = 18400; // Start above 18321 to avoid conflict with official telegram plugin
const TMUX_SESSION = "ccd";

/** Sanitize a directory name into a valid instance name. Keeps Unicode letters (incl. CJK). */
function sanitizeInstanceName(name: string): string {
  // Keep Unicode letters (\p{L}), digits, and hyphens; replace everything else with hyphen
  const sanitized = name.toLowerCase().replace(/[^\p{L}\d-]/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "project";
}

export class FleetManager {
  private children: Map<string, ChildProcess> = new Map();
  private daemons: Map<string, InstanceType<typeof import("./daemon.js").Daemon>> = new Map();
  private fleetConfig: FleetConfig | null = null;
  private adapter: ChannelAdapter | null = null;
  private routingTable: Map<number, string> = new Map();
  private instanceIpcClients: Map<string, IpcClient> = new Map();
  private openSessions: Map<string, { paths: string[]; createdAt: number }> = new Map();
  private scheduler: Scheduler | null = null;
  private containerManager: ContainerManager | null = null;
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
    const { createBackend } = await import("./backend/factory.js");
    const { HookBasedApproval } = await import("./backend/hook-based-approval.js");
    const { MessageBus } = await import("./channel/message-bus.js");

    const backendName = config.backend ?? this.fleetConfig?.defaults?.backend ?? "claude-code";
    const backend = createBackend(backendName, instanceDir);
    const approval = new HookBasedApproval({
      messageBus: new MessageBus(),
      port,
      topicMode,
      instanceName: name,
      ipcServer: null,
    });
    const daemon = new Daemon(name, config, instanceDir, topicMode, this.containerManager ?? undefined, backend, approval);
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
      try { process.kill(pid, "SIGTERM"); } catch (e) { this.logger.debug({ err: e, pid }, "SIGTERM failed for stale process"); }
    }
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
    const ports = this.allocatePorts(fleet.instances);

    if (fleet.sandbox?.enabled) {
      this.containerManager = new ContainerManager();
      const ccdInstallDir = join(__dirname, "..");
      await this.containerManager.ensureRunning({
        projectRoots: fleet.project_roots ?? [],
        dataDir: this.dataDir,
        ccdInstallDir,
        extraMounts: fleet.sandbox.extra_mounts ?? [],
      });
      this.logger.info("Sandbox container running");
    }

    // Ensure tmux session exists
    await TmuxManager.ensureSession(TMUX_SESSION);

    // Write PID file so external tools can signal this process
    const pidPath = join(this.dataDir, "fleet.pid");
    writeFileSync(pidPath, String(process.pid), "utf-8");

    // Start all daemon instances
    for (const [name, config] of Object.entries(fleet.instances)) {
      await this.startInstance(name, config, ports[name], topicMode && !config.channel);
    }

    // Topic mode: auto-create topics for instances without topic_id, then start adapter
    if (topicMode && fleet.channel) {
      await this.autoCreateTopics(fleet);
      this.routingTable = this.buildRoutingTable();
      const routeSummary = [...this.routingTable.entries()].map(([tid, name]) => `#${tid}→${name}`).join(", ");
      this.logger.info(`Routes: ${routeSummary}`);

      // Initialize scheduler
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

      // Wait for daemon IPC servers to be ready, then connect
      await new Promise(r => setTimeout(r, 3000));
      await this.connectToInstances(fleet);
    }

    // SIGHUP: reload scheduler
    process.on("SIGHUP", () => {
      this.logger.info("Received SIGHUP, reloading scheduler...");
      this.scheduler?.reload();
    });
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
      this.handleInboundMessage(msg);
    });

    // Handle callback queries (directory browser selections)
    this.adapter.on("callback_query", (data: { callbackData: string; chatId: string; threadId?: string; messageId: string }) => {
      this.handleCallbackQuery(data);
    });

    // Handle topic deletion (auto-unbind)
    this.adapter.on("topic_closed", (data: { chatId: string; threadId: string }) => {
      this.handleTopicDeleted(parseInt(data.threadId, 10));
    });

    await this.registerBotCommands();
    await this.adapter.start();
    // Set the group chatId for approval messages
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

    // Periodically check for deleted topics (Telegram may not always send events)
    this.startTopicCleanupPoller();
  }

  /** Register /open and /new in Telegram command menu */
  private async registerBotCommands(): Promise<void> {
    const groupId = this.fleetConfig?.channel?.group_id;
    const botTokenEnv = this.fleetConfig?.channel?.bot_token_env;
    if (!groupId || !botTokenEnv) return;
    const botToken = process.env[botTokenEnv];
    if (!botToken) return;

    try {
      await fetch(
        `https://api.telegram.org/bot${botToken}/setMyCommands`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commands: [
              { command: "open", description: "Open an existing project" },
              { command: "new", description: "Create a new project" },
            ],
            scope: { type: "chat", chat_id: groupId },
          }),
        },
      );
      this.logger.info("Registered bot commands: /open, /new");
    } catch (err) {
      this.logger.warn({ err }, "Failed to register bot commands (non-fatal)");
    }
  }

  /** Connect IPC clients to each daemon instance's channel.sock */
  private async connectToInstances(fleet: FleetConfig): Promise<void> {
    for (const name of Object.keys(fleet.instances)) {
      await this.connectIpcToInstance(name);
    }
  }

  /** Connect IPC to a single instance with all handlers */
  private async connectIpcToInstance(name: string): Promise<void> {
    const sockPath = join(this.getInstanceDir(name), "channel.sock");
    if (!existsSync(sockPath)) return;

    const ipc = new IpcClient(sockPath);
    try {
      await ipc.connect();
      this.instanceIpcClients.set(name, ipc);
      ipc.on("message", (msg: Record<string, unknown>) => {
        if (msg.type === "fleet_outbound") {
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
      this.logger.debug({ name }, "Connected to instance IPC");
    } catch (err) {
      this.logger.warn({ name, err }, "Failed to connect to instance IPC");
    }
  }


  /** Parse and dispatch commands from the General topic */
  private async handleGeneralCommand(msg: InboundMessage): Promise<void> {
    const text = msg.text?.trim();
    if (!text) return;

    if (text === "/open" || text === "/open@" || text.startsWith("/open ") || text.startsWith("/open@")) {
      // Extract keyword: remove /open or /open@botname, take the rest
      const keyword = text.replace(/^\/open(@\S+)?\s*/, "").trim();
      await this.handleOpenCommand(msg, keyword || undefined);
      return;
    }

    if (text === "/new" || text === "/new@" || text.startsWith("/new ") || text.startsWith("/new@")) {
      const name = text.replace(/^\/new(@\S+)?\s*/, "").trim();
      await this.handleNewCommand(msg, name || undefined);
      return;
    }

    // Not a command — ignore silently
  }

  /** Handle /open command — list or search unbound directories */
  private async handleOpenCommand(msg: InboundMessage, keyword?: string): Promise<void> {
    if (!this.adapter || !this.fleetConfig) return;

    const roots = this.getProjectRoots();
    if (roots.length === 0 || (roots.length === 1 && roots[0] === homedir())) {
      await this.adapter.sendText(msg.chatId, "No project roots configured. Run `ccd init` to set up.");
      return;
    }

    const dirs = this.listUnboundDirectories();

    if (keyword) {
      const result = this.filterDirectories(dirs, keyword);
      if (result.type === "none") {
        await this.adapter.sendText(msg.chatId, `No projects found matching "${keyword}".`);
        return;
      }
      if (result.type === "exact") {
        await this.openBindProject(msg.chatId, result.path);
        return;
      }
      // Multiple matches — show keyboard
      await this.sendOpenKeyboard(msg.chatId, result.paths, 0);
      return;
    }

    // No keyword — show full list
    if (dirs.length === 0) {
      await this.adapter.sendText(msg.chatId, "All projects are already bound to topics.");
      return;
    }
    await this.sendOpenKeyboard(msg.chatId, dirs, 0);
  }

  /** Send paginated inline keyboard for /open */
  private async sendOpenKeyboard(chatId: string, dirs: string[], page: number): Promise<void> {
    const sessionId = Math.random().toString(16).slice(2, 10); // 8 hex chars
    this.openSessions.set(sessionId, { paths: dirs, createdAt: Date.now() });

    // TTL cleanup: remove sessions older than 5 minutes
    const OPEN_SESSION_TTL = 5 * 60 * 1000;
    for (const [id, session] of this.openSessions) {
      if (Date.now() - session.createdAt > OPEN_SESSION_TTL) this.openSessions.delete(id);
    }

    const PAGE_SIZE = 5;
    const pageStart = page * PAGE_SIZE;
    const pageDirs = dirs.slice(pageStart, pageStart + PAGE_SIZE);

    const { InlineKeyboard } = await import("grammy");
    const keyboard = new InlineKeyboard();

    for (let i = 0; i < pageDirs.length; i++) {
      const idx = pageStart + i;
      keyboard.text(`📁 ${basename(pageDirs[i])}`, `cmd_open:${sessionId}:${idx}`).row();
    }

    // Pagination
    const hasMore = pageStart + PAGE_SIZE < dirs.length;
    if (page > 0 || hasMore) {
      if (page > 0) keyboard.text("⬅️ Prev", `cmd_open:${sessionId}:page:${page - 1}`);
      if (hasMore) keyboard.text("➡️ Next", `cmd_open:${sessionId}:page:${page + 1}`);
      keyboard.row();
    }

    keyboard.text("❌ Cancel", `cmd_open:${sessionId}:cancel`).row();

    const headerText = page === 0
      ? "📂 Select a project:"
      : `📂 Projects (page ${page + 1}):`;

    const tgAdapter = this.adapter as TelegramAdapter;
    // Intentionally no threadId — keyboard is sent to the General topic
    await tgAdapter.sendTextWithKeyboard(chatId, headerText, keyboard);
  }

  /** Create topic and bind a project directory (triggered by /open exact match or keyboard selection) */
  private async openBindProject(chatId: string, dirPath: string): Promise<void> {
    if (!this.adapter || !this.fleetConfig) return;

    let topicId: number | undefined;
    try {
      const topicName = basename(dirPath);
      topicId = await this.createForumTopic(topicName);
      const instanceName = await this.bindAndStart(dirPath, topicId);

      const tgAdapter = this.adapter as TelegramAdapter;
      await tgAdapter.sendText(
        chatId,
        `✅ Bound to: ${dirPath}\nInstance: ${instanceName}`,
        { threadId: String(topicId) },
      );
    } catch (err) {
      // Rollback: remove partial instance config if bindAndStart failed after topic creation
      if (topicId != null) {
        const partialName = Object.entries(this.fleetConfig.instances)
          .find(([, cfg]) => cfg.topic_id === topicId)?.[0];
        if (partialName) {
          delete this.fleetConfig.instances[partialName];
          this.routingTable.delete(topicId);
          this.saveFleetConfig();
        }
      }
      await this.adapter.sendText(chatId, `❌ Failed to bind: ${(err as Error).message}`);
    }
  }

  /** Validate project name for /new command */
  private validateProjectName(name: string): boolean {
    if (!name || !name.trim()) return false;
    if (name.includes("/") || name.includes("..")) return false;
    if (name.startsWith("-")) return false;
    return true;
  }

  /** Handle /new command — create directory + git init + bind */
  private async handleNewCommand(msg: InboundMessage, name?: string): Promise<void> {
    if (!this.adapter || !this.fleetConfig) return;

    if (!name) {
      await this.adapter.sendText(msg.chatId, "Usage: /new <project-name>");
      return;
    }

    if (!this.validateProjectName(name)) {
      await this.adapter.sendText(msg.chatId, "Invalid project name. Avoid /, .., leading -, and whitespace-only names.");
      return;
    }

    const roots = this.getProjectRoots();
    if (roots.length === 0 || (roots.length === 1 && roots[0] === homedir())) {
      await this.adapter.sendText(msg.chatId, "No project roots configured. Run `ccd init` to set up.");
      return;
    }

    const projectDir = join(roots[0], name);
    if (existsSync(projectDir)) {
      await this.adapter.sendText(msg.chatId, `Directory "${name}" already exists. Use /open ${name} instead.`);
      return;
    }

    try {
      // Create directory + git init in parallel with createForumTopic
      const [topicId] = await Promise.all([
        this.createForumTopic(name),
        (async () => {
          mkdirSync(projectDir, { recursive: true });
          try {
            const { execFile } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const exec = promisify(execFile);
            await exec("git", ["init"], { cwd: projectDir });
          } catch (e) { this.logger.debug({ err: e }, "git init failed for new project directory"); }
        })(),
      ]);

      const instanceName = await this.bindAndStart(projectDir, topicId);

      const tgAdapter = this.adapter as TelegramAdapter;
      await tgAdapter.sendText(
        msg.chatId,
        `✅ Bound to: ${projectDir}\nInstance: ${instanceName}`,
        { threadId: String(topicId) },
      );
    } catch (err) {
      // Rollback: remove created directory
      try {
        if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
      } catch (e) { this.logger.debug({ err: e }, "Rollback cleanup failed for project directory"); }
      // Rollback: remove partial instance config
      if (this.fleetConfig) {
        const partialName = Object.entries(this.fleetConfig.instances)
          .find(([, cfg]) => cfg.working_directory === projectDir)?.[0];
        if (partialName) {
          const tid = this.fleetConfig.instances[partialName].topic_id;
          delete this.fleetConfig.instances[partialName];
          if (tid != null) this.routingTable.delete(tid);
          this.saveFleetConfig();
        }
      }
      await this.adapter.sendText(msg.chatId, `❌ Failed: ${(err as Error).message}`);
    }
  }

  /** Handle inbound message — transcribe voice if present, then route */
  private async handleInboundMessage(msg: InboundMessage): Promise<void> {
    const threadId = msg.threadId ? parseInt(msg.threadId, 10) : undefined;
    if (threadId == null) {
      await this.handleGeneralCommand(msg);
      return;
    }

    const instanceName = this.routingTable.get(threadId);
    if (!instanceName) {
      this.handleUnboundTopic(msg, threadId);
      return;
    }

    let text = msg.text;
    const extraMeta: Record<string, string> = {};
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
          this.logger.info({ instanceName, transcription: result.text.slice(0, 80) }, "Voice transcribed");
        } catch (err) {
          this.logger.warn({ err: (err as Error).message }, "Voice transcription failed");
          text = text || "[語音訊息 — 轉錄失敗]";
        }
      } else {
        this.logger.warn("GROQ_API_KEY not set, skipping voice transcription");
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

    const ipc = this.instanceIpcClients.get(instanceName);
    if (!ipc) {
      this.logger.warn({ instanceName }, "No IPC connection to instance");
      return;
    }

    ipc.send({
      type: "fleet_inbound",
      content: text,
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
      case "reply": {
        this.logger.info(`→ ${instanceName} claude: ${(args.text as string ?? "").slice(0, 100)}`);
        const files = Array.isArray(args.files) ? args.files as string[] : [];
        this.adapter.sendText(chatId, args.text as string ?? "", {
          threadId,
          replyTo: args.reply_to as string,
        }).then(async (sent) => {
          for (const filePath of files) {
            await this.adapter!.sendFile(chatId, filePath, { threadId });
          }
          respond(sent);
        }).catch(e => respond(null, e.message));
        break;
      }
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

  /** Handle approval request from a daemon instance — forward to shared adapter */
  private handleApprovalFromInstance(instanceName: string, msg: Record<string, unknown>): void {
    this.logger.debug({ instanceName, approvalId: msg.approvalId }, "Received approval request from instance");
    if (!this.adapter) {
      this.logger.warn({ instanceName }, "No adapter — denying approval");
      this.sendApprovalResponse(instanceName, msg.approvalId as string, "deny");
      return;
    }

    const prompt = `[${instanceName}] ${msg.prompt as string}`;
    const approvalId = msg.approvalId as string;
    const instanceConfig = this.fleetConfig?.instances[instanceName];
    const threadId = instanceConfig?.topic_id ? String(instanceConfig.topic_id) : undefined;
    this.logger.debug({ instanceName, threadId, approvalId }, "Sending approval to Telegram");

    this.adapter.sendApproval(prompt, (decision) => {
      this.logger.debug({ instanceName, approvalId, decision }, "Approval callback received");
      this.sendApprovalResponse(instanceName, approvalId, decision);
    }, undefined, threadId).catch((err) => {
      this.logger.warn({ instanceName, err: (err as Error).message }, "Failed to send approval to Telegram");
      this.sendApprovalResponse(instanceName, approvalId, "deny");
    });
  }

  private sendApprovalResponse(instanceName: string, approvalId: string, decision: "approve" | "always_allow" | "deny"): void {
    this.logger.debug({ instanceName, approvalId, decision }, "Sending approval response to daemon");
    const ipc = this.instanceIpcClients.get(instanceName);
    ipc?.send({ type: "fleet_approval_response", approvalId, decision });
  }

  /** Handle tool status update from a daemon instance — forward to Telegram */
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
        // Send the messageId back to the daemon so it can edit next time
        const ipc = this.instanceIpcClients.get(instanceName);
        ipc?.send({ type: "fleet_tool_status_ack", messageId: sent.messageId });
      }).catch(e => this.logger.debug({ err: e }, "Failed to send tool status message"));
    }
  }

  // ===================== Scheduler =====================

  private async handleScheduleTrigger(schedule: Schedule): Promise<void> {
    const { target, reply_chat_id, reply_thread_id, message, label, id, source } = schedule;
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
      if (source !== target) {
        this.notifySourceTopic(schedule);
      }
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

  // ===================== Auto-create topics =====================

  /** Create a Telegram Forum Topic. Returns the message_thread_id. */
  private async createForumTopic(topicName: string): Promise<number> {
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

  /** Create Telegram topics for instances that don't have topic_id */
  /**
   * Create Telegram topics for instances that don't have topic_id.
   * Note: With the /open and /new command flow, instances always get a topic_id
   * at creation time. This method is kept as a safety net for manually-added
   * instances in fleet.yaml. May be removed in the future.
   */
  private async autoCreateTopics(fleet: FleetConfig): Promise<void> {
    if (!fleet.channel?.group_id) return;
    const botToken = process.env[fleet.channel.bot_token_env];
    if (!botToken) return;

    let configChanged = false;
    for (const [name, config] of Object.entries(fleet.instances)) {
      if (config.topic_id != null) continue; // already has topic

      try {
        // Use Bot API directly (adapter may not be started yet)
        const topicName = basename(config.working_directory);
        const threadId = await this.createForumTopic(topicName);
        config.topic_id = threadId;
        configChanged = true;
        this.logger.info({ name, topicId: config.topic_id, topicName }, "Auto-created Telegram topic");
      } catch (err) {
        this.logger.warn({ name, err }, "Failed to auto-create topic");
      }
    }

    if (configChanged) {
      this.saveFleetConfig();
    }
  }

  // ===================== Auto-bind =====================

  /** Reply with redirect when message arrives in an unbound topic */
  private async handleUnboundTopic(msg: InboundMessage, _threadId: number): Promise<void> {
    if (!this.adapter) return;
    await this.adapter.sendText(
      msg.chatId,
      "Please use /open or /new in General to bind a project to a topic.",
      { threadId: msg.threadId },
    );
  }

  /** Dispatch callback queries by prefix */
  private async handleCallbackQuery(data: { callbackData: string; chatId: string; threadId?: string; messageId: string }): Promise<void> {
    const { callbackData, chatId, messageId } = data;

    if (callbackData.startsWith("cmd_open:")) {
      await this.handleOpenCallback(callbackData, chatId, messageId);
      return;
    }

    // Legacy prefixes from old directory browser — no longer handled
  }

  /** Handle callback from /open inline keyboard */
  private async handleOpenCallback(callbackData: string, chatId: string, messageId: string): Promise<void> {
    if (!this.adapter) return;

    // Format: cmd_open:<sessionId>:<action>
    const parts = callbackData.split(":");
    const sessionId = parts[1];

    // Validate session
    const session = this.openSessions.get(sessionId);
    if (!session) {
      await this.adapter.editMessage(chatId, messageId, "This menu has expired. Use /open again.");
      return;
    }

    const action = parts[2];

    // Cancel
    if (action === "cancel") {
      this.openSessions.delete(sessionId);
      await this.adapter.editMessage(chatId, messageId, "Cancelled.");
      return;
    }

    // Pagination: cmd_open:<sessionId>:page:<pageNum>
    if (action === "page") {
      const page = parseInt(parts[3], 10);
      await this.adapter.editMessage(chatId, messageId, "Loading...");
      await this.sendOpenKeyboard(chatId, session.paths, page);
      return;
    }

    // Directory selection: cmd_open:<sessionId>:<index>
    const index = parseInt(action, 10);
    if (isNaN(index) || index < 0 || index >= session.paths.length) {
      await this.adapter.editMessage(chatId, messageId, "Invalid selection.");
      return;
    }

    const dirPath = session.paths[index];
    this.openSessions.delete(sessionId);
    await this.adapter.editMessage(chatId, messageId, `Binding to ${basename(dirPath)}...`);
    await this.openBindProject(chatId, dirPath);
  }

  // ===================== Auto-unbind =====================

  /** Handle topic deletion — stop daemon and remove from config */
  private async handleTopicDeleted(threadId: number): Promise<void> {
    const instanceName = this.routingTable.get(threadId);
    if (!instanceName) return;

    this.logger.info({ instanceName, threadId }, "Topic deleted — auto-unbinding");

    // Clean up related schedules
    if (this.scheduler) {
      const count = this.scheduler.deleteByInstanceOrThread(instanceName, String(threadId));
      if (count > 0) {
        this.logger.info({ threadId, instanceName, count }, "Cleaned up schedules for deleted topic");
        const groupId = this.fleetConfig?.channel?.group_id;
        if (groupId && this.adapter) {
          this.adapter.sendText(String(groupId), `⚠️ Topic 已刪除，已清除 ${count} 條相關排程。`).catch(e => this.logger.debug({ err: e }, "Failed to send schedule cleanup notification"));
        }
      }
    }

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

  /**
   * Create instance config, save fleet.yaml, start daemon, connect IPC.
   * Returns the generated instance name.
   */
  private async bindAndStart(dirPath: string, topicId: number): Promise<string> {
    if (!this.fleetConfig) throw new Error("Fleet config not loaded");

    const instanceName = `${sanitizeInstanceName(basename(dirPath))}-t${topicId}`;

    this.fleetConfig.instances[instanceName] = {
      working_directory: dirPath,
      topic_id: topicId,
      restart_policy: this.fleetConfig.defaults.restart_policy ?? DEFAULT_INSTANCE_CONFIG.restart_policy,
      context_guardian: this.fleetConfig.defaults.context_guardian ?? DEFAULT_INSTANCE_CONFIG.context_guardian,
      memory: this.fleetConfig.defaults.memory ?? DEFAULT_INSTANCE_CONFIG.memory,
      log_level: this.fleetConfig.defaults.log_level ?? DEFAULT_INSTANCE_CONFIG.log_level,
    };

    this.saveFleetConfig();
    this.routingTable.set(topicId, instanceName);

    const ports = this.allocatePorts(this.fleetConfig.instances);
    await this.startInstance(instanceName, this.fleetConfig.instances[instanceName], ports[instanceName], true);

    await new Promise(r => setTimeout(r, 5000));
    await this.connectIpcToInstance(instanceName);

    this.logger.info({ instanceName, topicId }, "Topic bound and started");
    return instanceName;
  }

  /** Get configured project roots, with fallback */
  private getProjectRoots(): string[] {
    const roots = this.fleetConfig?.project_roots;
    if (roots && roots.length > 0) {
      return roots.map(r => r.startsWith("~") ? join(homedir(), r.slice(1)) : r)
        .filter(r => existsSync(r));
    }
    // Fallback: home directory
    return [homedir()];
  }

  /** List project directories from project_roots */
  private listProjectDirectories(): string[] {
    const dirs: string[] = [];
    for (const root of this.getProjectRoots()) {
      try {
        const entries = readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith(".")) {
            dirs.push(join(root, entry.name));
          }
        }
      } catch (e) { this.logger.debug({ err: e, root }, "Failed to read project root directory"); }
    }
    return dirs.sort((a, b) => basename(a).localeCompare(basename(b)));
  }

  /** List directories from project_roots that are not already bound to an instance */
  private listUnboundDirectories(): string[] {
    const boundDirs = new Set(
      Object.values(this.fleetConfig?.instances ?? {}).map(i => i.working_directory),
    );
    return this.listProjectDirectories().filter(d => !boundDirs.has(d));
  }

  /** Match directories by keyword. Exact basename match wins over substring. */
  private filterDirectories(
    dirs: string[],
    keyword: string,
  ): { type: "exact"; path: string } | { type: "multiple"; paths: string[] } | { type: "none" } {
    const kw = keyword.toLowerCase();

    // Check for exact basename match first
    const exactMatches = dirs.filter(d => basename(d).toLowerCase() === kw);
    if (exactMatches.length === 1) {
      return { type: "exact", path: exactMatches[0] };
    }

    // Fall back to substring match
    const subMatches = dirs.filter(d => basename(d).toLowerCase().includes(kw));
    if (subMatches.length === 0) return { type: "none" };
    if (subMatches.length === 1) return { type: "exact", path: subMatches[0] };
    return { type: "multiple", paths: subMatches };
  }

  /** Save fleet config back to fleet.yaml */
  private saveFleetConfig(): void {
    if (!this.fleetConfig || !this.configPath) return;
    const toSave: Record<string, unknown> = {};
    if (this.fleetConfig.project_roots) toSave.project_roots = this.fleetConfig.project_roots;
    if (this.fleetConfig.channel) toSave.channel = this.fleetConfig.channel;
    if (this.fleetConfig.sandbox) toSave.sandbox = this.fleetConfig.sandbox;
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

      const bot = tgAdapter.getBot();
      for (const [threadId, instanceName] of this.routingTable) {
        try {
          // sendMessage is the only reliable way to check if a topic still exists
          // sendChatAction and editForumTopic both return ok:true for deleted topics
          const msg = await bot.api.sendMessage(groupId, "\u200B", { // zero-width space — invisible probe
            message_thread_id: threadId,
          });
          // Topic exists — delete the probe message
          await bot.api.deleteMessage(groupId, msg.message_id).catch(e => this.logger.debug({ err: e }, "Failed to delete topic probe message"));
        } catch (err: unknown) {
          const errMsg = String(err);
          if (errMsg.includes("thread not found") || errMsg.includes("TOPIC_ID_INVALID")) {
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

    // 1. Shutdown scheduler first
    this.scheduler?.shutdown();

    // 2. Stop all daemon instances
    await Promise.allSettled(
      [...this.daemons.keys()].map(name => this.stopInstance(name))
    );

    // 3. Close IPC connections
    for (const [, ipc] of this.instanceIpcClients) {
      await ipc.close();
    }
    this.instanceIpcClients.clear();

    // 4. Stop adapter
    if (this.adapter) {
      await this.adapter.stop();
      this.adapter = null;
    }

    // 5. Remove PID file
    const pidPath = join(this.dataDir, "fleet.pid");
    try { unlinkSync(pidPath); } catch (e) { this.logger.debug({ err: e }, "Failed to remove fleet PID file"); }
  }
}
