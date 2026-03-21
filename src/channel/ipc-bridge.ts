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
      try {
        onMessage(JSON.parse(line));
      } catch {
        // Ignore malformed lines
      }
    }
  };
}

export class IpcServer extends EventEmitter {
  private sockPath: string;
  private server: Server | null = null;
  private clients: Set<Socket> = new Set();

  constructor(sockPath: string) {
    super();
    this.sockPath = sockPath;
  }

  async listen(): Promise<void> {
    // Clean up stale socket file if it exists
    if (existsSync(this.sockPath)) {
      try {
        unlinkSync(this.sockPath);
      } catch {
        // Ignore if already gone
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
        socket.on("error", () => {
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
          // Ignore cleanup errors
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
      socket.on("error", reject);
      socket.once("connect", resolve);
    });
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
