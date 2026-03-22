import pino from "pino";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const DATA_DIR = join(homedir(), ".claude-channel-daemon");
const LOG_FILE = join(DATA_DIR, "daemon.log");

export function createLogger(level: string = "info") {
  mkdirSync(DATA_DIR, { recursive: true });
  return pino({
    level,
    transport: {
      targets: [
        {
          target: "pino-pretty",
          options: {
            destination: 1,
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
          level,
        },
        { target: "pino/file", options: { destination: LOG_FILE }, level },
      ],
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
