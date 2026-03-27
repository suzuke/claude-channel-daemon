import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { FleetContext } from "./fleet-context.js";
import type { InboundMessage } from "./channel/types.js";
import { DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { formatCents } from "./cost-guard.js";

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
