import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContextGuardian } from "../src/context-guardian.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createLogger } from "../src/logger.js";

describe("ContextGuardian", () => {
  const logger = createLogger("silent");
  let guardian: ContextGuardian;

  beforeEach(() => {
    vi.useFakeTimers();
    guardian = new ContextGuardian(DEFAULT_CONFIG.context_guardian, logger);
  });

  afterEach(() => {
    guardian.stop();
    vi.useRealTimers();
  });

  it("triggers rotation when usage exceeds threshold", () => {
    const rotateSpy = vi.fn();
    guardian.on("rotate", rotateSpy);

    guardian.updateContextStatus({
      used_percentage: 85,
      remaining_percentage: 15,
      context_window_size: 200000,
    });

    expect(rotateSpy).toHaveBeenCalledTimes(1);
  });

  it("does not trigger rotation below threshold", () => {
    const rotateSpy = vi.fn();
    guardian.on("rotate", rotateSpy);

    guardian.updateContextStatus({
      used_percentage: 50,
      remaining_percentage: 50,
      context_window_size: 200000,
    });

    expect(rotateSpy).not.toHaveBeenCalled();
  });

  it("triggers timer-based rotation after max_age_hours", () => {
    const rotateSpy = vi.fn();
    guardian.on("rotate", rotateSpy);
    guardian.startTimer();

    vi.advanceTimersByTime(4 * 60 * 60 * 1000); // 4 hours

    expect(rotateSpy).toHaveBeenCalledTimes(1);
  });

  it("parses status line JSON from stdout", () => {
    const status = guardian.parseStatusLine(
      '{"context_window":{"used_percentage":42,"remaining_percentage":58,"context_window_size":200000}}'
    );
    expect(status).toEqual({
      used_percentage: 42,
      remaining_percentage: 58,
      context_window_size: 200000,
    });
  });

  it("returns null for non-JSON stdout", () => {
    const status = guardian.parseStatusLine("some random output");
    expect(status).toBeNull();
  });

  it("parses TUI status bar format", () => {
    const status = guardian.parseStatusLine(
      " Opus 4.6 1M | 󰉋 blog | 󰊢 main ● |  15.1% · 151.5k tokens"
    );
    expect(status).toEqual({
      used_percentage: 15.1,
      remaining_percentage: 84.9,
      context_window_size: 200000,
    });
  });

  it("parses TUI status bar with high usage", () => {
    const status = guardian.parseStatusLine("82.3% · 164.6k tokens");
    expect(status).not.toBeNull();
    expect(status!.used_percentage).toBe(82.3);
    expect(status!.remaining_percentage).toBeCloseTo(17.7);
    expect(status!.context_window_size).toBe(200000);
  });
});
