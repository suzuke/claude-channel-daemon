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
});
