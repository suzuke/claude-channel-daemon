import { EventEmitter } from "node:events";
import {
  createServer,
  createConnection,
  Server,
  Socket,
} from "node:net";
import { unlinkSync, existsSync } from "node:fs";

function encode(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

function makeLineParser(onMessage: (msg: unknown) => void) {
  let buf = "";
  return (data: Buffer | string) => {
    buf += data.toString();
    const lines = buf.split("\n");
    // Last element is either empty string or an incomplete line
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // truly malformed JSON, skip
      }
      onMessage(msg);
    }
  };
}

export class IpcServer extends EventEmitter {
  private sockPath: string;
  private server: Server | null = null;
  private clients: Set<Socket> = new Set();
  private logger?: { warn(obj: unknown, msg?: string): void; debug(obj: unknown, msg?: string): void };

  constructor(sockPath: string, logger?: { warn(obj: unknown, msg?: string): void; debug(obj: unknown, msg?: string): void }) {
    super();
    this.sockPath = sockPath;
    this.logger = logger;
  }

  async listen(): Promise<void> {
    // Clean up stale socket file if it exists
    if (existsSync(this.sockPath)) {
      try {
        unlinkSync(this.sockPath);
      } catch {
        // Ignore if already gone — race with another process
      }
    }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.clients.add(socket);
        const parse = makeLineParser((msg) => {
          this.emit("message", msg, socket);
        });
        socket.on("data", parse);
        socket.on("close", () => {
          this.clients.delete(socket);
        });
        socket.on("error", (err) => {
          this.logger?.warn({ err }, "IPC client socket error, removing client");
          this.clients.delete(socket);
        });
      });

      this.server.on("error", reject);
      this.server.listen(this.sockPath, () => resolve());
    });
  }

  broadcast(msg: unknown): void {
    const data = encode(msg);
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(data);
      }
    }
  }

  send(socket: Socket, msg: unknown): void {
    if (!socket.destroyed) {
      socket.write(encode(msg));
    }
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        try {
          if (existsSync(this.sockPath)) {
            unlinkSync(this.sockPath);
          }
        } catch {
          // Best-effort socket file cleanup on shutdown
        }
        resolve();
      });
    });
  }
}

export class IpcClient extends EventEmitter {
  private sockPath: string;
  private socket: Socket | null = null;

  constructor(sockPath: string) {
    super();
    this.sockPath = sockPath;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.sockPath);
      this.socket = socket;

      const parse = makeLineParser((msg) => {
        this.emit("message", msg);
      });

      socket.on("data", parse);
      socket.on("error", (err) => {
        this.emit("disconnect", err);
      });
      socket.on("close", () => {
        this.emit("disconnect", new Error("socket closed"));
      });
      socket.once("error", reject);
      socket.once("connect", () => {
        // Remove the one-shot error handler used for connection failure
        socket.removeListener("error", reject);
        resolve();
      });
    });
  }

  get connected(): boolean {
    return this.socket != null && !this.socket.destroyed;
  }

  send(msg: unknown): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(encode(msg));
    }
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket || this.socket.destroyed) {
        resolve();
        return;
      }
      this.socket.once("close", resolve);
      this.socket.destroy();
    });
  }
}
