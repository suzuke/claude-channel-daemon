import { Cron } from "croner";
import { SchedulerDb } from "./db.js";
import type { Schedule, CreateScheduleParams, UpdateScheduleParams, SchedulerConfig, ScheduleRun } from "./types.js";

export class Scheduler {
  private db: SchedulerDb;
  private jobs: Map<string, Cron> = new Map();
  private onTrigger: (schedule: Schedule) => void;
  private config: SchedulerConfig;
  private isValidInstance: (name: string) => boolean;

  constructor(
    dbPath: string,
    onTrigger: (schedule: Schedule) => void,
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
    this.registerAllJobs();
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
    try {
      new Cron(params.cron, { timezone: params.timezone ?? this.config.default_timezone });
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
    if (params.cron !== undefined) {
      try {
        new Cron(params.cron, { timezone: this.db.get(id)?.timezone ?? this.config.default_timezone });
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
    this.onTrigger(schedule);
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
      if (current && current.enabled) {
        this.onTrigger(current);
      }
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
