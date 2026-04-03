import pino from "pino";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, statSync, readFileSync, writeFileSync } from "node:fs";

const DATA_DIR = join(homedir(), ".agend");
const LOG_FILE = join(DATA_DIR, "daemon.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const TRUNCATE_TO = 5 * 1024 * 1024; // keep last 5 MB

/** Truncate log to tail when it exceeds MAX_LOG_SIZE (no rotation/backup files) */
function truncateLogIfNeeded(logPath: string): void {
  try {
    const stat = statSync(logPath);
    if (stat.size < MAX_LOG_SIZE) return;

    const buf = readFileSync(logPath);
    const tail = buf.subarray(buf.length - TRUNCATE_TO);
    const nl = tail.indexOf(0x0a);
    writeFileSync(logPath, nl >= 0 ? tail.subarray(nl + 1) : tail);
  } catch { /* file may not exist yet */ }
}

export function createLogger(level: string = "info") {
  mkdirSync(DATA_DIR, { recursive: true });
  truncateLogIfNeeded(LOG_FILE);
  return pino({
    level,
    transport: {
      targets: [
        {
          target: "pino-pretty",
          options: {
            destination: 1,
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
          level,
        },
        {
          target: "pino-pretty",
          options: {
            destination: LOG_FILE,
            colorize: false,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
          level,
        },
      ],
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
