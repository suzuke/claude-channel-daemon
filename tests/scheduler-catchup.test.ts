import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { DEFAULT_SCHEDULER_CONFIG, type Schedule } from "../src/scheduler/types.js";

/**
 * Seed last_triggered_at directly via raw sqlite — Scheduler/SchedulerDb
 * only update it through recordRun(datetime('now')), so to simulate a
 * missed-fire scenario we have to backdate the row ourselves.
 */
function setLastTriggered(dbPath: string, id: string, iso: string | null): void {
  const raw = new Database(dbPath);
  raw.prepare("UPDATE schedules SET last_triggered_at = ? WHERE id = ?").run(iso, id);
  raw.close();
}

function setCreatedAt(dbPath: string, id: string, iso: string): void {
  const raw = new Database(dbPath);
  raw.prepare("UPDATE schedules SET created_at = ? WHERE id = ?").run(iso, id);
  raw.close();
}

function setEnabled(dbPath: string, id: string, enabled: boolean): void {
  const raw = new Database(dbPath);
  raw.prepare("UPDATE schedules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  raw.close();
}

describe("Scheduler — catch-up on init", () => {
  let tmpDir: string;
  let dbPath: string;
  let fired: Schedule[];
  let scheduler: Scheduler | null;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sched-catchup-${Date.now()}-${Math.random()}`);
    mkdirSync(tmpDir, { recursive: true });
    dbPath = join(tmpDir, "scheduler.db");
    fired = [];
    scheduler = null;
  });

  afterEach(() => {
    scheduler?.shutdown();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeScheduler(): Scheduler {
    return new Scheduler(
      dbPath,
      (s) => { fired.push(s); },
      DEFAULT_SCHEDULER_CONFIG,
      () => true,
    );
  }

  function createSchedule(cron: string): Schedule {
    const seed = makeScheduler();
    const s = seed.create({
      cron,
      message: "ping",
      source: "test",
      target: "general",
      reply_chat_id: "chat-1",
      reply_thread_id: null,
    });
    seed.shutdown();
    return s;
  }

  it("fires once for a schedule whose expected run was missed within the window", () => {
    const s = createSchedule("* * * * *"); // every minute
    // Last fire was 5 minutes ago → next expected ~4 minutes ago → missed
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    setLastTriggered(dbPath, s.id, fiveMinAgo);

    scheduler = makeScheduler();
    scheduler.init();

    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe(s.id);
  });

  it("does NOT fire if the missed run is older than the 24h catch-up window", () => {
    const s = createSchedule("0 9 * * *"); // 9am daily
    // Last fire was 3 days ago → next expected 2 days ago → way past 24h
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    setLastTriggered(dbPath, s.id, threeDaysAgo);

    scheduler = makeScheduler();
    scheduler.init();

    expect(fired).toHaveLength(0);
  });

  it("does NOT fire if the next expected run is still in the future", () => {
    const s = createSchedule("0 9 * * *"); // 9am daily
    // Last fire was just now → next expected tomorrow 9am → not due
    setLastTriggered(dbPath, s.id, new Date().toISOString());

    scheduler = makeScheduler();
    scheduler.init();

    expect(fired).toHaveLength(0);
  });

  it("skips disabled schedules", () => {
    const s = createSchedule("* * * * *");
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    setLastTriggered(dbPath, s.id, fiveMinAgo);
    setEnabled(dbPath, s.id, false);

    scheduler = makeScheduler();
    scheduler.init();

    expect(fired).toHaveLength(0);
  });

  it("uses created_at when last_triggered_at is null", () => {
    const s = createSchedule("* * * * *");
    // Never triggered; backdate creation by 5 minutes
    setLastTriggered(dbPath, s.id, null);
    setCreatedAt(dbPath, s.id, new Date(Date.now() - 5 * 60 * 1000).toISOString());

    scheduler = makeScheduler();
    scheduler.init();

    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe(s.id);
  });

  it("fires at most once per schedule, even when many minutes were missed", () => {
    const s = createSchedule("* * * * *"); // every minute
    // Last fire was 60 minutes ago → 59 minute fires were missed
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    setLastTriggered(dbPath, s.id, hourAgo);

    scheduler = makeScheduler();
    scheduler.init();

    expect(fired).toHaveLength(1);
  });
});
