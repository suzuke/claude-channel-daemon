import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { FleetConfig } from "./types.js";
import type { ChannelAdapter } from "./channel/types.js";
import type { Logger } from "./logger.js";

export interface ArchiverContext {
  readonly fleetConfig: FleetConfig | null;
  readonly adapter: ChannelAdapter | null;
  readonly logger: Logger;
  getInstanceStatus(name: string): "running" | "stopped" | "crashed";
  lastActivityMs(name: string): number;
  setTopicIcon(name: string, state: "green" | "blue" | "red" | "remove"): void;
  touchActivity(name: string): void;
}

/**
 * Manages automatic archival (close) and reopening of idle forum topics.
 *
 * Archived state is persisted to disk so that a daemon restart does not lose
 * track of which topics are already closed. Without persistence, after
 * restart the set would be empty: inbound activity would fail to reopen
 * (reopen() no-ops when !archived.has) and the next poll would attempt to
 * close an already-closed topic.
 */
export class TopicArchiver {
  private archived = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private persistPath: string | null;

  static readonly IDLE_MS = 24 * 60 * 60 * 1000; // 24 hours
  private static readonly POLL_MS = 30 * 60_000;  // check every 30 minutes

  constructor(private ctx: ArchiverContext, persistPath?: string) {
    this.persistPath = persistPath ?? null;
    this.load();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.persistPath, "utf-8")) as unknown;
      if (Array.isArray(data)) {
        this.archived = new Set(data.filter((x): x is string => typeof x === "string"));
      }
    } catch (err) {
      this.ctx.logger.debug({ err, path: this.persistPath }, "Failed to load archived-topics state — starting empty");
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      writeFileSync(this.persistPath, JSON.stringify([...this.archived]));
    } catch (err) {
      this.ctx.logger.debug({ err, path: this.persistPath }, "Failed to persist archived-topics state");
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
