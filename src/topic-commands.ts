import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { FleetContext } from "./fleet-context.js";
import type { InboundMessage } from "./channel/types.js";
import { TelegramAdapter } from "./channel/adapters/telegram.js";
import { DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { formatCents } from "./cost-guard.js";

/** Sanitize a directory name into a valid instance name. Keeps Unicode letters (incl. CJK). */
export function sanitizeInstanceName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^\p{L}\d-]/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "project";
}

export class TopicCommands {
  private openSessions: Map<string, { paths: string[]; createdAt: number }> = new Map();

  constructor(private ctx: FleetContext) {}

  /** Parse and dispatch commands from the General topic */
  async handleGeneralCommand(msg: InboundMessage): Promise<boolean> {
    const text = msg.text?.trim();
    if (!text) return false;

    if (text === "/open" || text === "/open@" || text.startsWith("/open ") || text.startsWith("/open@")) {
      const keyword = text.replace(/^\/open(@\S+)?\s*/, "").trim();
      await this.handleOpenCommand(msg, keyword || undefined);
      return true;
    }

    if (text === "/new" || text === "/new@" || text.startsWith("/new ") || text.startsWith("/new@")) {
      const name = text.replace(/^\/new(@\S+)?\s*/, "").trim();
      await this.handleNewCommand(msg, name || undefined);
      return true;
    }

    if (text === "/status" || text === "/status@" || text.startsWith("/status@")) {
      await this.handleStatusCommand(msg);
      return true;
    }

    // Return false for commands we don't handle (e.g. /meets, /debate, /collab)
    return false;
  }

  private async handleStatusCommand(msg: InboundMessage): Promise<void> {
    if (!this.ctx.adapter || !this.ctx.fleetConfig) return;

    const lines: string[] = [];
    for (const [name] of Object.entries(this.ctx.fleetConfig.instances)) {
      const status = this.ctx.getInstanceStatus(name);
      const paused = this.ctx.costGuard?.isLimited(name);

      let contextStr = "-";
      try {
        const data = JSON.parse(readFileSync(join(this.ctx.dataDir, "instances", name, "statusline.json"), "utf-8"));
        if (data.context_window?.used_percentage != null) {
          contextStr = `${Math.round(data.context_window.used_percentage)}%`;
        }
      } catch { /* file may not exist yet */ }

      const costCents = this.ctx.costGuard?.getDailyCostCents(name) ?? 0;

      let icon: string;
      if (paused) icon = "⏸";
      else if (status === "running") icon = "🟢";
      else if (status === "crashed") icon = "🔴";
      else icon = "⚪";

      lines.push(`${icon} ${name} — ctx ${contextStr}, ${formatCents(costCents)} today`);
    }

    if (lines.length === 0) {
      lines.push("No instances configured.");
    }

    const limitCents = this.ctx.costGuard?.getLimitCents() ?? 0;
    const totalCents = this.ctx.costGuard?.getFleetTotalCents() ?? 0;
    if (limitCents > 0) {
      lines.push("");
      lines.push(`Fleet: ${formatCents(totalCents)} / ${formatCents(limitCents)} daily`);
    }

    await this.ctx.adapter.sendText(msg.chatId, lines.join("\n"));
  }

  /** Handle /open command — list or search unbound directories */
  private async handleOpenCommand(msg: InboundMessage, keyword?: string): Promise<void> {
    if (!this.ctx.adapter || !this.ctx.fleetConfig) return;

    const roots = this.getProjectRoots();
    if (roots.length === 0 || (roots.length === 1 && roots[0] === homedir())) {
      await this.ctx.adapter.sendText(msg.chatId, "No project roots configured. Run `ccd init` to set up.");
      return;
    }

    const dirs = this.listUnboundDirectories();

    if (keyword) {
      const result = this.filterDirectories(dirs, keyword);
      if (result.type === "none") {
        await this.ctx.adapter.sendText(msg.chatId, `No projects found matching "${keyword}".`);
        return;
      }
      if (result.type === "exact") {
        await this.openBindProject(msg.chatId, result.path);
        return;
      }
      await this.sendOpenKeyboard(msg.chatId, result.paths, 0);
      return;
    }

    if (dirs.length === 0) {
      await this.ctx.adapter.sendText(msg.chatId, "All projects are already bound to topics.");
      return;
    }
    await this.sendOpenKeyboard(msg.chatId, dirs, 0);
  }

  /** Send paginated inline keyboard for /open */
  private async sendOpenKeyboard(chatId: string, dirs: string[], page: number): Promise<void> {
    const sessionId = Math.random().toString(16).slice(2, 10);
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

    const tgAdapter = this.ctx.adapter as TelegramAdapter;
    await tgAdapter.sendTextWithKeyboard(chatId, headerText, keyboard);
  }

  /** Create topic and bind a project directory */
  private async openBindProject(chatId: string, dirPath: string): Promise<void> {
    if (!this.ctx.adapter || !this.ctx.fleetConfig) return;

    let topicId: number | undefined;
    try {
      const topicName = basename(dirPath);
      topicId = await this.ctx.createForumTopic(topicName);
      const instanceName = await this.bindAndStart(dirPath, topicId);

      const tgAdapter = this.ctx.adapter as TelegramAdapter;
      await tgAdapter.sendText(
        chatId,
        `✅ Bound to: ${dirPath}\nInstance: ${instanceName}`,
        { threadId: String(topicId) },
      );
    } catch (err) {
      if (topicId != null) {
        const partialName = Object.entries(this.ctx.fleetConfig.instances)
          .find(([, cfg]) => cfg.topic_id === topicId)?.[0];
        if (partialName) {
          delete this.ctx.fleetConfig.instances[partialName];
          this.ctx.routingTable.delete(topicId);
          this.ctx.saveFleetConfig();
        }
      }
      await this.ctx.adapter.sendText(chatId, `❌ Failed to bind: ${(err as Error).message}`);
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
    if (!this.ctx.adapter || !this.ctx.fleetConfig) return;

    if (!name) {
      await this.ctx.adapter.sendText(msg.chatId, "Usage: /new <project-name>");
      return;
    }

    if (!this.validateProjectName(name)) {
      await this.ctx.adapter.sendText(msg.chatId, "Invalid project name. Avoid /, .., leading -, and whitespace-only names.");
      return;
    }

    const roots = this.getProjectRoots();
    if (roots.length === 0 || (roots.length === 1 && roots[0] === homedir())) {
      await this.ctx.adapter.sendText(msg.chatId, "No project roots configured. Run `ccd init` to set up.");
      return;
    }

    const projectDir = join(roots[0], name);
    if (existsSync(projectDir)) {
      await this.ctx.adapter.sendText(msg.chatId, `Directory "${name}" already exists. Use /open ${name} instead.`);
      return;
    }

    try {
      const [topicId] = await Promise.all([
        this.ctx.createForumTopic(name),
        (async () => {
          mkdirSync(projectDir, { recursive: true });
          try {
            const { execFile } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const exec = promisify(execFile);
            await exec("git", ["init"], { cwd: projectDir });
          } catch (e) { this.ctx.logger.debug({ err: e }, "git init failed for new project directory"); }
        })(),
      ]);

      const instanceName = await this.bindAndStart(projectDir, topicId);

      const tgAdapter = this.ctx.adapter as TelegramAdapter;
      await tgAdapter.sendText(
        msg.chatId,
        `✅ Bound to: ${projectDir}\nInstance: ${instanceName}`,
        { threadId: String(topicId) },
      );
    } catch (err) {
      try {
        if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
      } catch (e) { this.ctx.logger.debug({ err: e }, "Rollback cleanup failed for project directory"); }
      if (this.ctx.fleetConfig) {
        const partialName = Object.entries(this.ctx.fleetConfig.instances)
          .find(([, cfg]) => cfg.working_directory === projectDir)?.[0];
        if (partialName) {
          const tid = this.ctx.fleetConfig.instances[partialName].topic_id;
          delete this.ctx.fleetConfig.instances[partialName];
          if (tid != null) this.ctx.routingTable.delete(tid);
          this.ctx.saveFleetConfig();
        }
      }
      await this.ctx.adapter.sendText(msg.chatId, `❌ Failed: ${(err as Error).message}`);
    }
  }

  /** Reply with redirect when message arrives in an unbound topic */
  async handleUnboundTopic(msg: InboundMessage): Promise<void> {
    if (!this.ctx.adapter) return;
    await this.ctx.adapter.sendText(
      msg.chatId,
      "Please use /open or /new in General to bind a project to a topic.",
      { threadId: msg.threadId },
    );
  }

  /** Dispatch callback queries by prefix */
  async handleCallbackQuery(data: { callbackData: string; chatId: string; threadId?: string; messageId: string }): Promise<void> {
    const { callbackData, chatId, messageId } = data;

    if (callbackData.startsWith("cmd_open:")) {
      await this.handleOpenCallback(callbackData, chatId, messageId);
    }
  }

  /** Handle callback from /open inline keyboard */
  private async handleOpenCallback(callbackData: string, chatId: string, messageId: string): Promise<void> {
    if (!this.ctx.adapter) return;

    const parts = callbackData.split(":");
    const sessionId = parts[1];

    const session = this.openSessions.get(sessionId);
    if (!session) {
      await this.ctx.adapter.editMessage(chatId, messageId, "This menu has expired. Use /open again.");
      return;
    }

    const action = parts[2];

    if (action === "cancel") {
      this.openSessions.delete(sessionId);
      await this.ctx.adapter.editMessage(chatId, messageId, "Cancelled.");
      return;
    }

    if (action === "page") {
      const page = parseInt(parts[3], 10);
      await this.ctx.adapter.editMessage(chatId, messageId, "Loading...");
      await this.sendOpenKeyboard(chatId, session.paths, page);
      return;
    }

    const index = parseInt(action, 10);
    if (isNaN(index) || index < 0 || index >= session.paths.length) {
      await this.ctx.adapter.editMessage(chatId, messageId, "Invalid selection.");
      return;
    }

    const dirPath = session.paths[index];
    this.openSessions.delete(sessionId);
    await this.ctx.adapter.editMessage(chatId, messageId, `Binding to ${basename(dirPath)}...`);
    await this.openBindProject(chatId, dirPath);
  }

  /** Handle topic deletion — stop daemon and remove from config */
  async handleTopicDeleted(threadId: number): Promise<void> {
    const target = this.ctx.routingTable.get(threadId);
    if (!target) return;
    const instanceName = target.name;

    this.ctx.logger.info({ instanceName, threadId }, "Topic deleted — auto-unbinding");

    if (this.ctx.scheduler) {
      const count = this.ctx.scheduler.deleteByInstanceOrThread(instanceName, String(threadId));
      if (count > 0) {
        this.ctx.logger.info({ threadId, instanceName, count }, "Cleaned up schedules for deleted topic");
        const groupId = this.ctx.fleetConfig?.channel?.group_id;
        if (groupId && this.ctx.adapter) {
          this.ctx.adapter.sendText(String(groupId), `⚠️ Topic 已刪除，已清除 ${count} 條相關排程。`).catch(e => this.ctx.logger.debug({ err: e }, "Failed to send schedule cleanup notification"));
        }
      }
    }

    await this.ctx.stopInstance(instanceName);
    this.ctx.routingTable.delete(threadId);

    if (this.ctx.fleetConfig) {
      delete this.ctx.fleetConfig.instances[instanceName];
      this.ctx.saveFleetConfig();
    }

    const ipc = this.ctx.instanceIpcClients.get(instanceName);
    if (ipc) {
      await ipc.close();
      this.ctx.instanceIpcClients.delete(instanceName);
    }
  }

  /** Create instance config, save fleet.yaml, start daemon, connect IPC. */
  async bindAndStart(dirPath: string, topicId: number): Promise<string> {
    if (!this.ctx.fleetConfig) throw new Error("Fleet config not loaded");

    const instanceName = `${sanitizeInstanceName(basename(dirPath))}-t${topicId}`;

    this.ctx.fleetConfig.instances[instanceName] = {
      working_directory: dirPath,
      topic_id: topicId,
      restart_policy: this.ctx.fleetConfig.defaults.restart_policy ?? DEFAULT_INSTANCE_CONFIG.restart_policy,
      context_guardian: this.ctx.fleetConfig.defaults.context_guardian ?? DEFAULT_INSTANCE_CONFIG.context_guardian,
      memory: this.ctx.fleetConfig.defaults.memory ?? DEFAULT_INSTANCE_CONFIG.memory,
      log_level: this.ctx.fleetConfig.defaults.log_level ?? DEFAULT_INSTANCE_CONFIG.log_level,
    };

    this.ctx.saveFleetConfig();
    this.ctx.routingTable.set(topicId, { kind: "instance", name: instanceName });

    await this.ctx.startInstance(instanceName, this.ctx.fleetConfig.instances[instanceName], true);

    await new Promise(r => setTimeout(r, 5000));
    await this.ctx.connectIpcToInstance(instanceName);

    this.ctx.logger.info({ instanceName, topicId }, "Topic bound and started");
    return instanceName;
  }

  /** Create Telegram topics for instances that don't have topic_id */
  async autoCreateTopics(): Promise<void> {
    if (!this.ctx.fleetConfig?.channel?.group_id) return;
    const botToken = process.env[this.ctx.fleetConfig.channel.bot_token_env];
    if (!botToken) return;

    let configChanged = false;
    for (const [name, config] of Object.entries(this.ctx.fleetConfig.instances)) {
      if (config.topic_id != null) continue;

      try {
        const topicName = basename(config.working_directory);
        const threadId = await this.ctx.createForumTopic(topicName);
        config.topic_id = threadId;
        configChanged = true;
        this.ctx.logger.info({ name, topicId: config.topic_id, topicName }, "Auto-created Telegram topic");
      } catch (err) {
        this.ctx.logger.warn({ name, err }, "Failed to auto-create topic");
      }
    }

    if (configChanged) {
      this.ctx.saveFleetConfig();
    }
  }

  /** Register /open and /new in Telegram command menu */
  async registerBotCommands(): Promise<void> {
    const groupId = this.ctx.fleetConfig?.channel?.group_id;
    const botTokenEnv = this.ctx.fleetConfig?.channel?.bot_token_env;
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
              { command: "status", description: "Show fleet status and costs" },
              { command: "meets", description: "Start a multi-angle discussion" },
              { command: "debate", description: "Start a pro/con debate" },
              { command: "collab", description: "Start collaborative coding with worktrees" },
            ],
            scope: { type: "chat", chat_id: groupId },
          }),
        },
      );
      this.ctx.logger.info("Registered bot commands: /open, /new, /status, /meets, /debate, /collab");
    } catch (err) {
      this.ctx.logger.warn({ err }, "Failed to register bot commands (non-fatal)");
    }
  }

  // ── Helpers ──

  getProjectRoots(): string[] {
    const roots = this.ctx.fleetConfig?.project_roots;
    if (roots && roots.length > 0) {
      return roots.map(r => r.startsWith("~") ? join(homedir(), r.slice(1)) : r)
        .filter(r => existsSync(r));
    }
    return [homedir()];
  }

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
      } catch (e) { this.ctx.logger.debug({ err: e, root }, "Failed to read project root directory"); }
    }
    return dirs.sort((a, b) => basename(a).localeCompare(basename(b)));
  }

  private listUnboundDirectories(): string[] {
    const boundDirs = new Set(
      Object.values(this.ctx.fleetConfig?.instances ?? {}).map(i => i.working_directory),
    );
    return this.listProjectDirectories().filter(d => !boundDirs.has(d));
  }

  private filterDirectories(
    dirs: string[],
    keyword: string,
  ): { type: "exact"; path: string } | { type: "multiple"; paths: string[] } | { type: "none" } {
    const kw = keyword.toLowerCase();
    const exactMatches = dirs.filter(d => basename(d).toLowerCase() === kw);
    if (exactMatches.length === 1) {
      return { type: "exact", path: exactMatches[0] };
    }
    const subMatches = dirs.filter(d => basename(d).toLowerCase().includes(kw));
    if (subMatches.length === 0) return { type: "none" };
    if (subMatches.length === 1) return { type: "exact", path: subMatches[0] };
    return { type: "multiple", paths: subMatches };
  }
}
