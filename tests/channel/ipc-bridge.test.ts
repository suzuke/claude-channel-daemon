import { describe, it, expect, afterEach } from "vitest";
import { IpcServer, IpcClient } from "../../src/channel/ipc-bridge.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("IPC Bridge", () => {
  let tmpDir: string;
  let server: IpcServer;
  let client: IpcClient;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends messages from server to client", async () => {
    tmpDir = join(tmpdir(), `ccd-ipc-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const sockPath = join(tmpDir, "test.sock");

    server = new IpcServer(sockPath);
    await server.listen();

    const received: unknown[] = [];
    client = new IpcClient(sockPath);
    client.on("message", (msg) => received.push(msg));
    await client.connect();

    server.broadcast({ type: "inbound", text: "hello" });
    await new Promise(r => setTimeout(r, 100));
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ type: "inbound", text: "hello" });
  });

  it("sends messages from client to server", async () => {
    tmpDir = join(tmpdir(), `ccd-ipc-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const sockPath = join(tmpDir, "test.sock");

    server = new IpcServer(sockPath);
    const received: unknown[] = [];
    server.on("message", (msg) => received.push(msg));
    await server.listen();

    client = new IpcClient(sockPath);
    await client.connect();
    client.send({ type: "tool_call", tool: "reply" });
    await new Promise(r => setTimeout(r, 100));
    expect(received).toHaveLength(1);
    expect((received[0] as any).type).toBe("tool_call");
  });

  it("cleans up stale socket on start", async () => {
    tmpDir = join(tmpdir(), `ccd-ipc-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const sockPath = join(tmpDir, "test.sock");

    const server1 = new IpcServer(sockPath);
    await server1.listen();
    await server1.close();

    server = new IpcServer(sockPath);
    await server.listen();
    client = new IpcClient(sockPath);
    await client.connect(); // should work
  });

  it("drops client when a single line exceeds the 1 MB buffer cap", async () => {
    tmpDir = join(tmpdir(), `ccd-ipc-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const sockPath = join(tmpDir, "test.sock");

    server = new IpcServer(sockPath);
    const received: unknown[] = [];
    server.on("message", (msg) => received.push(msg));
    await server.listen();

    client = new IpcClient(sockPath);
    let disconnected = false;
    client.on("disconnect", () => { disconnected = true; });
    await client.connect();

    // Server-side: write a payload exceeding 1 MB on a single line (no \n)
    // to trigger the line-parser overflow path.
    const huge = "x".repeat(1_100_000);
    server.broadcast({ type: "evil", payload: huge });

    await new Promise(r => setTimeout(r, 200));
    expect(received).toHaveLength(0); // overflow before parse
    expect(disconnected).toBe(true);  // client socket destroyed
  });

  it("rejects socket path exceeding OS limit", async () => {
    tmpDir = join(tmpdir(), `ccd-ipc-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    // Create a path that exceeds 104 bytes (macOS sun_path limit)
    const longName = "a".repeat(120);
    const sockPath = join(tmpDir, `${longName}.sock`);

    server = new IpcServer(sockPath);
    await expect(server.listen()).rejects.toThrow(/socket path too long/i);
  });
});
