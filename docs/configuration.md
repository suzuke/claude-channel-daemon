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
    model: opus

teams:
  frontend:
    members: [my-project, another-instance]
    description: "Frontend development team"

health_port: 19280
```

---

## Top-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `project_roots` | string[] | `[]` | Directories shown in topic auto-bind browser. Also restricts `create_instance` — working directories must be under a configured root |
| `channel` | object | **required** | Messaging platform configuration |
| `defaults` | object | `{}` | Default settings inherited by all instances |
| `instances` | object | **required** | Instance definitions (key = instance name) |
| `teams` | object | `{}` | Named instance groups for targeted broadcasting |
| `workflow` | string \| false | `"builtin"` | Fleet collaboration workflow template. `"builtin"` = standard workflow, `"file:./path.md"` = custom, `false` = disabled |
| `health_port` | number | `19280` | HTTP health/API server port |

---

## channel

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `"telegram"` \| `"discord"` | **required** | Messaging platform |
| `mode` | `"topic"` | `"topic"` | Routing mode (topic = one topic per instance) |
| `bot_token_env` | string | **required** | Environment variable name holding the bot token |
| `group_id` | number \| string | — | Telegram group ID (negative) or Discord guild ID. Quote Discord snowflake IDs to prevent precision loss. |
| `access` | object | **required** | Access control settings |
| `mirror_topic_id` | number \| string | — | Telegram topic ID for mirroring cross-instance communication. All `send_to_instance` messages appear here |
| `options` | object | — | Platform-specific options (Discord: `category_name`, `general_channel_id`) |

### channel.access

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `"locked"` \| `"pairing"` | `"locked"` | `locked` = whitelist only. `pairing` = users can request access via `/pair` command (requires manual code confirmation) |
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
| `startup_timeout_ms` | number | `25000` | Total CLI backend startup timeout in ms (split 60/40 between output detection and idle wait) |

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

## teams.\<name\>

Named groups of instances for targeted broadcasting. Managed via `create_team`, `list_teams`, `update_team`, `delete_team` MCP tools, or defined directly in fleet.yaml.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `members` | string[] | **required** | Instance names in this team |
| `description` | string | — | Human-readable description of the team's purpose |

Example:

```yaml
teams:
  backend-squad:
    members: [api-agent, db-agent]
    description: "Backend development team"
```

Use `broadcast(team: "backend-squad", message: "...")` to send to all members.

> **Note:** When an instance is deleted, it is automatically removed from all teams.

---

## instances.\<name\>

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `working_directory` | string | auto | Project directory path. If omitted, auto-created at `~/.agend/workspaces/<name>` |
| `display_name` | string | — | Agent display name (e.g. "Kuro"). Set via `set_display_name` tool |
| `description` | string | — | Role description. Injected via MCP server instructions as `## Role` |
| `topic_id` | number\|string | auto | Channel topic/thread ID. Auto-assigned on create |
| `general_topic` | boolean | `false` | Mark as General Topic (receives unrouted messages) |
| `backend` | string | `"claude-code"` | CLI backend: `claude-code`, `codex`, `gemini-cli`, `opencode`, `kiro-cli` |
| `model` | string | — | Model alias. Claude: `sonnet`, `opus`, `haiku`, `opusplan`, `best`, `sonnet[1m]`, `opus[1m]`. Codex: `gpt-4o`, `o3`. Gemini: `gemini-2.5-pro`. Kiro: `auto`, `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5` |
| `model_failover` | string[] | — | Fallback models when rate-limited (e.g. `["opus", "sonnet"]`). A 5-minute cooldown prevents repeated failover within the same window |
| `tool_set` | string | `"full"` | MCP tool profile: `full` (all), `standard` (10), `minimal` (4) |
| `systemPrompt` | string | — | Custom instructions injected via MCP server instructions. Inline string or `file:./path.md` to load from an external file (path relative to `working_directory`). Does not modify the CLI's built-in system prompt. Example: `systemPrompt: "file:./prompts/role.md"` |
| `skipPermissions` | boolean | `true` | Skip CLI permission checks (`--dangerously-skip-permissions`). Set `false` to enable |
| `lightweight` | boolean | `false` | Skip transcript monitor, context guardian, approval server |
| `log_level` | string | `"info"` | `debug`, `info`, `warn`, `error` |
| `restart_policy` | object | see below | Crash recovery settings |
| `context_guardian` | object | see below | Context monitoring settings |
| `cost_guard` | object | — | Per-instance cost guard (overrides defaults) |
| `worktree_source` | string | — | Original repo path (auto-set when using branch parameter) |

### instances.\<name\>.restart_policy

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_retries` | number | `10` | Max respawn attempts before giving up |
| `backoff` | `"exponential"` \| `"linear"` | `"exponential"` | Backoff strategy between retries |
| `reset_after` | number | `300` | Seconds of stability before resetting retry counter |

### instances.\<name\>.context_guardian

Context monitoring settings. The guardian polls the CLI's statusline for context usage metrics (used for dashboard and logging). Context limits are handled by each CLI's built-in auto-compact — AgEnD does not trigger restarts based on context usage or session age.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `grace_period_ms` | number | `600000` | Reserved for future use |
| `max_age_hours` | number | `0` (disabled) | Reserved for future use. Currently ignored — CLI auto-compact handles context limits |

---

## How fleet context is injected

AgEnD injects fleet context into each instance via the **MCP server instructions** mechanism — not by modifying the CLI's own system prompt. This keeps each CLI's built-in behavior intact and works uniformly across all backends.

### Fleet context via MCP instructions

When the daemon spawns an instance, it starts an MCP server (`agend`) as a child process of the CLI. The daemon passes instance metadata to the MCP server via environment variables:

| Env var | Content |
|---------|---------|
| `AGEND_INSTANCE_NAME` | Instance name (e.g. `my-project`) |
| `AGEND_WORKING_DIR` | Working directory path |
| `AGEND_DISPLAY_NAME` | Agent display name (if set) |
| `AGEND_DESCRIPTION` | Role description from `description` field |
| `AGEND_CUSTOM_PROMPT` | Resolved content from `systemPrompt` field |

The MCP server assembles these into a single `instructions` string that the CLI reads via the MCP protocol. The instructions include:

1. **Identity** — instance name, working directory, display name, role
2. **Message format** — how to distinguish user messages (`[user:name]`) from cross-instance messages (`[from:instance-name]`)
3. **Collaboration rules** — use `reply` for users, `send_to_instance` for cross-instance, scope awareness
4. **Tool guidance** — how to use reply, react, edit_message, download_attachment, and fleet tools
5. **Custom prompt** — the `systemPrompt` content from fleet.yaml (supports `file:` prefix)

This approach means:
- The CLI's built-in system prompt is **never modified** (Claude Code keeps its tool usage instructions, Gemini keeps its skills, etc.)
- Project-level instruction files (CLAUDE.md, AGENTS.md, GEMINI.md) are **not affected**
- All backends (Claude Code, Codex, Gemini CLI, OpenCode, Kiro CLI) use the same injection path

### Known limitation: OpenCode MCP instructions

OpenCode (as of v1.3.10) does **not** read the MCP server `instructions` field. It loads MCP tools correctly, but fleet context (identity, message format, collaboration rules, workflow template) is not injected into the OpenCode instance's system prompt. This means OpenCode instances:

- Have all fleet MCP tools available (reply, send_to_instance, etc.)
- Do **not** automatically know they are fleet instances or how to use fleet message formats
- May not follow collaboration rules or the workflow template

This is an upstream limitation. Once OpenCode adds support for MCP instructions, no changes to AgEnD are needed — the existing mechanism will work automatically.

### Known limitation: Kiro CLI MCP instructions (unverified)

Kiro CLI (as of v1.29.2) has **not been verified** to read the MCP server `instructions` field. If it does not, the same limitation as OpenCode applies: fleet context will not be injected. Kiro CLI supports `.kiro/steering/` files for context injection, but AgEnD uses the unified MCP instructions path for all backends.

### Session snapshots (context rotation)

When a context rotation occurs, the daemon saves a snapshot of the previous session (recent messages, tool activity, context usage) to `rotation-state.json`. On the next spawn, the snapshot is delivered as the **first inbound message** with a `[system:session-snapshot]` prefix — not embedded in the system prompt.

The snapshot file persists on disk (for daemon restart recovery). An in-memory flag prevents re-injection within the same daemon process.

### Decisions

Active decisions (from `post_decision`) are **not** preloaded into the prompt. Agents query them on demand using the `list_decisions` tool.

### fleet.yaml `systemPrompt`

The `systemPrompt` field in fleet.yaml still works as before:
- Inline string: `systemPrompt: "You are a security reviewer"`
- File reference: `systemPrompt: "file:./prompts/role.md"` (path relative to `working_directory`)

The only change is the injection channel: content is now delivered via MCP instructions instead of CLI flags like `--system-prompt`.

---

## Secrets

Located at `~/.agend/.env`:

```
AGEND_BOT_TOKEN=123456789:AAH...
GROQ_API_KEY=gsk_...          # optional, for voice transcription
```

Values in `~/.agend/.env` take priority over inherited shell environment variables. This ensures secrets set in `.env` are not accidentally overridden by variables in the shell profile.

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
| `instances/<name>/rotation-state.json` | Context rotation snapshot (consumed on restart) |
| `instances/<name>/repos/` | Checked-out repo worktrees (auto-cleaned) |
