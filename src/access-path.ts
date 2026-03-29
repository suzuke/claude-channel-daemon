import { join } from "node:path";

/**
 * Resolve the access.json path for an instance based on fleet config.
 * Shared topic adapter → fleet-level; DM or instance-local channel → per-instance.
 */
export function resolveAccessPathFromConfig(
  dataDir: string,
  instance: string,
  fleetChannel: { mode?: string } | undefined,
  instanceChannel: { mode?: string } | undefined,
): string {
  if (fleetChannel?.mode === "topic" && !instanceChannel) {
    return join(dataDir, "access", "access.json");
  }
  return join(dataDir, "instances", instance, "access", "access.json");
}
