import { readFileSync, existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const execAsync = promisify(exec);
import type { FleetContext } from "./fleet-context.js";
import type { InboundMessage } from "./channel/types.js";
import { DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { formatCents } from "./cost-guard.js";
import { detectPlatform } from "./service-installer.js";

/** Sanitize a directory name into a valid instance name. Keeps Unicode letters (incl. CJK). */
export function sanitizeInstanceName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^\p{L}\d-]/gu, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "project";
}

export class TopicCommands {
  constructor(private ctx: FleetContext) {}

  /** Parse and dispatch commands from the General topic */
  async handleGeneralCommand(msg: InboundMessage): Promise<boolean> {
    const text = msg.text?.trim();
    if (!text) return false;

    if (text === "/status" || text === "/status@" || text.startsWith("/status@")) {
      await this.handleStatusCommand(msg);
      return true;
    }

    if (text === "/restart" || text === "/restart@" || text.startsWith("/restart@")) {
      await this.handleRestartCommand(msg);
      return true;
    }

    if (text === "/sysinfo" || text === "/sysinfo@" || text.startsWith("/sysinfo@")
        || text === "/sys-info" || text === "/sys_info") {
      await this.handleSysInfoCommand(msg);
      return true;
    }

    if (text === "/update" || text === "/update@" || text.startsWith("/update@")) {
      await this.handleUpdateCommand(msg);
      return true;
    }

    return false;
  }

  private async handleRestartCommand(msg: InboundMessage): Promise<void> {
    if (!this.ctx.adapter) return;
    const chatId = msg.chatId;
    const threadId = msg.threadId;
    await this.ctx.adapter.sendText(chatId, "🔄 Graceful restart — waiting for instances to idle...", { threadId });
    // SIGUSR2 triggers in-process restart (safe without service manager)
    process.kill(process.pid, "SIGUSR2");
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

  private async handleSysInfoCommand(msg: InboundMessage): Promise<void> {
    if (!this.ctx.adapter) return;
    const info = this.ctx.getSysInfo();

    const upHours = Math.floor(info.uptime_seconds / 3600);
    const upMins = Math.floor((info.uptime_seconds % 3600) / 60);
    const lines: string[] = [
      `⚙️ System Info`,
      `Uptime: ${upHours}h ${upMins}m`,
      `Memory: ${info.memory_mb.rss} MB RSS, ${info.memory_mb.heapUsed}/${info.memory_mb.heapTotal} MB heap`,
      "",
      "Instances:",
    ];

    for (const inst of info.instances) {
      const icon = inst.status === "running" ? "🟢" : inst.status === "crashed" ? "🔴" : "⚪";
      const ipc = inst.ipc ? "✓" : "✗";
      let detail = `${icon} ${inst.name} [IPC:${ipc}] ${formatCents(inst.costCents)}`;
      if (inst.rateLimits) {
        detail += ` (5h:${inst.rateLimits.five_hour_pct}% 7d:${inst.rateLimits.seven_day_pct}%)`;
      }
      lines.push(detail);
    }

    if (info.fleet_cost_limit_cents > 0) {
      lines.push("");
      lines.push(`Fleet cost: ${formatCents(info.fleet_cost_cents)} / ${formatCents(info.fleet_cost_limit_cents)} daily`);
    }

    await this.ctx.adapter.sendText(msg.chatId, lines.join("\n"), { threadId: msg.threadId });
  }

  private async handleUpdateCommand(msg: InboundMessage): Promise<void> {
    if (!this.ctx.adapter) return;
    const chatId = msg.chatId;
    const threadId = msg.threadId;

    // Access control — only allowed users can trigger update
    const allowed = this.ctx.fleetConfig?.channel?.access?.allowed_users ?? [];
    if (allowed.length > 0 && !allowed.some(u => String(u) === String(msg.userId))) {
      await this.ctx.adapter.sendText(chatId, "⛔ Not authorized", { threadId });
      return;
    }

    await this.ctx.adapter.sendText(chatId, "📦 Updating AgEnD...", { threadId });

    try {
      await execAsync("npm install -g @suzuke/agend@latest", { timeout: 120_000 });
    } catch {
      await this.ctx.adapter.sendText(chatId, "❌ npm install failed. Try manually: npm install -g @suzuke/agend@latest", { threadId });
      return;
    }

    await this.ctx.adapter.sendText(chatId, "✅ Updated. Restarting service...", { threadId });
    // Brief delay to let sendText complete before process dies
    await new Promise(r => setTimeout(r, 1000));

    const label = "com.agend.fleet";
    const plat = detectPlatform();

    if (plat === "macos") {
      const plistPath = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
      if (existsSync(plistPath)) {
        const uid = process.getuid?.() ?? 501;
        try {
          await execAsync(`launchctl kickstart -k gui/${uid}/${label}`, { timeout: 15_000 });
          return;
        } catch {
          await this.ctx.adapter.sendText(chatId, "⚠️ Failed to restart launchd service", { threadId });
          return;
        }
      }
    } else {
      try {
        await execAsync(`systemctl --user restart ${label}`, { timeout: 15_000 });
        return;
      } catch { /* no systemd service */ }
    }

    // Fallback: signal running daemon
    const pidPath = join(this.ctx.dataDir, "fleet.pid");
    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      try {
        process.kill(pid, "SIGUSR1");
      } catch {
        await this.ctx.adapter.sendText(chatId, "⚠️ Fleet not running", { threadId });
      }
    } else {
      await this.ctx.adapter.sendText(chatId, "⚠️ No service or running fleet found", { threadId });
    }
  }

  /** Reply with redirect when message arrives in an unbound topic */
  async handleUnboundTopic(msg: InboundMessage): Promise<void> {
    if (!this.ctx.adapter) return;
    await this.ctx.adapter.sendText(
      msg.chatId,
      "This topic is not bound to an instance. Ask the General assistant to create one with create_instance.",
      { threadId: msg.threadId },
    );
  }

  /** Handle topic deletion — stop daemon and remove from config */
  async handleTopicDeleted(threadId: string): Promise<void> {
    const target = this.ctx.routingTable.get(threadId);
    if (!target) return;
    if (target.kind === "general") {
      this.ctx.logger.debug({ instanceName: target.name, threadId }, "Ignoring delete event for General topic");
      return;
    }

    this.ctx.logger.info({ instanceName: target.name, threadId }, "Topic deleted — auto-unbinding");
    await this.ctx.removeInstance(target.name);
  }

  /** Create instance config, save fleet.yaml, start daemon, connect IPC. */
  async bindAndStart(dirPath: string, topicId: number | string): Promise<string> {
    if (!this.ctx.fleetConfig) throw new Error("Fleet config not loaded");

    const instanceName = `${sanitizeInstanceName(basename(dirPath))}-t${topicId}`;

    this.ctx.fleetConfig.instances[instanceName] = {
      working_directory: dirPath,
      topic_id: topicId,
      restart_policy: this.ctx.fleetConfig.defaults.restart_policy ?? DEFAULT_INSTANCE_CONFIG.restart_policy,
      context_guardian: this.ctx.fleetConfig.defaults.context_guardian ?? DEFAULT_INSTANCE_CONFIG.context_guardian,
      log_level: this.ctx.fleetConfig.defaults.log_level ?? DEFAULT_INSTANCE_CONFIG.log_level,
    };

    this.ctx.saveFleetConfig();
    this.ctx.routingTable.set(String(topicId), { kind: "instance", name: instanceName });

    // startInstance awaits lifecycle.start → daemon.start (IPC listening) →
    // connectIpcToInstance. By the time it resolves, IPC is already wired —
    // the previous code's 5s sleep + second connect was leftover paranoia.
    await this.ctx.startInstance(instanceName, this.ctx.fleetConfig.instances[instanceName], true);

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

      // Telegram's native General topic always has thread_id = 1
      if (config.general_topic) {
        config.topic_id = 1;
        configChanged = true;
        this.ctx.logger.info({ name, topicId: 1 }, "Bound to native General topic");
        continue;
      }

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

  /** Register bot commands in Telegram command menu */
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
              { command: "status", description: "Show fleet status and costs" },
              { command: "restart", description: "Graceful restart all instances" },
              { command: "sysinfo", description: "System diagnostics" },
              { command: "update", description: "Update AgEnD and restart service" },
            ],
            scope: { type: "chat", chat_id: groupId },
          }),
        },
      );
      this.ctx.logger.info("Registered bot commands: /status");
    } catch (err) {
      this.ctx.logger.warn({ err }, "Failed to register bot commands (non-fatal)");
    }
  }
}
