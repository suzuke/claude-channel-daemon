import { describe, it, expect, vi } from "vitest";
import { safeHandler } from "../src/safe-async.js";

function mockLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as any;
}

describe("safeHandler", () => {
  it("calls the wrapped function with arguments", () => {
    const logger = mockLogger();
    const fn = vi.fn();
    const wrapped = safeHandler(fn, logger, "test");
    wrapped("a", 1);
    expect(fn).toHaveBeenCalledWith("a", 1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("catches sync errors and logs them", () => {
    const logger = mockLogger();
    const fn = () => { throw new Error("sync boom"); };
    const wrapped = safeHandler(fn, logger, "sync-test");
    wrapped();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ context: "sync-test" }),
      "Unhandled error in sync handler",
    );
  });

  it("catches async rejections and logs them", async () => {
    const logger = mockLogger();
    const fn = async () => { throw new Error("async boom"); };
    const wrapped = safeHandler(fn, logger, "async-test");
    wrapped();
    // Wait for the microtask to resolve
    await new Promise(r => setTimeout(r, 10));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ context: "async-test" }),
      "Unhandled error in async handler",
    );
  });

  it("does not interfere with successful sync calls", () => {
    const logger = mockLogger();
    let called = false;
    const fn = () => { called = true; };
    const wrapped = safeHandler(fn, logger, "ok");
    wrapped();
    expect(called).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not interfere with successful async calls", async () => {
    const logger = mockLogger();
    let called = false;
    const fn = async () => { called = true; };
    const wrapped = safeHandler(fn, logger, "ok-async");
    wrapped();
    await new Promise(r => setTimeout(r, 10));
    expect(called).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
