import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SchedulerDb } from "./db.js";

describe("SchedulerDb", () => {
  let dir: string;
  let db: SchedulerDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scheduler-test-"));
    db = new SchedulerDb(join(dir, "scheduler.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates tables on init", () => {
    const schedules = db.list();
    expect(schedules).toEqual([]);
  });

  it("creates and retrieves a schedule", () => {
    const s = db.create({
      cron: "0 7 * * *",
      message: "test message",
      source: "proj-a",
      target: "proj-a",
      reply_chat_id: "-100123",
      reply_thread_id: "42",
      label: "daily test",
      timezone: "Asia/Taipei",
    });

    expect(s.id).toBeTruthy();
    expect(s.cron).toBe("0 7 * * *");
    expect(s.enabled).toBe(true);

    const fetched = db.get(s.id);
    expect(fetched).toEqual(s);
  });

  it("lists schedules with optional target filter", () => {
    db.create({ cron: "0 7 * * *", message: "a", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    db.create({ cron: "0 8 * * *", message: "b", source: "a", target: "b", reply_chat_id: "1", reply_thread_id: null });

    expect(db.list()).toHaveLength(2);
    expect(db.list("a")).toHaveLength(1);
    expect(db.list("b")).toHaveLength(1);
  });

  it("updates a schedule", () => {
    const s = db.create({ cron: "0 7 * * *", message: "old", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    const updated = db.update(s.id, { message: "new", enabled: false });

    expect(updated.message).toBe("new");
    expect(updated.enabled).toBe(false);
    expect(updated.cron).toBe("0 7 * * *");
  });

  it("deletes a schedule and cascades runs", () => {
    const s = db.create({ cron: "0 7 * * *", message: "x", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    db.recordRun(s.id, "delivered");
    expect(db.getRuns(s.id)).toHaveLength(1);

    db.delete(s.id);
    expect(db.get(s.id)).toBeNull();
    expect(db.getRuns(s.id)).toHaveLength(0);
  });

  it("deleteByInstanceOrThread removes matching schedules", () => {
    db.create({ cron: "0 7 * * *", message: "a", source: "a", target: "proj-a", reply_chat_id: "1", reply_thread_id: "42" });
    db.create({ cron: "0 8 * * *", message: "b", source: "b", target: "proj-b", reply_chat_id: "1", reply_thread_id: "42" });
    db.create({ cron: "0 9 * * *", message: "c", source: "c", target: "proj-c", reply_chat_id: "1", reply_thread_id: "99" });

    const count = db.deleteByInstanceOrThread("proj-a", "42");
    expect(count).toBe(2);
    expect(db.list()).toHaveLength(1);
  });

  it("records and retrieves runs", () => {
    const s = db.create({ cron: "0 7 * * *", message: "x", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    db.recordRun(s.id, "delivered");
    db.recordRun(s.id, "instance_offline", "retry 3x failed");

    const runs = db.getRuns(s.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe("instance_offline");
    expect(runs[0].detail).toBe("retry 3x failed");
  });

  it("enforces max schedule count", () => {
    for (let i = 0; i < 5; i++) {
      db.create({ cron: "0 7 * * *", message: `m${i}`, source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    }
    expect(() =>
      db.create({ cron: "0 7 * * *", message: "over", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null }, 5)
    ).toThrow(/limit/i);
  });

  it("prunes old runs on init", () => {
    const s = db.create({ cron: "0 7 * * *", message: "x", source: "a", target: "a", reply_chat_id: "1", reply_thread_id: null });
    db["db"].prepare(
      "INSERT INTO schedule_runs (schedule_id, triggered_at, status) VALUES (?, datetime('now', '-60 days'), 'delivered')"
    ).run(s.id);
    db.recordRun(s.id, "delivered");

    db.pruneOldRuns();
    const runs = db.getRuns(s.id);
    expect(runs).toHaveLength(1);
  });
});
