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
    max_age_hours: number;
    strategy: "status_line" | "timer" | "hybrid";
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

export interface MemoryBackupRow {
  id: number;
  file_path: string;
  content: string;
  chat_id: string | null;
  backed_up_at: string;
}
