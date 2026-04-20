import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ServerResponse, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { broadcastSseEvent, handleWebRequest, type WebApiContext } from "../src/web-api.js";

// ── Fake ServerResponse-shaped client for broadcastSseEvent ────────────────

interface FakeClient {
  written: string[];
  ended: boolean;
  failNext?: boolean;
  write(payload: string): boolean;
  end(): void;
}

function makeFakeClient(failNext = false): FakeClient {
  return {
    written: [],
    ended: false,
    failNext,
    write(payload: string) {
      if (this.failNext) throw new Error("EPIPE");
      this.written.push(payload);
      return true;
    },
    end() { this.ended = true; },
  };
}

describe("broadcastSseEvent", () => {
  it("writes one SSE frame to every healthy client", () => {
    const a = makeFakeClient();
    const b = makeFakeClient();
    const set = new Set([a, b] as unknown as Iterable<ServerResponse>);

    broadcastSseEvent(set as Set<ServerResponse>, "status", { ok: true });

    expect(a.written).toHaveLength(1);
    expect(a.written[0]).toContain("event: status");
    expect(a.written[0]).toContain('"ok":true');
    expect(b.written).toHaveLength(1);
  });

  it("evicts a client whose write throws and continues to the rest", () => {
    const dead = makeFakeClient(true);
    const alive = makeFakeClient();
    const set = new Set([dead, alive]) as unknown as Set<ServerResponse>;

    broadcastSseEvent(set, "status", { x: 1 });

    expect(set.has(dead as unknown as ServerResponse)).toBe(false);
    expect(set.has(alive as unknown as ServerResponse)).toBe(true);
    // Alive client still received the event despite the dead client throwing first
    expect(alive.written).toHaveLength(1);
    expect(dead.ended).toBe(true); // best-effort end()
  });

  it("invokes onError callback for each dead client (caller can log)", () => {
    const dead = makeFakeClient(true);
    const set = new Set([dead]) as unknown as Set<ServerResponse>;
    const onError = vi.fn();

    broadcastSseEvent(set, "status", {}, onError);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

// ── /ui/events handler cleanup test ───────────────────────────────────────

class CaptureRes extends ServerResponse {
  status = 0;
  headers: Record<string, string> = {};
  written: string[] = [];
  errorListeners: Array<(e: unknown) => void> = [];

  constructor(req: IncomingMessage) { super(req); }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    if (headers) this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }

  // Override addListener so we can verify the handler attaches an "error" listener
  on(event: string, fn: (e: unknown) => void): this {
    if (event === "error") this.errorListeners.push(fn);
    return super.on(event, fn);
  }
}

function makeReq(method: string, url: string): IncomingMessage & EventEmitter {
  const stream = Readable.from([]) as unknown as IncomingMessage & EventEmitter;
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

function makeSseCtx(sseClients: Set<ServerResponse>): WebApiContext {
  const scheduler = {
    db: {
      listTasks: () => [], createTask: () => ({}), updateTask: () => ({}),
      claimTask: () => ({}), completeTask: () => ({}),
    },
    list: () => [], create: () => ({}), delete: () => {},
  };
  return {
    webToken: null, dataDir: "/tmp", sseClients,
    fleetConfig: { channel: { group_id: 1 }, instances: {}, teams: {} },
    instanceIpcClients: new Map(), adapter: null, daemons: new Map(),
    eventLog: null,
    logger: { info() {}, debug() {}, error() {} },
    getInstanceDir: () => "/tmp",
    getInstanceStatus: () => "stopped" as const,
    getUiStatus: () => ({ ok: true }),
    emitSseEvent: () => {},
    startInstance: async () => {}, stopInstance: async () => {},
    restartSingleInstance: async () => {}, removeInstance: async () => {},
    lastInboundUser: new Map(),
    saveFleetConfig: () => {},
    lifecycle: { handleCreate: async () => {} },
    connectIpcToInstance: async () => {},
    scheduler,
  } as WebApiContext;
}

describe("/ui/events SSE handler cleanup", () => {
  it("removes client + clears interval on req close", () => {
    const sseClients = new Set<ServerResponse>();
    const ctx = makeSseCtx(sseClients);
    const req = makeReq("GET", "/ui/events");
    const res = new CaptureRes(req);

    handleWebRequest(req, res, new URL("http://localhost/ui/events"), ctx);

    expect(sseClients.has(res)).toBe(true);

    req.emit("close");

    expect(sseClients.has(res)).toBe(false);
  });

  it("removes client on req error (network reset, no clean FIN)", () => {
    const sseClients = new Set<ServerResponse>();
    const ctx = makeSseCtx(sseClients);
    const req = makeReq("GET", "/ui/events");
    const res = new CaptureRes(req);

    handleWebRequest(req, res, new URL("http://localhost/ui/events"), ctx);
    expect(sseClients.has(res)).toBe(true);

    req.emit("error", new Error("ECONNRESET"));

    expect(sseClients.has(res)).toBe(false);
  });

  it("cleanup is idempotent (close + error must not both fire side effects twice)", () => {
    const sseClients = new Set<ServerResponse>();
    const ctx = makeSseCtx(sseClients);
    const req = makeReq("GET", "/ui/events");
    const res = new CaptureRes(req);

    handleWebRequest(req, res, new URL("http://localhost/ui/events"), ctx);

    // Fire both — second one should be a no-op, not a double-delete + clearInterval(null)
    req.emit("error", new Error("x"));
    expect(() => req.emit("close")).not.toThrow();
    expect(sseClients.size).toBe(0);
  });
});
