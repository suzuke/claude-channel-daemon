# Configuration

## Fleet config

Located at `~/.agend/fleet.yaml`. Created by `agend init` or manually.

```yaml
project_roots:
  - ~/Projects

channel:
  type: telegram
  mode: topic
  bot_token_env: AGEND_BOT_TOKEN
  group_id: -1001234567890
  access:
    mode: locked
    allowed_users: [123456789]

defaults:
  backend: claude-code
  tool_set: standard
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: Asia/Taipei
  daily_summary:
    enabled: true
    hour: 21
  hang_detector:
    enabled: true
    timeout_minutes: 15

instances:
  my-project:
    working_directory: ~/Projects/my-app
    description: "Backend API developer"
    tags: [backend, api]
    model: opus

health_port: 19280
```

---

## Top-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `project_roots` | string[] | `[]` | Directories shown in topic auto-bind browser |
| `channel` | object | **required** | Messaging platform configuration |
| `defaults` | object | `{}` | Default settings inherited by all instances |
| `instances` | object | **required** | Instance definitions (key = instance name) |
| `health_port` | number | `19280` | HTTP health/API server port |

---

## channel

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"telegram"` \| `"discord"` | **required** | Messaging platform |
| `mode` | `"topic"` | `"topic"` | Routing mode (topic = one topic per instance) |
| `bot_token_env` | string | **required** | Environment variable name holding the bot token |
| `group_id` | number | — | Telegram group ID (negative) or Discord guild ID |
| `access` | object | **required** | Access control settings |
| `options` | object | — | Platform-specific options (Discord: `category_name`, `general_channel_id`) |

### channel.access

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `"locked"` | `"locked"` | Access mode. `locked` = whitelist only |
| `allowed_users` | (number\|string)[] | `[]` | Whitelisted user IDs. Supports both number and string (cross-platform) |
| `max_pending_codes` | number | `3` | Max simultaneous pairing codes (if pairing mode used) |
| `code_expiry_minutes` | number | `10` | Pairing code expiry time |

---

## defaults

All fields from `instances.<name>` can be set here as defaults. Additionally:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cost_guard` | object | disabled | Fleet-wide cost guard |
| `hang_detector` | object | enabled, 15min | Hang detection |
| `daily_summary` | object | enabled, 21:00 | Daily cost summary |
| `scheduler` | object | — | Scheduler settings |
| `webhooks` | object[] | `[]` | Webhook notifications |

### defaults.cost_guard

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `daily_limit_usd` | number | `0` (disabled) | Daily spending limit per instance. `0` = no limit |
| `warn_at_percentage` | number | `80` | Warn when cost reaches this % of limit |
| `timezone` | string | system TZ | IANA timezone for midnight reset (e.g. `Asia/Taipei`) |

### defaults.hang_detector

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable idle hang detection |
| `timeout_minutes` | number | `15` | Minutes of no output before hang alert |

### defaults.daily_summary

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable daily cost summary report |
| `hour` | number | `21` | Hour to send summary (0-23, local time) |
| `minute` | number | `0` | Minute to send summary |

### defaults.scheduler

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_schedules` | number | `100` | Maximum number of schedules |
| `default_timezone` | string | `Asia/Taipei` | Default timezone for cron schedules |
| `retry_count` | number | `3` | Retries for failed schedule delivery |
| `retry_interval_ms` | number | `30000` | Retry interval |

### defaults.webhooks[]

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Webhook endpoint URL |
| `events` | string[] | Events to notify: `rotation`, `hang`, `cost_warn`, `cost_limit`, `crash_loop` |
| `headers` | object | Optional HTTP headers |

---

## instances.\<name\>

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `working_directory` | string | **required** | Project directory path |
| `display_name` | string | — | Agent display name (e.g. "Kuro"). Set via `set_display_name` tool |
| `description` | string | — | Role description. Injected into system prompt as `## Role` |
| `tags` | string[] | `[]` | Tags for filtering (`broadcast`, `list_instances`) |
| `topic_id` | number\|string | auto | Channel topic/thread ID. Auto-assigned on create |
| `general_topic` | boolean | `false` | Mark as General Topic (receives unrouted messages) |
| `backend` | string | `"claude-code"` | CLI backend: `claude-code`, `codex`, `gemini-cli`, `opencode` |
| `model` | string | — | Model alias. Claude: `sonnet`, `opus`, `haiku`, `opusplan`, `best`, `sonnet[1m]`, `opus[1m]`. Codex: `gpt-4o`, `o3`. Gemini: `gemini-2.5-pro` |
| `model_failover` | string[] | — | Fallback models when rate-limited (e.g. `["opus", "sonnet"]`) |
| `tool_set` | string | `"full"` | MCP tool profile: `full` (all), `standard` (10), `minimal` (4) |
| `systemPrompt` | string | — | Custom system prompt. Supports `file:./path.md` for external files |
| `skipPermissions` | boolean | `true` | Skip CLI permission checks (`--dangerously-skip-permissions`). Set `false` to enable |
| `lightweight` | boolean | `false` | Skip transcript monitor, context guardian, approval server |
| `log_level` | string | `"info"` | `debug`, `info`, `warn`, `error` |
| `restart_policy` | object | see below | Crash recovery settings |
| `context_guardian` | object | see below | Context rotation settings |
| `cost_guard` | object | — | Per-instance cost guard (overrides defaults) |
| `worktree_source` | string | — | Original repo path (auto-set when using branch parameter) |

### instances.\<name\>.restart_policy

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_retries` | number | `10` | Max respawn attempts before giving up |
| `backoff` | `"exponential"` \| `"linear"` | `"exponential"` | Backoff strategy between retries |
| `reset_after` | number | `300` | Seconds of stability before resetting retry counter |

### instances.\<name\>.context_guardian

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `grace_period_ms` | number | `600000` | Wait time after rotation trigger before restart (10 min) |
| `max_age_hours` | number | `0` (disabled) | Force rotation after N hours. `0` = rely on CLI auto-compact |

---

## Secrets

Located at `~/.agend/.env`:

```
AGEND_BOT_TOKEN=123456789:AAH...
GROQ_API_KEY=gsk_...          # optional, for voice transcription
```

---

## Data directory

`~/.agend/`:

| Path | Purpose |
|------|---------|
| `fleet.yaml` | Fleet configuration |
| `.env` | Bot token + API keys |
| `daemon.log` | Fleet daemon log |
| `fleet.pid` | Fleet manager PID |
| `scheduler.db` | Schedules + decisions + tasks (SQLite) |
| `events.db` | Event log + activity log (SQLite) |
| `access/access.json` | Access control state (topic mode) |
| `instances/<name>/` | Per-instance runtime data |
| `instances/<name>/channel.sock` | IPC Unix socket |
| `instances/<name>/statusline.json` | Latest CLI status |
| `instances/<name>/session-id` | Session ID for `--resume` |
| `instances/<name>/.prompt-generated` | Auto-generated system prompt (do not edit) |
| `instances/<name>/rotation-state.json` | Context rotation snapshot |
| `instances/<name>/repos/` | Checked-out repo worktrees (auto-cleaned) |
