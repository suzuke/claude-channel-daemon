import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";
import type { CostGuardConfig, HangDetectorConfig, DailySummaryConfig, FleetConfig, InstanceConfig } from "./types.js";

function deepMergeGeneric<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target } as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;

  for (const key of Object.keys(sourceRecord)) {
    const sourceVal = sourceRecord[key];
    const targetVal = result[key];
    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === "object" &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMergeGeneric(
        targetVal as object,
        sourceVal as Partial<object>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result as unknown as T;
}

export const DEFAULT_COST_GUARD: CostGuardConfig = {
  daily_limit_usd: 0, // 0 = disabled
  warn_at_percentage: 80,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

export const DEFAULT_HANG_DETECTOR: HangDetectorConfig = {
  enabled: true,
  timeout_minutes: 15,
};

export const DEFAULT_DAILY_SUMMARY: DailySummaryConfig = {
  enabled: true,
  hour: 21,
  minute: 0,
};

export const DEFAULT_INSTANCE_CONFIG: Omit<InstanceConfig, "working_directory"> = {
  restart_policy: {
    max_retries: 10,
    backoff: "exponential",
    reset_after: 300,
  },
  context_guardian: {
    grace_period_ms: 600_000,
    max_age_hours: 0, // 0 = disabled; Claude Code auto-compact handles context limits
  },
  log_level: "info",
};

/** Validate IANA timezone string. Throws if invalid. */
export function validateTimezone(tz: string, field: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new Error(`${field}: invalid timezone "${tz}". Use IANA format (e.g. Asia/Taipei)`);
  }
}

export function loadFleetConfig(configPath: string): FleetConfig {
  if (!existsSync(configPath)) {
    return { defaults: {}, instances: {} };
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = yaml.load(raw) as {
    channel?: FleetConfig["channel"];
    project_roots?: string[];
    defaults?: Partial<InstanceConfig>;
    instances?: Record<string, Partial<InstanceConfig>>;
    health_port?: number;
  } | null;

  if (!parsed) {
    return { defaults: {}, instances: {} };
  }

  const fleetDefaults: Partial<InstanceConfig> = parsed.defaults ?? {};
  const rawInstances = parsed.instances ?? {};
  const instances: Record<string, InstanceConfig> = {};

  for (const [name, overrides] of Object.entries(rawInstances)) {
    const merged = deepMergeGeneric(
      deepMergeGeneric(DEFAULT_INSTANCE_CONFIG as Partial<InstanceConfig>, fleetDefaults),
      overrides,
    ) as Partial<InstanceConfig>;

    if (!merged.working_directory) {
      throw new Error(
        `Instance "${name}" is missing required field: working_directory`,
      );
    }

    instances[name] = merged as InstanceConfig;
  }

  return {
    channel: parsed.channel,
    project_roots: parsed.project_roots,
    defaults: fleetDefaults,
    instances,
    health_port: parsed.health_port,
  };
}
