import { describe, it, expect, vi } from "vitest";
import { makeLineParser, __getMaxLineBuffer } from "../src/channel/ipc-bridge.js";

describe("IPC line parser (P3.7)", () => {
  it("defaults MAX_LINE_BUFFER to 1 MB (unless AGEND_IPC_MAX_LINE_MB overrides)", () => {
    // This matches the compiled-in default; overrides happen at module load time
    // via env var, so here we only assert the sane bound.
    const max = __getMaxLineBuffer();
    expect(max).toBeGreaterThanOrEqual(1 * 1024 * 1024);
    // Should not exceed 100 MB in any reasonable configuration.
    expect(max).toBeLessThanOrEqual(100 * 1024 * 1024);
  });

  it("emits parsed messages on newline-delimited input", () => {
    const onMessage = vi.fn();
    const parse = makeLineParser(onMessage);
    parse('{"a":1}\n{"b":2}\n');
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(1, { a: 1 });
    expect(onMessage).toHaveBeenNthCalledWith(2, { b: 2 });
  });

  it("calls onOverflow and drops the buffer when input exceeds the cap", () => {
    const onMessage = vi.fn();
    const onOverflow = vi.fn();
    const parse = makeLineParser(onMessage, onOverflow);
    const big = "x".repeat(__getMaxLineBuffer() + 1);
    parse(big);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("recovers after overflow — subsequent valid messages parse normally", () => {
    const onMessage = vi.fn();
    const onOverflow = vi.fn();
    const parse = makeLineParser(onMessage, onOverflow);
    parse("x".repeat(__getMaxLineBuffer() + 1));
    parse('{"ok":true}\n');
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ ok: true });
  });

  it("tolerates malformed JSON on individual lines", () => {
    const onMessage = vi.fn();
    const parse = makeLineParser(onMessage);
    parse('not-json\n{"good":1}\n');
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ good: 1 });
  });
});
