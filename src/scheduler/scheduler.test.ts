import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "./scheduler.js";
import type { Schedule } from "./types.js";
import { DEFAULT_SCHEDULER_CONFIG } from "./types.js";

describe("Scheduler", () => {
  let dir: string;
  let scheduler: Scheduler;
  let triggered: Schedule[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scheduler-engine-test-"));
    triggered = [];
    scheduler = new Scheduler(
      join(dir, "scheduler.db"),
      (schedule) => { triggered.push(schedule); },
      DEFAULT_SCHEDULER_CONFIG,
      (instanceName: string) => true,
    );
    scheduler.init();
  });

  afterEach(() => {
    scheduler.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a schedule and registers cron job", () => {
    const s = scheduler.create({
      cron: "0 7 * * *",
      message: "hello",
      source: "proj-a",
      target: "proj-a",
      reply_chat_id: "1",
      reply_thread_id: null,
    });
    expect(s.id).toBeTruthy();
    expect(scheduler.list()).toHaveLength(1);
  });

  it("rejects invalid cron expression", () => {
    expect(() =>
      scheduler.create({
        cron: "not a cron",
        message: "hello",
        source: "a",
        target: "a",
        reply_chat_id: "1",
        reply_thread_id: null,
      })
    ).toThrow(/cron/i);
  });

  it("rejects invalid target instance", () => {
    const s2 = new Scheduler(
      join(dir, "scheduler2.db"),
      () => {},
      DEFAULT_SCHEDULER_CONFIG,
      (name: string) => name === "proj-a",
    );
    s2.init();
    expect(() =>
      s2.create({
        cron: "0 7 * * *",
        message: "hello",
        source: "proj-a",
        target: "nonexistent",
        reply_chat_id: "1",
        reply_thread_id: null,
      })
    ).toThrow(/not found/i);
    s2.shutdown();
  });

  it("manual trigger calls onTrigger callback", () => {
    const s = scheduler.create({
      cron: "0 7 * * *",
      message: "hello",
      source: "proj-a",
      target: "proj-a",
      reply_chat_id: "1",
      reply_thread_id: null,
    });
    scheduler.trigger(s.id);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].id).toBe(s.id);
  });

  it("delete removes schedule and cron job", () => {
    const s = scheduler.create({
      cron: "0 7 * * *",
      message: "hello",
      source: "a",
      target: "a",
      reply_chat_id: "1",
      reply_thread_id: null,
    });
    scheduler.delete(s.id);
    expect(scheduler.list()).toHaveLength(0);
  });

  it("update reschedules cron job", () => {
    const s = scheduler.create({
      cron: "0 7 * * *",
      message: "hello",
      source: "a",
      target: "a",
      reply_chat_id: "1",
      reply_thread_id: null,
    });
    const updated = scheduler.update(s.id, { cron: "0 8 * * *" });
    expect(updated.cron).toBe("0 8 * * *");
  });

  it("reload clears and re-registers all jobs", () => {
    scheduler.create({
      cron: "0 7 * * *",
      message: "hello",
      source: "a",
      target: "a",
      reply_chat_id: "1",
      reply_thread_id: null,
    });
    scheduler.reload();
    expect(scheduler.list()).toHaveLength(1);
  });

  it("deleteByInstanceOrThread cleans up and removes cron jobs", () => {
    scheduler.create({
      cron: "0 7 * * *",
      message: "a",
      source: "a",
      target: "proj-a",
      reply_chat_id: "1",
      reply_thread_id: "42",
    });
    const count = scheduler.deleteByInstanceOrThread("proj-a", "42");
    expect(count).toBe(1);
    expect(scheduler.list()).toHaveLength(0);
  });
});
