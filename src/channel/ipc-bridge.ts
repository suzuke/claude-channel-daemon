import { EventEmitter } from "node:events";
import {
  createServer,
  createConnection,
  Server,
  Socket,
} from "node:net";
import { unlinkSync, existsSync, chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";

// macOS sun_path limit is 104 bytes; Linux is 108
const UNIX_SOCKET_PATH_MAX = process.platform === "darwin" ? 104 : 108;

function encode(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

// 1 MB is well above any legitimate IPC payload (tool calls/responses,
// schedule/decision/task lists). The previous 10 MB ceiling was loose
// DoS protection — a runaway producer could buffer 10 MB per client
// before being dropped.
const MAX_LINE_BUFFER = 1 * 1024 * 1024;

function makeLineParser(onMessage: (msg: unknown) => void, onOverflow?: () => void) {
  let buf = "";
  return (data: Buffer | string) => {
    buf += data.toString();
    if (buf.length > MAX_LINE_BUFFER) {
      buf = "";
      onOverflow?.();
      return;
    }
    const lines = buf.split("\n");
    // Last element is either empty string or an incomplete line
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // truly malformed JSON, skip this line
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
    // Fail fast if socket path exceeds OS limit (macOS: 104, Linux: 108)
    const pathLen = Buffer.byteLength(this.sockPath, "utf-8");
    if (pathLen >= UNIX_SOCKET_PATH_MAX) {
      throw new Error(
        `IPC socket path too long (${pathLen} bytes, max ${UNIX_SOCKET_PATH_MAX - 1}): ${this.sockPath}`
      );
    }

    // Clean up stale socket file if it exists
    if (existsSync(this.sockPath)) {
      try {
        unlinkSync(this.sockPath);
      } catch {
        // Ignore if already gone — race with another process
      }
    }

    // Warn if parent directory is world-readable
    try {
      const parentDir = dirname(this.sockPath);
      const parentMode = statSync(parentDir).mode & 0o777;
      if (parentMode & 0o007) {
        this.logger?.warn({ dir: parentDir, mode: `0o${parentMode.toString(8)}` },
          "IPC socket parent directory is world-accessible");
      }
    } catch { /* stat may fail on some systems */ }

    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.acceptClient(socket);
      });

      // Set restrictive umask before listen to prevent TOCTOU race
      // (socket is created with 0o600 permissions atomically)
      const prevUmask = process.umask(0o077);
      let umaskRestored = false;
      const restoreUmask = () => {
        if (!umaskRestored) { umaskRestored = true; process.umask(prevUmask); }
      };

      const startupErrorHandler = (err: Error) => {
        restoreUmask();
        reject(err);
      };
      this.server.on("error", startupErrorHandler);

      this.server.listen(this.sockPath, () => {
        restoreUmask();
        // Belt-and-suspenders: also chmod in case umask was ineffective
        try {
          chmodSync(this.sockPath, 0o600);
        } catch (err) {
          this.logger?.warn({ err, sockPath: this.sockPath }, "Failed to chmod IPC socket");
        }

        // Replace the startup error handler with a persistent one that
        // logs but does NOT crash the process (prevents unhandled 'error' events)
        this.server!.removeListener("error", startupErrorHandler);
        this.server!.on("error", (err) => {
          this.logger?.warn({ err, sockPath: this.sockPath }, "IPC server error (post-listen)");
          this.emit("error", err);
        });

        resolve();
      });
    });
  }

  private acceptClient(socket: Socket): void {
    this.clients.add(socket);
    const parse = makeLineParser((msg) => {
      this.emit("message", msg, socket);
    }, () => {
      this.logger?.warn("IPC buffer overflow, dropping client");
      socket.destroy();
      this.clients.delete(socket);
    });
    socket.on("data", parse);
    socket.on("close", () => {
      this.clients.delete(socket);
    });
    socket.on("error", (err) => {
      this.logger?.warn({ err }, "IPC client socket error, removing client");
      this.clients.delete(socket);
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
      }, () => {
        this.emit("overflow");
        socket.destroy();
        this.emit("disconnect", new Error("IPC buffer overflow"));
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
