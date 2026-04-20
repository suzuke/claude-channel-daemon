import { EventEmitter } from "node:events";
import type { CostGuardConfig } from "./types.js";
import type { EventLog } from "./event-log.js";

interface InstanceTracker {
  accumulatedCents: number;
  lastReportedUsd: number;
  warnEmitted: boolean;
  limitEmitted: boolean;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Return ms until the next calendar-date change in `timezone`.
 *
 * The previous implementation used `new Date(now.toLocaleString(..., {timeZone}))`
 * (which reinterprets the target-tz wall-clock as a local-tz wall-clock — wrong
 * across DST whenever local and target observe DST differently) and then called
 * `setHours(24, 0, 0, 0)` (which is local-tz, so on a DST transition day in the
 * local zone the gap is off by an hour).
 *
 * Instead we observe the *actual* date in the target tz via Intl and binary-search
 * for the first instant where that date changes. This naturally handles 23-hour
 * spring-forward and 25-hour fall-back days, and also handles non-DST mismatches
 * between local and target zones.
 */
export function msUntilMidnight(timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const dateInTz = (t: number) => fmt.format(new Date(t));

  const now = Date.now();
  const today = dateInTz(now);
  // 26h covers the worst-case 25-hour fall-back day plus a 1h safety margin.
  let lo = 1;
  let hi = 26 * 60 * 60 * 1000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateInTz(now + mid) === today) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class CostGuard extends EventEmitter {
  private config: CostGuardConfig;
  private eventLog: EventLog;
  private trackers = new Map<string, InstanceTracker>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: CostGuardConfig, eventLog: EventLog) {
    super();
    this.config = config;
    this.eventLog = eventLog;
  }

  private getTracker(instance: string): InstanceTracker {
    let tracker = this.trackers.get(instance);
    if (!tracker) {
      tracker = {
        accumulatedCents: 0,
        lastReportedUsd: 0,
        warnEmitted: false,
        limitEmitted: false,
      };
      this.trackers.set(instance, tracker);
    }
    return tracker;
  }

  updateCost(instance: string, costUsd: number): void {
    const tracker = this.getTracker(instance);

    // Detect rotation: cost dropped = new session started
    if (costUsd < tracker.lastReportedUsd && tracker.lastReportedUsd > 0) {
      this.snapshotAndReset(instance);
    }

    tracker.lastReportedUsd = costUsd;

    if (this.config.daily_limit_usd <= 0) return;

    const totalCents = this.getDailyCostCents(instance);
    const limitCents = this.getLimitCents();

    if (!tracker.limitEmitted && totalCents >= limitCents) {
      tracker.limitEmitted = true;
      this.emit("limit", instance, totalCents, limitCents);
      return;
    }

    if (!tracker.warnEmitted) {
      const warnThresholdCents = Math.round(
        limitCents * (this.config.warn_at_percentage / 100),
      );
      if (totalCents >= warnThresholdCents) {
        tracker.warnEmitted = true;
        this.emit("warn", instance, totalCents, limitCents);
      }
    }
  }

  snapshotAndReset(instance: string): void {
    const tracker = this.getTracker(instance);
    const sessionCents = Math.round(tracker.lastReportedUsd * 100);
    tracker.accumulatedCents += sessionCents;
    const previousUsd = tracker.lastReportedUsd;
    tracker.lastReportedUsd = 0;
    // Reset per-day notification flags so a new session that pushes the
    // accumulated total past the threshold re-fires `warn` / `limit`. This
    // matters for the limit handler in particular: it pauses the instance,
    // and without re-firing a user-restarted instance can blow past the
    // daily cap again silently. We're still bounded — a single session
    // can fire each event at most once.
    tracker.warnEmitted = false;
    tracker.limitEmitted = false;

    this.eventLog.insert(instance, "cost_snapshot", {
      session_cost_usd: previousUsd,
      accumulated_cents: tracker.accumulatedCents,
    });
  }

  getDailyCostCents(instance: string): number {
    const tracker = this.trackers.get(instance);
    if (!tracker) return 0;
    return tracker.accumulatedCents + Math.round(tracker.lastReportedUsd * 100);
  }

  getFleetTotalCents(): number {
    let total = 0;
    for (const [instance] of this.trackers) {
      total += this.getDailyCostCents(instance);
    }
    return total;
  }

  getLimitCents(): number {
    return Math.round(this.config.daily_limit_usd * 100);
  }

  isLimited(instance: string): boolean {
    if (this.config.daily_limit_usd <= 0) return false;
    return this.getDailyCostCents(instance) >= this.getLimitCents();
  }

  resetDaily(): void {
    this.trackers.clear();
    this.emit("daily_reset");
  }

  startMidnightReset(): void {
    const schedule = () => {
      const ms = msUntilMidnight(this.config.timezone);
      this.timer = setTimeout(() => {
        this.resetDaily();
        schedule();
      }, ms);
    };
    schedule();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
