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
 * Milliseconds until the next local midnight in the given IANA timezone.
 *
 * The previous implementation used `new Date(now.toLocaleString(...))` which
 * reinterprets a TZ-aware string as host-local time and quietly breaks on
 * DST transitions. This version reads the TZ-local hour/minute/second via
 * Intl.DateTimeFormat and computes the offset to 24:00 directly. The result
 * is clamped to [1 min, 25 h] to tolerate the ±1h drift a DST transition
 * could introduce between computation and the scheduled fire.
 */
export function msUntilMidnight(timezone: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value])) as Record<string, string>;
  const h = parseInt(byType.hour ?? "0", 10);
  const m = parseInt(byType.minute ?? "0", 10);
  const s = parseInt(byType.second ?? "0", 10);
  const msToMidnight = (24 - h) * 3_600_000 - m * 60_000 - s * 1000;
  const ONE_MIN = 60_000;
  const TWENTY_FIVE_HOURS = 25 * 3_600_000;
  return Math.min(Math.max(msToMidnight, ONE_MIN), TWENTY_FIVE_HOURS);
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
    // Reset per-session notification flags so the next session gets its own
    // warn/limit notifications even if total (accumulated + new session) still
    // straddles the same thresholds — the operator wants to know when a fresh
    // session also ramps up spending, not only the first time it crosses today.
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
