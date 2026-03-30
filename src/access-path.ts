import { join } from "node:path";

/**
 * Resolve the access.json path for an instance.
 * Topic mode uses fleet-level access; otherwise per-instance.
 */
export function resolveAccessPathFromConfig(
  dataDir: string,
  _instance: string,
  fleetChannel: { mode?: string } | undefined,
): string {
  if (fleetChannel?.mode === "topic") {
    return join(dataDir, "access", "access.json");
  }
  return join(dataDir, "access", "access.json");
}
