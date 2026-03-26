import { Daemon } from "./daemon.js";
import type { InstanceConfig } from "./types.js";

const args = process.argv.slice(2);

function getArg(name: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : "";
}

const name = getArg("--instance");
const instanceDir = getArg("--instance-dir");
let config: InstanceConfig;
try {
  config = JSON.parse(getArg("--config"));
} catch (err) {
  console.error(`Failed to parse --config JSON: ${(err as Error).message}`);
  process.exit(1);
}

const topicMode = args.includes("--topic-mode");
const daemon = new Daemon(name, config, instanceDir, topicMode);

daemon.start().catch((err) => {
  console.error("Daemon failed:", err);
  process.exit(1);
});

const shutdown = async () => {
  await daemon.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
