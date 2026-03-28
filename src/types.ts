export interface DaemonConfig {
  channel_plugin: string;
  working_directory: string;
  restart_policy: {
    max_retries: number;
    backoff: "exponential" | "linear";
    reset_after: number;
  };
  context_guardian: {
    threshold_percentage: number;
    max_idle_wait_ms: number;
    completion_timeout_ms: number;
    grace_period_ms: number;
    max_age_hours: number;
  };
  memory: {
    auto_summarize: boolean;
    watch_memory_dir: boolean;
    backup_to_sqlite: boolean;
  };
  memory_directory?: string;
  log_level: "debug" | "info" | "warn" | "error";
}

export interface ContextStatus {
  used_percentage: number;
  remaining_percentage: number;
  context_window_size: number;
}

export interface StatusLineData {
  session_id: string;
  model: { id: string; display_name: string };
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    current_usage: number | null;
    used_percentage: number | null;
    remaining_percentage: number | null;
  };
  cost: {
    total_cost_usd: number;
    total_duration_ms: number;
  };
  rate_limits?: {
    five_hour: { used_percentage: number; resets_at: string };
    seven_day: { used_percentage: number; resets_at: string };
  };
}

export interface MemoryBackupRow {
  id: number;
  file_path: string;
  content: string;
  chat_id: string | null;
  backed_up_at: string;
}

export interface AccessConfig {
  mode: "pairing" | "locked";
  allowed_users: number[];
  max_pending_codes: number;
  code_expiry_minutes: number;
}

export interface CostGuardConfig {
  daily_limit_usd: number;
  warn_at_percentage: number;
  timezone: string;
}

export interface HangDetectorConfig {
  enabled: boolean;
  timeout_minutes: number;
}

export interface DailySummaryConfig {
  enabled: boolean;
  hour: number;
  minute: number;
}

export interface ChannelConfig {
  type: string;
  mode: "topic" | "dm";
  bot_token_env: string;
  group_id?: number;
  access: AccessConfig;
  options?: Record<string, unknown>;
}

export interface InstanceConfig {
  working_directory: string;
  /** Human-readable description of what this instance does */
  description?: string;
  topic_id?: number;
  general_topic?: boolean;
  channel?: ChannelConfig;
  restart_policy: DaemonConfig["restart_policy"];
  context_guardian: DaemonConfig["context_guardian"];
  memory: DaemonConfig["memory"];
  memory_directory?: string;
  log_level: DaemonConfig["log_level"];
  /** CLI backend to use. Default: "claude-code" */
  backend?: string;
  /** @deprecated backward compat */
  channel_plugin?: string;
  /** Skip non-essential subsystems (transcript monitor, context guardian, memory layer, approval server, prompt detector) */
  lightweight?: boolean;
  /** System prompt for the Claude instance */
  systemPrompt?: string;
  /** Skip permission checks (dangerously-skip-permissions) */
  skipPermissions?: boolean;
  /** Claude model to use (e.g. "sonnet", "opus", "haiku", or full model ID) */
  model?: string;
  /** Ordered fallback models when primary hits rate limit (e.g. ["opus", "sonnet"]) */
  model_failover?: string[];
  /** Per-instance cost guard (overrides fleet defaults) */
  cost_guard?: CostGuardConfig;
  /** Original repo path when this instance uses a git worktree */
  worktree_source?: string;
}

export interface MeetingDefaults {
  maxConcurrent?: number;
  maxParticipants?: number;
  defaultRounds?: number;
}

export interface FleetDefaults extends Partial<InstanceConfig> {
  scheduler?: {
    max_schedules?: number;
    default_timezone?: string;
    retry_count?: number;
    retry_interval_ms?: number;
  };
  meetings?: MeetingDefaults;
  cost_guard?: CostGuardConfig;
  hang_detector?: HangDetectorConfig;
  daily_summary?: DailySummaryConfig;
}

export interface FleetConfig {
  channel?: ChannelConfig;
  project_roots?: string[];
  defaults: FleetDefaults;
  instances: Record<string, InstanceConfig>;
}
