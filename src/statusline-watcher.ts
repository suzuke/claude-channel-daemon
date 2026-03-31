import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CostGuard } from "./cost-guard.js";
import type { Logger } from "./logger.js";

export interface RateLimitData {
  five_hour_pct: number;
  seven_day_pct: number;
}

export interface StatuslineWatcherContext {
  readonly logger: Logger;
  readonly costGuard: CostGuard | null;
  getInstanceDir(name: string): string;
  notifyInstanceTopic(name: string, text: string): void;
  checkModelFailover(name: string, fiveHourPct: number): void;
}

/**
 * Periodically reads statusline.json for each instance to track
 * cost usage and rate limit status.
 */
export class StatuslineWatcher {
  private watchers = new Map<string, ReturnType<typeof setInterval>>();
  private rateLimits = new Map<string, RateLimitData>();
  private static readonly POLL_MS = 10_000;

  constructor(private ctx: StatuslineWatcherContext) {}

  /** Start watching an instance's statusline.json. */
  watch(name: string): void {
    if (this.watchers.has(name)) return;

    const statusFile = join(this.ctx.getInstanceDir(name), "statusline.json");
    const timer = setInterval(() => {
      try {
        const data = JSON.parse(readFileSync(statusFile, "utf-8"));

        // Cost tracking
        if (data.cost?.total_cost_usd != null) {
          this.ctx.costGuard?.updateCost(name, data.cost.total_cost_usd);
        }

        // Rate limit tracking
        const rl = data.rate_limits;
        if (rl) {
          const prev = this.rateLimits.get(name);
          const newSevenDay = rl.seven_day?.used_percentage ?? 0;

          // Notify on recovery
          if (prev?.seven_day_pct === 100 && newSevenDay < 100) {
            this.ctx.notifyInstanceTopic(name, `✅ ${name} weekly usage limit has reset — instance is available again.`);
            this.ctx.logger.info({ name }, "Weekly rate limit recovered");
          }

          this.rateLimits.set(name, {
            five_hour_pct: rl.five_hour?.used_percentage ?? 0,
            seven_day_pct: newSevenDay,
          });

          this.ctx.checkModelFailover(name, rl.five_hour?.used_percentage ?? 0);
        }
      } catch { /* file may not exist yet or be mid-write */ }
    }, StatuslineWatcher.POLL_MS);

    this.watchers.set(name, timer);
  }

  /** Get rate limit data for an instance. */
  getRateLimits(name: string): RateLimitData | undefined {
    return this.rateLimits.get(name);
  }

  /** Check if an instance has an active watcher. */
  has(name: string): boolean {
    return this.watchers.has(name);
  }

  /** Stop all watchers and clear data. */
  stopAll(): void {
    for (const [, timer] of this.watchers) clearInterval(timer);
    this.watchers.clear();
    this.rateLimits.clear();
  }
}
