import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetConfig } from "./types.js";
import type { ChannelAdapter } from "./channel/types.js";
import type { Logger } from "./logger.js";

export interface ArchiverContext {
  readonly fleetConfig: FleetConfig | null;
  readonly adapter: ChannelAdapter | null;
  readonly logger: Logger;
  readonly dataDir: string;
  getInstanceStatus(name: string): "running" | "stopped" | "crashed";
  lastActivityMs(name: string): number;
  setTopicIcon(name: string, state: "green" | "blue" | "red" | "remove"): void;
  touchActivity(name: string): void;
}

/**
 * Manages automatic archival (close) and reopening of idle forum topics.
 *
 * Archived state is persisted to `<dataDir>/archived-topics.json` so a daemon
 * restart does not re-archive (or re-message) topics that were already closed.
 */
export class TopicArchiver {
  private archived = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly statePath: string;

  static readonly IDLE_MS = 24 * 60 * 60 * 1000; // 24 hours
  private static readonly POLL_MS = 30 * 60_000;  // check every 30 minutes

  constructor(private ctx: ArchiverContext) {
    this.statePath = join(ctx.dataDir, "archived-topics.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const arr: unknown = JSON.parse(readFileSync(this.statePath, "utf-8"));
      if (!Array.isArray(arr)) return;
      for (const id of arr) {
        if (typeof id === "string") this.archived.add(id);
      }
    } catch (err) {
      this.ctx.logger.warn({ err, path: this.statePath }, "Failed to load archived-topics state");
    }
  }

  private save(): void {
    // Atomic write: tmp + rename so a crash mid-write cannot leave a
    // truncated JSON that load() would reject.
    const tmp = `${this.statePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify([...this.archived]));
      renameSync(tmp, this.statePath);
    } catch (err) {
      this.ctx.logger.warn({ err, path: this.statePath }, "Failed to save archived-topics state");
    }
  }

  /** Is this topic currently archived? */
  isArchived(topicId: string): boolean {
    return this.archived.has(topicId);
  }

  /** Start periodic idle check. */
  startPoller(): void {
    this.timer = setInterval(() => {
      this.archiveIdle().catch((err) =>
        this.ctx.logger.debug({ err }, "Archive idle check failed"));
    }, TopicArchiver.POLL_MS);
  }

  /** Stop the poller and clean up. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Close topics that have been idle beyond threshold. */
  async archiveIdle(): Promise<void> {
    if (!this.ctx.adapter?.closeForumTopic || !this.ctx.fleetConfig) return;
    const now = Date.now();

    for (const [name, config] of Object.entries(this.ctx.fleetConfig.instances)) {
      const topicId = config.topic_id;
      if (topicId == null || config.general_topic) continue;
      const topicIdStr = String(topicId);
      if (this.archived.has(topicIdStr)) continue;

      const status = this.ctx.getInstanceStatus(name);
      if (status !== "running") continue;

      const last = this.ctx.lastActivityMs(name);
      if (last === 0) continue; // never active → skip
      if (now - last < TopicArchiver.IDLE_MS) continue;

      this.ctx.logger.info({ name, topicId, idleHours: Math.round((now - last) / 3600000) }, "Archiving idle topic");
      this.archived.add(topicIdStr);
      this.save();
      this.ctx.setTopicIcon(name, "remove");
      await this.ctx.adapter.closeForumTopic(topicId);
    }
  }

  /** Reopen an archived topic and restore icon. */
  async reopen(topicId: string, instanceName: string): Promise<void> {
    if (!this.archived.has(topicId)) return;
    this.archived.delete(topicId);
    this.save();

    if (this.ctx.adapter?.reopenForumTopic) {
      await this.ctx.adapter.reopenForumTopic(topicId);
    }
    this.ctx.setTopicIcon(instanceName, "green");
    this.ctx.touchActivity(instanceName);
    this.ctx.logger.info({ instanceName, topicId }, "Reopened archived topic");
  }
}
