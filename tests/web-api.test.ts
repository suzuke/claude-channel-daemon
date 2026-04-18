import { describe, it, expect, beforeEach } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { handleWebRequest, type WebApiContext } from "../src/web-api.js";

// Minimal mock ServerResponse that captures status + body.
class CaptureRes extends ServerResponse {
  status = 0;
  body = "";
  constructor(req: IncomingMessage) {
    super(req);
  }
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  end(chunk?: unknown): this {
    if (chunk) this.body += String(chunk);
    return this;
  }
}

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const raw = body ? JSON.stringify(body) : "";
  const stream = Readable.from(raw ? [raw] : []);
  // Cast via IncomingMessage — tests only rely on method/url/body stream.
  const req = stream as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

function makeCtx(overrides: Partial<WebApiContext> = {}): WebApiContext {
  const scheduler = {
    db: {
      listTasks: () => [],
      createTask: (p: { title: string }) => ({ id: "t1", ...p }),
      updateTask: (id: string, p: Record<string, unknown>) => ({ id, ...p }),
      claimTask: (id: string, a: string) => ({ id, assignee: a }),
      completeTask: (id: string, r?: string) => ({ id, result: r }),
    },
    list: () => [],
    create: (p: unknown) => ({ id: "s1", ...(p as object) }),
    delete: () => {},
  };
  return {
    webToken: null,
    dataDir: "/tmp",
    sseClients: new Set(),
    fleetConfig: { channel: { group_id: 1 }, instances: {}, teams: {} },
    instanceIpcClients: new Map(),
    adapter: null,
    daemons: new Map(),
    eventLog: null,
    logger: { info() {}, debug() {}, error() {} },
    getInstanceDir: () => "/tmp",
    getInstanceStatus: () => "stopped" as const,
    getUiStatus: () => ({}),
    emitSseEvent: () => {},
    startInstance: async () => {},
    stopInstance: async () => {},
    restartSingleInstance: async () => {},
    removeInstance: async () => {},
    lastInboundUser: new Map(),
    saveFleetConfig: () => {},
    lifecycle: { handleCreate: async () => {} },
    connectIpcToInstance: async () => {},
    scheduler,
    ...overrides,
  } as WebApiContext;
}

async function callAndWait(
  method: string,
  url: string,
  body: unknown,
  ctx: WebApiContext,
): Promise<CaptureRes> {
  const req = makeReq(method, url, body);
  const res = new CaptureRes(req);
  const urlObj = new URL(url, "http://localhost");
  // Append token query so auth passes (test sets webToken=null, and handler
  // compares with `!==`, so we need to leave token unset AND webToken null).
  handleWebRequest(req, res, urlObj, ctx);
  // Let the async handler resolve (parseBody reads from the stream).
  for (let i = 0; i < 20; i++) {
    if (res.status !== 0) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return res;
}

describe("web-api zod validation", () => {
  let ctx: WebApiContext;
  beforeEach(() => { ctx = makeCtx(); });

  it("POST /ui/tasks rejects missing title", async () => {
    const res = await callAndWait("POST", "/ui/tasks", { description: "x" }, ctx);
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/title/);
  });

  it("POST /ui/tasks rejects unknown field", async () => {
    const res = await callAndWait(
      "POST",
      "/ui/tasks",
      { title: "ok", admin: true },
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("POST /ui/tasks accepts valid payload", async () => {
    const res = await callAndWait("POST", "/ui/tasks", { title: "ok" }, ctx);
    expect(res.status).toBe(200);
  });

  it("POST /ui/schedules rejects payload missing cron", async () => {
    const res = await callAndWait(
      "POST",
      "/ui/schedules",
      { message: "m", target: "t" },
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("POST /ui/teams rejects invalid name", async () => {
    const res = await callAndWait(
      "POST",
      "/ui/teams",
      { name: "a b;rm -rf /", members: ["u1"] },
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("POST /ui/config rejects unknown top-level field", async () => {
    const res = await callAndWait(
      "POST",
      "/ui/config",
      { hacked: true },
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
