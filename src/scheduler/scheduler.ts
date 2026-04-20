import { Cron } from "croner";
import { SchedulerDb } from "./db.js";
import type { Schedule, CreateScheduleParams, UpdateScheduleParams, SchedulerConfig, ScheduleRun } from "./types.js";

/**
 * Reject unknown timezones. Uses `Intl.DateTimeFormat`, which throws RangeError
 * for invalid IANA names but accepts canonical aliases like "UTC" that
 * `Intl.supportedValuesOf("timeZone")` doesn't enumerate.
 */
function validateTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Unknown timezone: ${tz}`);
  }
}

export class Scheduler {
  /** Cap how far back we look for missed fires on init. Avoids dumping
   * dozens of "morning standup" pings on the user after a long outage,
   * while still recovering from short crashes/restarts. */
  private static readonly CATCHUP_WINDOW_MS = 24 * 60 * 60 * 1000;

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
    this.runCatchUp();
    this.registerAllJobs();
  }

  /**
   * On startup, fire any schedule whose most recent expected run was missed
   * within the catch-up window. Only one catch-up fire per schedule — we
   * don't replay every missed minute of `* * * * *`. Schedules that haven't
   * been triggered yet use `created_at` as the reference point so a new
   * schedule registered while the daemon was down still gets caught up.
   */
  private runCatchUp(): void {
    const now = Date.now();
    const cutoff = now - Scheduler.CATCHUP_WINDOW_MS;
    for (const schedule of this.db.list()) {
      if (!schedule.enabled) continue;

      const refIso = schedule.last_triggered_at ?? schedule.created_at;
      const refMs = Date.parse(refIso);
      if (Number.isNaN(refMs)) continue;

      try {
        const cron = new Cron(schedule.cron, { timezone: schedule.timezone });
        const next = cron.nextRun(new Date(refMs));
        if (!next) continue;
        const nextMs = next.getTime();
        if (nextMs > now) continue;       // not yet due
        if (nextMs < cutoff) continue;    // too old, don't spam
        if (this.executing.has(schedule.id)) continue;
        this.runWithLock(schedule);
      } catch {
        // Bad cron expression or croner edge case — skip rather than crash init
        continue;
      }
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
