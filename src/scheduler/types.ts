export interface Schedule {
  id: string;
  cron: string;
  message: string;
  source: string;
  target: string;
  reply_chat_id: string;
  reply_thread_id: string | null;
  label: string | null;
  enabled: boolean;
  timezone: string;
  created_at: string;
  last_triggered_at: string | null;
  last_status: string | null;
}

export interface ScheduleRun {
  id: number;
  schedule_id: string;
  triggered_at: string;
  status: "delivered" | "delivered_fallback" | "retry" | "instance_offline" | "channel_dead";
  detail: string | null;
}

export interface CreateScheduleParams {
  cron: string;
  message: string;
  source: string;
  target: string;
  reply_chat_id: string;
  reply_thread_id: string | null;
  label?: string;
  timezone?: string;
}

export interface UpdateScheduleParams {
  cron?: string;
  message?: string;
  target?: string;
  label?: string;
  timezone?: string;
  enabled?: boolean;
}

export interface SchedulerConfig {
  max_schedules: number;
  default_timezone: string;
  retry_count: number;
  retry_interval_ms: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  max_schedules: 100,
  default_timezone: "Asia/Taipei",
  retry_count: 3,
  retry_interval_ms: 30_000,
};
