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
import { transcribe } from "./stt.js";

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
      const value = trimmed.slice(eqIdx + 1);
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

    // Ensure tmux session exists
    await TmuxManager.ensureSession(TMUX_SESSION);

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
      this.handleInboundMessage(msg);
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

        // Handle outbound tool calls, approval requests, and tool status from daemon
        ipc.on("message", (msg: Record<string, unknown>) => {
          if (msg.type === "fleet_outbound") {
            this.handleOutboundFromInstance(name, msg);
          } else if (msg.type === "fleet_approval_request") {
            this.handleApprovalFromInstance(name, msg);
          } else if (msg.type === "fleet_tool_status") {
            this.handleToolStatusFromInstance(name, msg);
          }
        });

        this.logger.debug({ name }, "Connected to instance IPC");
      } catch (err) {
        this.logger.warn({ name, err }, "Failed to connect to instance IPC");
      }
    }
  }

  /** Handle inbound message — transcribe voice if present, then route */
  private async handleInboundMessage(msg: InboundMessage): Promise<void> {
    const threadId = msg.threadId ? parseInt(msg.threadId, 10) : undefined;
    if (threadId == null) {
      this.logger.warn({ chatId: msg.chatId }, "Message without threadId — ignoring in topic mode");
      return;
    }

    const instanceName = this.routingTable.get(threadId);
    if (!instanceName) {
      if (this.pendingBindings.get(threadId) === "awaiting_name") {
        this.handleNewProjectName(msg, threadId);
        return;
      }
      if (this.pendingBindings.has(threadId)) return;
      this.handleUnboundTopic(msg, threadId);
      return;
    }

    // Transcribe voice messages
    let text = msg.text;
    const voiceAttachment = msg.attachments?.find(a => a.kind === "voice" || a.kind === "audio");
    if (voiceAttachment) {
      const groqKey = process.env.GROQ_API_KEY;
      if (groqKey) {
        try {
          const localPath = await (this.adapter as TelegramAdapter).downloadAttachment(voiceAttachment.fileId);
          const result = await transcribe(localPath, groqKey);
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
        ...(voiceAttachment ? { attachment_file_id: voiceAttachment.fileId } : {}),
      },
    });
    this.logger.info(`← ${instanceName} ${msg.username.padEnd(14)}: ${(text ?? "").slice(0, 100)}`);
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
        this.logger.info(`→ ${instanceName} ${"claude".padEnd(14)}: ${(args.text as string ?? "").slice(0, 100)}`);
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

  private sendApprovalResponse(instanceName: string, approvalId: string, decision: "approve" | "deny"): void {
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
      this.adapter.editMessage(chatId, editMessageId, text).catch(() => {});
    } else {
      this.adapter.sendText(chatId, text, { threadId }).then((sent) => {
        // Send the messageId back to the daemon so it can edit next time
        const ipc = this.instanceIpcClients.get(instanceName);
        ipc?.send({ type: "fleet_tool_status_ack", messageId: sent.messageId });
      }).catch(() => {});
    }
  }

  // ===================== Auto-create topics =====================

  /** Create Telegram topics for instances that don't have topic_id */
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
        const res = await fetch(
          `https://api.telegram.org/bot${botToken}/createForumTopic`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: fleet.channel.group_id,
              name: topicName,
            }),
          },
        );
        const data = await res.json() as { ok: boolean; result?: { message_thread_id: number } };
        if (data.ok && data.result) {
          config.topic_id = data.result.message_thread_id;
          configChanged = true;
          this.logger.info({ name, topicId: config.topic_id, topicName }, "Auto-created Telegram topic");
        }
      } catch (err) {
        this.logger.warn({ name, err }, "Failed to auto-create topic");
      }
    }

    if (configChanged) {
      this.saveFleetConfig();
    }
  }

  // ===================== Auto-bind =====================

  /** Show directory browser when message arrives in unbound topic */
  private async handleUnboundTopic(msg: InboundMessage, threadId: number, page = 0): Promise<void> {
    if (!this.adapter) return;
    this.pendingBindings.set(threadId, "browsing");

    const dirs = this.listProjectDirectories();
    const recentDirs = this.getRecentlyBoundDirs();
    const PAGE_SIZE = 5;

    const { InlineKeyboard } = await import("grammy");
    const keyboard = new InlineKeyboard();

    // Recently bound projects (only on first page)
    if (page === 0 && recentDirs.length > 0) {
      for (const dir of recentDirs.slice(0, 3)) {
        const label = `⭐ ${basename(dir)}`;
        keyboard.text(label, `bind:${threadId}:${dir}`).row();
      }
    }

    // Paginated project list (exclude recent to avoid duplicates)
    const recentSet = new Set(recentDirs);
    const filteredDirs = dirs.filter(d => !recentSet.has(d));
    const pageStart = page * PAGE_SIZE;
    const pageDirs = filteredDirs.slice(pageStart, pageStart + PAGE_SIZE);

    for (const dir of pageDirs) {
      keyboard.text(`📁 ${basename(dir)}`, `bind:${threadId}:${dir}`).row();
    }

    // Pagination buttons
    const hasMore = pageStart + PAGE_SIZE < filteredDirs.length;
    if (page > 0 || hasMore) {
      if (page > 0) keyboard.text("⬅️ Prev", `page:${threadId}:${page - 1}`);
      if (hasMore) keyboard.text("➡️ Next", `page:${threadId}:${page + 1}`);
      keyboard.row();
    }

    // New project + cancel
    keyboard.text("➕ New project", `newproj:${threadId}`).row();
    keyboard.text("❌ Cancel", `bind:${threadId}:cancel`).row();

    const tgAdapter = this.adapter as TelegramAdapter;
    const headerText = page === 0
      ? "📂 Select a project for this topic:"
      : `📂 Projects (page ${page + 1}):`;

    await tgAdapter.sendTextWithKeyboard(
      msg.chatId,
      headerText,
      keyboard,
      String(threadId),
    );
  }

  /** Handle directory selection from inline keyboard */
  private async handleDirectorySelection(data: { callbackData: string; chatId: string; threadId?: string; messageId: string }): Promise<void> {
    const { callbackData, chatId } = data;

    // Pagination
    if (callbackData.startsWith("page:")) {
      const parts = callbackData.split(":");
      const threadId = parseInt(parts[1], 10);
      const page = parseInt(parts[2], 10);
      await this.adapter?.editMessage(chatId, data.messageId, "Loading...");
      await this.handleUnboundTopic(
        { chatId, threadId: String(threadId), text: "", source: "", adapterId: "", messageId: "", userId: "", username: "", timestamp: new Date() },
        threadId,
        page,
      );
      return;
    }

    // New project
    if (callbackData.startsWith("newproj:")) {
      const threadId = parseInt(callbackData.split(":")[1], 10);
      await this.adapter?.editMessage(chatId, data.messageId, "📝 Send the new project name (will create folder in project root):");
      this.pendingBindings.set(threadId, "awaiting_name");
      return;
    }

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
    const instanceName = `${basename(dirPath).toLowerCase().replace(/[^a-z0-9-]/g, "-")}-t${threadId}`;

    this.logger.info({ instanceName, threadId, dirPath }, "Auto-binding topic to project");

    // Update fleet config
    if (this.fleetConfig) {
      this.fleetConfig.instances[instanceName] = {
        working_directory: dirPath,
        topic_id: threadId,
        restart_policy: this.fleetConfig.defaults.restart_policy ?? { max_retries: 10, backoff: "exponential", reset_after: 300 },
        context_guardian: this.fleetConfig.defaults.context_guardian ?? { threshold_percentage: 40, max_age_hours: 4, strategy: "hybrid" },
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

  /** Handle new project name input */
  private async handleNewProjectName(msg: InboundMessage, threadId: number): Promise<void> {
    const projectName = msg.text.trim();
    if (!projectName || projectName.includes("/") || projectName.includes("..")) {
      await this.adapter?.sendText(msg.chatId, "Invalid project name. Try again:", { threadId: String(threadId) });
      return;
    }

    // Find first project root to create in
    const roots = this.getProjectRoots();
    if (roots.length === 0) {
      await this.adapter?.sendText(msg.chatId, "No project_roots configured in fleet.yaml.", { threadId: String(threadId) });
      this.pendingBindings.delete(threadId);
      return;
    }

    const projectDir = join(roots[0], projectName);
    if (existsSync(projectDir)) {
      // Directory already exists — just bind it
      await this.adapter?.sendText(msg.chatId, `📁 Directory already exists. Binding to: ${projectDir}`, { threadId: String(threadId) });
    } else {
      // Create directory + git init
      mkdirSync(projectDir, { recursive: true });
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFile);
        await exec("git", ["init"], { cwd: projectDir });
      } catch {}
      await this.adapter?.sendText(msg.chatId, `✅ Created: ${projectDir}`, { threadId: String(threadId) });
    }

    // Bind it directly (not via handleDirectorySelection — no message to edit)
    this.pendingBindings.delete(threadId);
    const instanceName = `${basename(projectDir).toLowerCase().replace(/[^a-z0-9-]/g, "-")}-t${threadId}`;

    if (this.fleetConfig) {
      this.fleetConfig.instances[instanceName] = {
        working_directory: projectDir,
        topic_id: threadId,
        restart_policy: this.fleetConfig.defaults.restart_policy ?? { max_retries: 10, backoff: "exponential", reset_after: 300 },
        context_guardian: this.fleetConfig.defaults.context_guardian ?? { threshold_percentage: 40, max_age_hours: 4, strategy: "hybrid" },
        memory: this.fleetConfig.defaults.memory ?? { auto_summarize: false, watch_memory_dir: true, backup_to_sqlite: true },
        log_level: (this.fleetConfig.defaults.log_level as "info") ?? "info",
      };
      this.saveFleetConfig();
      this.routingTable.set(threadId, instanceName);

      const ports = this.allocatePorts(this.fleetConfig.instances);
      await this.startInstance(instanceName, this.fleetConfig.instances[instanceName], ports[instanceName], true);

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

      await this.adapter?.sendText(msg.chatId, `✅ Created & bound: ${projectDir}`, { threadId: String(threadId) });
      this.logger.info({ instanceName, threadId }, "New project created and bound");
    }
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
      } catch {}
    }
    return dirs.sort((a, b) => basename(a).localeCompare(basename(b)));
  }

  /** Get directories of recently bound instances (for "recent" section) */
  private getRecentlyBoundDirs(): string[] {
    if (!this.fleetConfig) return [];
    return Object.values(this.fleetConfig.instances)
      .map(inst => inst.working_directory)
      .filter(d => existsSync(d));
  }

  /** Save fleet config back to fleet.yaml */
  private saveFleetConfig(): void {
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
          const msg = await bot.api.sendMessage(groupId, ".", {
            message_thread_id: threadId,
          });
          // Topic exists — delete the probe message
          await bot.api.deleteMessage(groupId, msg.message_id).catch(() => {});
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
