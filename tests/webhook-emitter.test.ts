import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { WebhookEmitter } from "../src/webhook-emitter.js";
import type { WebhookConfig } from "../src/types.js";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

class TestEmitter extends WebhookEmitter {
  public requests: CapturedRequest[] = [];
  /** Per-call response: status code, or "throw" to simulate network error. */
  public responses: Array<number | "throw"> = [];

  protected override async fetch(url: string, init: RequestInit): Promise<Response> {
    this.requests.push({ url, init });
    const r = this.responses.shift() ?? 200;
    if (r === "throw") throw new Error("ECONNRESET");
    return new Response(null, { status: r });
  }
}

const silentLogger = {
  info() {}, warn() {}, debug() {}, error() {}, fatal() {}, trace() {},
} as unknown as Parameters<typeof WebhookEmitter>[1];

const baseConfig: WebhookConfig = {
  url: "https://example.test/hook",
  events: ["*"],
};

describe("WebhookEmitter (P3.1)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("POSTs payload with delivery id and timestamp headers", async () => {
    const e = new TestEmitter([baseConfig], silentLogger);
    e.emit("cost_warning", "agent1", { cost_cents: 850 });
    await vi.runAllTimersAsync();

    expect(e.requests).toHaveLength(1);
    const req = e.requests[0];
    expect(req.url).toBe(baseConfig.url);
    const h = req.init.headers as Record<string, string>;
    expect(h["X-AgEnD-Delivery"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h["X-AgEnD-Timestamp"]).toMatch(/^\d+$/);
    // No signature when no secret configured
    expect(h["X-AgEnD-Signature"]).toBeUndefined();

    const body = JSON.parse(req.init.body as string);
    expect(body.event).toBe("cost_warning");
    expect(body.instance).toBe("agent1");
    expect(body.data).toEqual({ cost_cents: 850 });
  });

  it("signs body with HMAC-SHA256 over `${timestamp}.${body}` when secret set", async () => {
    const cfg: WebhookConfig = { ...baseConfig, secret: "shhh" };
    const e = new TestEmitter([cfg], silentLogger);
    e.emit("cost_limit", "agent1", {});
    await vi.runAllTimersAsync();

    const req = e.requests[0];
    const h = req.init.headers as Record<string, string>;
    const ts = h["X-AgEnD-Timestamp"];
    const body = req.init.body as string;
    const expected = "sha256=" + createHmac("sha256", "shhh").update(`${ts}.${body}`).digest("hex");
    expect(h["X-AgEnD-Signature"]).toBe(expected);
  });

  it("retries on 5xx, succeeds on third attempt, reuses delivery id", async () => {
    const e = new TestEmitter([baseConfig], silentLogger);
    e.responses = [500, 503, 200];
    e.emit("hang", "agent1", {});

    // Each retry waits via setTimeout — drain timers between attempts.
    await vi.runAllTimersAsync();

    expect(e.requests).toHaveLength(3);
    const ids = e.requests.map(r => (r.init.headers as Record<string, string>)["X-AgEnD-Delivery"]);
    expect(new Set(ids).size).toBe(1); // same delivery id across all attempts
  });

  it("retries on network error", async () => {
    const e = new TestEmitter([baseConfig], silentLogger);
    e.responses = ["throw", 200];
    e.emit("pty_error", "agent1", {});
    await vi.runAllTimersAsync();
    expect(e.requests).toHaveLength(2);
  });

  it("does NOT retry on 4xx (caller misconfig)", async () => {
    const e = new TestEmitter([baseConfig], silentLogger);
    e.responses = [400, 200, 200];
    e.emit("cost_warning", "agent1", {});
    await vi.runAllTimersAsync();
    expect(e.requests).toHaveLength(1); // bailed after the 4xx
  });

  it("gives up after 3 attempts on persistent failure", async () => {
    const e = new TestEmitter([baseConfig], silentLogger);
    e.responses = [502, 502, 502, 502]; // 4th never used
    e.emit("hang", "agent1", {});
    await vi.runAllTimersAsync();
    expect(e.requests).toHaveLength(3);
  });

  it("only delivers to webhooks subscribed to the event", async () => {
    const a: WebhookConfig = { url: "https://a.test/hook", events: ["cost_warning"] };
    const b: WebhookConfig = { url: "https://b.test/hook", events: ["hang"] };
    const c: WebhookConfig = { url: "https://c.test/hook", events: ["*"] };
    const e = new TestEmitter([a, b, c], silentLogger);
    e.emit("cost_warning", "agent1", {});
    await vi.runAllTimersAsync();
    const urls = e.requests.map(r => r.url).sort();
    expect(urls).toEqual(["https://a.test/hook", "https://c.test/hook"]);
  });
});
