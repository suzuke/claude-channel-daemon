import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProcessManager } from "../src/process-manager.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createLogger } from "../src/logger.js";

describe("ProcessManager", () => {
  let pm: ProcessManager;
  const logger = createLogger("silent");

  beforeEach(() => {
    pm = new ProcessManager(DEFAULT_CONFIG, logger);
  });

  afterEach(async () => {
    await pm.stop();
  });

  it("starts in stopped state", () => {
    expect(pm.isRunning()).toBe(false);
  });

  it("calculates exponential backoff correctly", () => {
    const delays = [0, 1, 2, 3, 4].map((i) => (pm as any).getBackoffDelay(i));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("caps backoff at 60 seconds", () => {
    const delay = (pm as any).getBackoffDelay(10);
    expect(delay).toBe(60000);
  });

  it("calculates linear backoff correctly", () => {
    const linearConfig = {
      ...DEFAULT_CONFIG,
      restart_policy: { ...DEFAULT_CONFIG.restart_policy, backoff: "linear" as const },
    };
    const linearPm = new ProcessManager(linearConfig, logger);
    const delays = [0, 1, 2].map((i) => (linearPm as any).getBackoffDelay(i));
    expect(delays).toEqual([1000, 2000, 3000]);
  });
});
