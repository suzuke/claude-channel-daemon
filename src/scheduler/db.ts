import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Schedule, ScheduleRun, CreateScheduleParams, UpdateScheduleParams } from "./types.js";

export class SchedulerDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id              TEXT PRIMARY KEY,
        cron            TEXT NOT NULL,
        message         TEXT NOT NULL,
        source          TEXT NOT NULL,
        target          TEXT NOT NULL,
        reply_chat_id   TEXT NOT NULL,
        reply_thread_id TEXT,
        label           TEXT,
        enabled         INTEGER DEFAULT 1,
        timezone        TEXT DEFAULT 'Asia/Taipei',
        created_at      TEXT NOT NULL,
        last_triggered_at TEXT,
        last_status     TEXT
      );
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
        status      TEXT NOT NULL,
        detail      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id ON schedule_runs(schedule_id);
    `);
  }

  private rowToSchedule(row: Record<string, unknown>): Schedule {
    return {
      id: row.id as string,
      cron: row.cron as string,
      message: row.message as string,
      source: row.source as string,
      target: row.target as string,
      reply_chat_id: row.reply_chat_id as string,
      reply_thread_id: row.reply_thread_id as string | null,
      label: row.label as string | null,
      enabled: row.enabled === 1,
      timezone: row.timezone as string,
      created_at: row.created_at as string,
      last_triggered_at: row.last_triggered_at as string | null,
      last_status: row.last_status as string | null,
    };
  }

  create(params: CreateScheduleParams, maxSchedules = 100): Schedule {
    const count = this.db.prepare("SELECT COUNT(*) as c FROM schedules").get() as { c: number };
    if (count.c >= maxSchedules) {
      throw new Error(`Schedule limit reached (${maxSchedules}). Delete existing schedules first.`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO schedules (id, cron, message, source, target, reply_chat_id, reply_thread_id, label, timezone, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, params.cron, params.message, params.source, params.target, params.reply_chat_id, params.reply_thread_id, params.label ?? null, params.timezone ?? "Asia/Taipei", now);

    return this.get(id)!;
  }

  get(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSchedule(row) : null;
  }

  list(target?: string): Schedule[] {
    const rows = target
      ? this.db.prepare("SELECT * FROM schedules WHERE target = ? ORDER BY created_at").all(target) as Record<string, unknown>[]
      : this.db.prepare("SELECT * FROM schedules ORDER BY created_at").all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToSchedule(r));
  }

  update(id: string, params: UpdateScheduleParams): Schedule {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (params.cron !== undefined) { sets.push("cron = ?"); values.push(params.cron); }
    if (params.message !== undefined) { sets.push("message = ?"); values.push(params.message); }
    if (params.target !== undefined) { sets.push("target = ?"); values.push(params.target); }
    if (params.label !== undefined) { sets.push("label = ?"); values.push(params.label); }
    if (params.timezone !== undefined) { sets.push("timezone = ?"); values.push(params.timezone); }
    if (params.enabled !== undefined) { sets.push("enabled = ?"); values.push(params.enabled ? 1 : 0); }

    if (sets.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }

    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  deleteByInstanceOrThread(instanceName: string, threadId: string): number {
    const result = this.db.prepare("DELETE FROM schedules WHERE target = ? OR reply_thread_id = ?").run(instanceName, threadId);
    return result.changes;
  }

  recordRun(scheduleId: string, status: string, detail?: string): void {
    this.db.prepare("INSERT INTO schedule_runs (schedule_id, status, detail) VALUES (?, ?, ?)").run(scheduleId, status, detail ?? null);
    this.db.prepare("UPDATE schedules SET last_triggered_at = datetime('now'), last_status = ? WHERE id = ?").run(status, scheduleId);
  }

  getRuns(scheduleId: string, limit = 50): ScheduleRun[] {
    return this.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY triggered_at DESC, id DESC LIMIT ?").all(scheduleId, limit) as ScheduleRun[];
  }

  pruneOldRuns(days = 30): void {
    this.db.prepare("DELETE FROM schedule_runs WHERE triggered_at < datetime('now', '-' || ? || ' days')").run(days);
  }

  close(): void {
    this.db.close();
  }
}
