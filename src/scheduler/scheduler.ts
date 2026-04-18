import { Cron } from "croner";
import { SchedulerDb } from "./db.js";
import { validateTimezone as sharedValidateTimezone } from "../config.js";
import type { Schedule, CreateScheduleParams, UpdateScheduleParams, SchedulerConfig, ScheduleRun } from "./types.js";

/** Thin wrapper over the shared validator to preserve this module's error prefix. */
function validateTimezone(tz: string): void {
  sharedValidateTimezone(tz, "timezone");
}

export class Scheduler {
  readonly db: SchedulerDb;
  private jobs: Map<string, Cron> = new Map();
  private onTrigger: (schedule: Schedule) => void | Promise<void>;
  private config: SchedulerConfig;
  private isValidInstance: (name: string) => boolean;
  /** IDs of schedules whose onTrigger is currently in flight; guards against
   * a manual trigger and a cron firing (or two cron fires) overlapping. */
  private executing = new Set<string>();

  constructor(
    dbPath: string,
    onTrigger: (schedule: Schedule) => void | Promise<void>,
    config: SchedulerConfig,
    isValidInstance: (name: string) => boolean,
  ) {
    this.db = new SchedulerDb(dbPath);
    this.onTrigger = onTrigger;
    this.config = config;
    this.isValidInstance = isValidInstance;
  }

  init(): void {
    this.db.pruneOldRuns();
    this.catchUpMissedRuns();
    this.registerAllJobs();
  }

  /**
   * On startup, fire any schedule whose most recent expected cron time is
   * within `catchup_window_minutes` and newer than last_triggered_at. This
   * covers daemon downtime (crash, reboot) without triggering stale fires
   * from long outages or fresh schedules (which have no last_triggered_at).
   */
  private catchUpMissedRuns(): void {
    const windowMin = this.config.catchup_window_minutes ?? 0;
    if (windowMin <= 0) return;
    const now = Date.now();
    const maxAgeMs = windowMin * 60_000;
    for (const schedule of this.db.list()) {
      if (!schedule.enabled) continue;
      // Never triggered before = fresh schedule, don't fire catch-up at install time.
      if (!schedule.last_triggered_at) continue;
      let prev: Date | undefined;
      try {
        const [firstPrev] = new Cron(schedule.cron, { timezone: schedule.timezone })
          .previousRuns(1, new Date(now));
        prev = firstPrev;
      } catch {
        continue;
      }
      if (!prev) continue;
      const prevMs = prev.getTime();
      const lastTriggeredMs = Date.parse(schedule.last_triggered_at);
      if (!Number.isFinite(lastTriggeredMs)) continue;
      if (prevMs <= lastTriggeredMs) continue;  // already ran at/after the last expected fire
      if (now - prevMs > maxAgeMs) continue;    // too stale to be useful
      // Defer to next tick so callers don't hit onTrigger before init() returns.
      setImmediate(() => this.runWithLock(schedule));
    }
  }

  reload(): void {
    this.stopAllJobs();
    this.registerAllJobs();
  }

  shutdown(): void {
    this.stopAllJobs();
    this.db.close();
  }

  create(params: CreateScheduleParams): Schedule {
    const tz = params.timezone ?? this.config.default_timezone;
    validateTimezone(tz);
    try {
      new Cron(params.cron, { timezone: tz });
    } catch (err) {
      throw new Error(`Invalid cron expression: ${(err as Error).message}`);
    }

    if (!this.isValidInstance(params.target)) {
      throw new Error(`Instance "${params.target}" not found in fleet config.`);
    }

    const schedule = this.db.create(params, this.config.max_schedules);
    this.registerJob(schedule);
    return schedule;
  }

  list(target?: string): Schedule[] {
    return this.db.list(target);
  }

  get(id: string): Schedule | null {
    return this.db.get(id);
  }

  update(id: string, params: UpdateScheduleParams): Schedule {
    if (params.timezone !== undefined) {
      validateTimezone(params.timezone);
    }
    if (params.cron !== undefined) {
      try {
        new Cron(params.cron, { timezone: params.timezone ?? this.db.get(id)?.timezone ?? this.config.default_timezone });
      } catch (err) {
        throw new Error(`Invalid cron expression: ${(err as Error).message}`);
      }
    }

    if (params.target !== undefined && !this.isValidInstance(params.target)) {
      throw new Error(`Instance "${params.target}" not found in fleet config.`);
    }

    const updated = this.db.update(id, params);
    this.stopJob(id);
    if (updated.enabled) {
      this.registerJob(updated);
    }
    return updated;
  }

  delete(id: string): void {
    this.stopJob(id);
    this.db.delete(id);
  }

  trigger(id: string): void {
    const schedule = this.db.get(id);
    if (!schedule) throw new Error(`Schedule "${id}" not found.`);
    if (this.executing.has(id)) {
      throw new Error(`Schedule "${id}" is already running.`);
    }
    this.runWithLock(schedule);
  }

  /** Invoke onTrigger while holding the per-schedule lock. Cleans up when
   * the callback returns synchronously, throws, or settles a returned Promise. */
  private runWithLock(schedule: Schedule): void {
    this.executing.add(schedule.id);
    let result: void | Promise<void>;
    try {
      result = this.onTrigger(schedule);
    } catch (err) {
      this.executing.delete(schedule.id);
      throw err;
    }
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).finally(() => this.executing.delete(schedule.id));
    } else {
      this.executing.delete(schedule.id);
    }
  }

  deleteByInstanceOrThread(instanceName: string, threadId: string): number {
    const affected = this.db.list().filter(
      (s) => s.target === instanceName || s.reply_thread_id === threadId,
    );
    for (const s of affected) {
      this.stopJob(s.id);
    }
    return this.db.deleteByInstanceOrThread(instanceName, threadId);
  }

  recordRun(scheduleId: string, status: string, detail?: string): void {
    this.db.recordRun(scheduleId, status, detail);
  }

  getRuns(scheduleId: string, limit?: number): ScheduleRun[] {
    return this.db.getRuns(scheduleId, limit);
  }

  private registerAllJobs(): void {
    for (const schedule of this.db.list()) {
      if (schedule.enabled) {
        this.registerJob(schedule);
      }
    }
  }

  private registerJob(schedule: Schedule): void {
    const job = new Cron(schedule.cron, { timezone: schedule.timezone }, () => {
      const current = this.db.get(schedule.id);
      if (!current || !current.enabled) return;
      // Skip if a previous fire (or manual trigger) is still in flight —
      // avoids overlapping runs of the same schedule.
      if (this.executing.has(current.id)) return;
      this.runWithLock(current);
    });
    this.jobs.set(schedule.id, job);
  }

  private stopJob(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.stop();
      this.jobs.delete(id);
    }
  }

  private stopAllJobs(): void {
    for (const [, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
  }
}
