import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { CostGuard, msUntilMidnight } from "../src/cost-guard.js";
import { EventLog } from "../src/event-log.js";
import type { CostGuardConfig } from "../src/types.js";

const makeConfig = (overrides: Partial<CostGuardConfig> = {}): CostGuardConfig => ({
  daily_limit_usd: 10,
  warn_at_percentage: 80,
  timezone: "UTC",
  ...overrides,
});

describe("CostGuard", () => {
  let tmpDir: string;
  let eventLog: EventLog;
  let guard: CostGuard;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = join(tmpdir(), `ccd-cost-guard-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    eventLog = new EventLog(join(tmpDir, "events.db"));
    guard = new CostGuard(makeConfig(), eventLog);
  });

  afterEach(() => {
    guard.stop();
    eventLog.close();
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("tracks cost in cents", () => {
    guard.updateCost("agent1", 3.50);
    expect(guard.getDailyCostCents("agent1")).toBe(350);
  });

  it("accumulates across sessions (rotation)", () => {
    guard.updateCost("agent1", 3.50);
    guard.snapshotAndReset("agent1");
    guard.updateCost("agent1", 1.20);
    // 350 + 120 = 470
    expect(guard.getDailyCostCents("agent1")).toBe(470);
  });

  it("emits warn when threshold exceeded (85% of $10 = $8.50)", () => {
    const warnSpy = vi.fn();
    guard.on("warn", warnSpy);
    // 80% of $10 = $8.00 threshold; $8.50 > $8.00
    guard.updateCost("agent1", 8.50);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("agent1", 850, 1000);
  });

  it("emits limit when daily limit exceeded ($10.50 > $10)", () => {
    const limitSpy = vi.fn();
    guard.on("limit", limitSpy);
    guard.updateCost("agent1", 10.50);
    expect(limitSpy).toHaveBeenCalledTimes(1);
    expect(limitSpy).toHaveBeenCalledWith("agent1", 1050, 1000);
  });

  it("does not emit warn or limit when limit is 0 (disabled)", () => {
    const guardDisabled = new CostGuard(makeConfig({ daily_limit_usd: 0 }), eventLog);
    const warnSpy = vi.fn();
    const limitSpy = vi.fn();
    guardDisabled.on("warn", warnSpy);
    guardDisabled.on("limit", limitSpy);
    guardDisabled.updateCost("agent1", 999.99);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(limitSpy).not.toHaveBeenCalled();
    guardDisabled.stop();
  });

  it("resets at midnight (resetDaily clears everything)", () => {
    guard.updateCost("agent1", 5.00);
    guard.updateCost("agent2", 3.00);
    expect(guard.getDailyCostCents("agent1")).toBe(500);
    expect(guard.getDailyCostCents("agent2")).toBe(300);
    guard.resetDaily();
    expect(guard.getDailyCostCents("agent1")).toBe(0);
    expect(guard.getDailyCostCents("agent2")).toBe(0);
  });

  it("emits daily_reset event on resetDaily", () => {
    const resetSpy = vi.fn();
    guard.on("daily_reset", resetSpy);
    guard.resetDaily();
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  it("logs cost_snapshot event on snapshot", () => {
    guard.updateCost("agent1", 4.25);
    guard.snapshotAndReset("agent1");
    const events = eventLog.query({ instance: "agent1", type: "cost_snapshot" });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      session_cost_usd: 4.25,
      accumulated_cents: 425,
    });
  });

  it("returns fleet total across instances", () => {
    guard.updateCost("agent1", 3.00);
    guard.updateCost("agent2", 2.50);
    guard.updateCost("agent3", 1.00);
    // 300 + 250 + 100 = 650
    expect(guard.getFleetTotalCents()).toBe(650);
  });

  it("re-emits warn after rotation if new session crosses threshold (P2.2)", () => {
    const warnSpy = vi.fn();
    guard.on("warn", warnSpy);
    guard.updateCost("agent1", 8.50);        // total 850 → warn fires
    expect(warnSpy).toHaveBeenCalledTimes(1);
    guard.snapshotAndReset("agent1");        // accumulated 850, flags cleared
    guard.updateCost("agent1", 0.50);        // total 900 → warn fires again
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("re-emits limit after rotation if new session crosses limit (P2.2)", () => {
    const limitSpy = vi.fn();
    guard.on("limit", limitSpy);
    guard.updateCost("agent1", 10.50);       // total 1050 → limit fires
    expect(limitSpy).toHaveBeenCalledTimes(1);
    guard.snapshotAndReset("agent1");        // flags cleared
    guard.updateCost("agent1", 0.10);        // total 1060 → limit fires again
    expect(limitSpy).toHaveBeenCalledTimes(2);
  });

  it("does not emit warn/limit twice for the same day", () => {
    const warnSpy = vi.fn();
    const limitSpy = vi.fn();
    guard.on("warn", warnSpy);
    guard.on("limit", limitSpy);
    guard.updateCost("agent1", 8.50);
    guard.updateCost("agent1", 9.00);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    guard.updateCost("agent1", 10.50);
    guard.updateCost("agent1", 11.00);
    expect(limitSpy).toHaveBeenCalledTimes(1);
  });

  it("isLimited returns true when limit exceeded", () => {
    guard.updateCost("agent1", 10.01);
    expect(guard.isLimited("agent1")).toBe(true);
  });

  it("isLimited returns false when limit is 0 (disabled)", () => {
    const guardDisabled = new CostGuard(makeConfig({ daily_limit_usd: 0 }), eventLog);
    guardDisabled.updateCost("agent1", 999.99);
    expect(guardDisabled.isLimited("agent1")).toBe(false);
    guardDisabled.stop();
  });

  it("schedules midnight reset via startMidnightReset", () => {
    const resetSpy = vi.fn();
    guard.on("daily_reset", resetSpy);
    guard.startMidnightReset();
    // Advance past 24 hours to ensure midnight fires
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    expect(resetSpy).toHaveBeenCalled();
    guard.stop();
  });
});

describe("msUntilMidnight (P2.8 DST-safe)", () => {
  const ONE_MIN = 60_000;
  const TWENTY_FIVE_HOURS = 25 * 3_600_000;

  it("returns a value in [1min, 25h] for UTC", () => {
    const v = msUntilMidnight("UTC");
    expect(v).toBeGreaterThanOrEqual(ONE_MIN);
    expect(v).toBeLessThanOrEqual(TWENTY_FIVE_HOURS);
  });

  it("returns a value in [1min, 25h] for America/New_York (DST zone)", () => {
    const v = msUntilMidnight("America/New_York");
    expect(v).toBeGreaterThanOrEqual(ONE_MIN);
    expect(v).toBeLessThanOrEqual(TWENTY_FIVE_HOURS);
  });

  it("returns a value in [1min, 25h] for Asia/Taipei (no DST)", () => {
    const v = msUntilMidnight("Asia/Taipei");
    expect(v).toBeGreaterThanOrEqual(ONE_MIN);
    expect(v).toBeLessThanOrEqual(TWENTY_FIVE_HOURS);
  });

  it("returns values that differ across timezones by no more than 24h", () => {
    const a = msUntilMidnight("UTC");
    const b = msUntilMidnight("Asia/Taipei");
    expect(Math.abs(a - b)).toBeLessThanOrEqual(24 * 3_600_000);
  });
});
