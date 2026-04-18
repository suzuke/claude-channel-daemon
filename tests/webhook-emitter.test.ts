import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { WebhookEmitter } from "../src/webhook-emitter.js";
import type { WebhookConfig } from "../src/types.js";

const makeLogger = () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}) as never;

describe("WebhookEmitter (P3.1)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    // @ts-expect-error override
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("signs body with HMAC-SHA256 when secret is set", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const cfg: WebhookConfig = { url: "http://x/y", events: ["*"], secret: "s3cr3t" };
    const e = new WebhookEmitter([cfg], makeLogger());
    e.emit("test", "agent1", { k: "v" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [, init] = fetchMock.mock.calls[0];
    const sent = init.body as string;
    const expected = createHmac("sha256", "s3cr3t").update(sent).digest("hex");
    expect(init.headers["X-Agend-Signature"]).toBe(`sha256=${expected}`);
  });

  it("omits signature header when no secret is configured", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const cfg: WebhookConfig = { url: "http://x/y", events: ["*"] };
    const e = new WebhookEmitter([cfg], makeLogger());
    e.emit("test", "agent1");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-Agend-Signature"]).toBeUndefined();
  });

  it("retries on 5xx up to max_attempts and stops after success", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const cfg: WebhookConfig = { url: "http://x/y", events: ["*"], max_attempts: 3 };
    const e = new WebhookEmitter([cfg], makeLogger());
    e.emit("test", "agent1");
    // First attempt fires synchronously within the microtask queue
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx responses", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
    const cfg: WebhookConfig = { url: "http://x/y", events: ["*"], max_attempts: 3 };
    const e = new WebhookEmitter([cfg], makeLogger());
    e.emit("test", "agent1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps retries at max_attempts", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error("boom"));
    const cfg: WebhookConfig = { url: "http://x/y", events: ["*"], max_attempts: 2 };
    const e = new WebhookEmitter([cfg], makeLogger());
    e.emit("test", "agent1");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // No third attempt.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
