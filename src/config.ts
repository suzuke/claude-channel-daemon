import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { getAgendHome, getTmuxSessionName } from "./paths.js";
import type { CostGuardConfig, HangDetectorConfig, DailySummaryConfig, FleetConfig, FleetTemplate, InstanceConfig } from "./types.js";

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

export function getTmuxSession(): string {
  return process.env.AGEND_TMUX_SESSION ?? getTmuxSessionName();
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
  // Quote bare 16+ digit integers before parsing to prevent precision loss.
  // Discord snowflakes and Telegram group IDs are 64-bit and exceed JS MAX_SAFE_INTEGER.
  const safeRaw = raw.replace(/(?<=:\s+|[-]\s+)(\d{16,})(?=\s*$)/gm, (_, d) => `"${d}"`);

  const parsed = yaml.load(safeRaw) as {
    channel?: FleetConfig["channel"];
    project_roots?: string[];
    defaults?: Partial<InstanceConfig>;
    instances?: Record<string, Partial<InstanceConfig>>;
    teams?: FleetConfig["teams"];
    templates?: Record<string, FleetTemplate>;
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
      const defaultDir = join(getAgendHome(), "workspaces", name);
      mkdirSync(defaultDir, { recursive: true });
      merged.working_directory = defaultDir;
    }

    instances[name] = merged as InstanceConfig;
  }

  // Validate templates: each must have at least one instance definition
  const templates: Record<string, FleetTemplate> = {};
  if (parsed.templates) {
    for (const [name, tpl] of Object.entries(parsed.templates)) {
      if (!tpl.instances || Object.keys(tpl.instances).length === 0) {
        throw new Error(`Template "${name}" must define at least one instance`);
      }
      templates[name] = tpl;
    }
  }

  return {
    channel: parsed.channel
      ? (() => {
          if (!parsed.channel.mode) {
            throw new Error(
              `fleet.yaml: channel.mode is required. Valid values: "topic" | "classic"`
            );
          }
          return parsed.channel;
        })()
      : parsed.channel,
    project_roots: parsed.project_roots,
    defaults: fleetDefaults,
    instances,
    teams: parsed.teams ?? {},
    templates,
    health_port: parsed.health_port,
  };
}
