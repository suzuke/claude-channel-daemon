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
  startup:
    concurrency: 3
    stagger_delay_ms: 2000
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
  webhooks:
    - url: https://hooks.example.com/agend
      events: ["*"]

instances:
  my-project:
    working_directory: ~/Projects/my-app
    description: "Backend API developer"
    model: opus
    tags: [backend, api]

teams:
  frontend:
    members: [my-project, another-instance]
    description: "Frontend development team"

profiles:
  fast-dev:
    backend: claude-code
    model: sonnet
    tool_set: standard

templates:
  code-review:
    description: "Code review pipeline"
    team: true
    instances:
      reviewer:
        description: "Code reviewer"
        model: opus
      fixer:
        description: "Implements fixes"
        profile: fast-dev

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
| `templates` | object | `{}` | Deployment templates for spawning pre-configured instance groups. See [templates](#templates) |
| `profiles` | object | `{}` | Reusable backend/model profiles referenced by templates. See [profiles](#profiles) |
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
| `backend` | string | `"claude-code"` | Default CLI backend for all instances |
| `cost_guard` | object | disabled | Fleet-wide cost guard |
| `hang_detector` | object | enabled, 15min | Hang detection |
| `daily_summary` | object | enabled, 21:00 | Daily cost summary |
| `scheduler` | object | — | Scheduler settings |
| `startup` | object | — | Fleet startup behavior |
| `webhooks` | object[] | `[]` | Webhook notifications |
| `startup_timeout_ms` | number | `25000` | Total CLI backend startup timeout in ms (split 60/40 between output detection and idle wait) |

### defaults.startup

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `concurrency` | number | `3` | Max instances to start in parallel (1–20) |
| `stagger_delay_ms` | number | `2000` | Delay between instance group starts (0–30000 ms) |

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
| `events` | string[] | Events to notify (see below). Use `["*"]` for all events |
| `headers` | object | Optional HTTP headers |

Webhook events:

| Event | Description |
|-------|-------------|
| `cost_warning` | Instance cost approaches daily limit (warning threshold) |
| `cost_limit` | Instance cost hit daily limit — instance paused |
| `hang` | Instance appears hung (no activity for 15+ minutes) |
| `pty_error` | PTY error detected (rate limit, auth expired, etc.) |
| `pty_recovered` | PTY recovered after error |
| `model_failover` | Rate limit exceeded — switching to fallback model |
| `model_recovered` | Rate limit recovered — restoring primary model |
| `schedule_deferred` | Scheduled task deferred due to rate limiting |

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
| `tags` | string[] | — | Tags for categorization and capability discovery. Agents can filter by tags in `list_instances` and `broadcast` |
| `topic_id` | number\|string | auto | Channel topic/thread ID. Auto-assigned on create |
| `general_topic` | boolean | `false` | Mark as General Topic (receives unrouted messages) |
| `backend` | string | `"claude-code"` | CLI backend: `claude-code`, `codex`, `gemini-cli`, `opencode`, `kiro-cli` |
| `model` | string | — | Model alias. Claude: `sonnet`, `opus`, `haiku`, `opusplan`, `best`, `sonnet[1m]`, `opus[1m]`. Codex: `gpt-4o`, `o3`. Gemini: `gemini-2.5-pro`. Kiro: `auto`, `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5` |
| `model_failover` | string[] | — | Fallback models when rate-limited (e.g. `["opus", "sonnet"]`). A 5-minute cooldown prevents repeated failover within the same window |
| `tool_set` | string | `"full"` | MCP tool profile: `full` (all), `standard` (10), `minimal` (4) |
| `agent_mode` | `"mcp"` \| `"cli"` | `"mcp"` | Agent communication mode. `mcp` = standard MCP server (default). `cli` = HTTP endpoint, no MCP server — for backends that don't support MCP |
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
| `health_check_interval_ms` | number | `30000` | Health check polling interval in milliseconds |

### instances.\<name\>.context_guardian

Context monitoring settings. The guardian polls the CLI's statusline for context usage metrics (used for dashboard and logging). Context limits are handled by each CLI's built-in auto-compact — AgEnD does not trigger restarts based on context usage or session age.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `grace_period_ms` | number | `600000` | Vestigial — not read by any code path. Retained for config compatibility |
| `max_age_hours` | number | `0` (disabled) | Vestigial — not read by any code path. CLI auto-compact handles context limits |

> **Note:** Both fields were part of the original context rotation system, which has been removed. All CLI backends now handle context limits via built-in auto-compact. The ContextGuardian has been reduced to a pure status monitor (polling `statusline.json` for dashboard metrics).

---

## templates.\<name\>

Deployment templates define pre-configured instance groups that can be deployed on demand via the `deploy_template` MCP tool. Each template spawns a set of instances (optionally with a team) into a target directory.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string | — | Human-readable template description |
| `team` | boolean | — | Auto-create a team from all deployed instances |
| `instances` | object | **required** | Instance definitions (at least one required) |

### Template instance fields

Each instance in a template supports:

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Instance role description |
| `backend` | string | CLI backend override |
| `model` | string | Model override |
| `model_failover` | string[] | Fallback models |
| `tool_set` | string | MCP tool profile |
| `systemPrompt` | string | System prompt (inline or `file:` reference) |
| `skipPermissions` | boolean | Skip CLI permission checks |
| `lightweight` | boolean | Lightweight mode |
| `workflow` | string \| false | Workflow template override |
| `tags` | string[] | Instance tags |
| `profile` | string | Reference to a profile in `profiles` section |

Example:

```yaml
templates:
  code-review:
    description: "Code review pipeline"
    team: true
    instances:
      reviewer:
        description: "Senior code reviewer"
        model: opus
        tool_set: standard
      implementer:
        description: "Implements review feedback"
        profile: fast-dev
```

Templates are deployed via MCP tools (not CLI commands):
- `deploy_template` — deploy a template into a directory
- `teardown_deployment` — stop and delete all instances from a deployment
- `list_deployments` — list active deployments

---

## profiles.\<name\>

Reusable backend/model configurations referenced by template instances via the `profile` field.

| Field | Type | Description |
|-------|------|-------------|
| `backend` | string | CLI backend |
| `model` | string | Model |
| `model_failover` | string[] | Fallback models |
| `tool_set` | string | MCP tool profile |
| `lightweight` | boolean | Lightweight mode |

Example:

```yaml
profiles:
  fast-dev:
    backend: claude-code
    model: sonnet
    tool_set: standard
  heavy-review:
    backend: claude-code
    model: opus
    tool_set: full
```

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
| `web.token` | Auth token for Web UI dashboard |
| `scheduler.db` | Schedules + decisions + tasks (SQLite) |
| `events.db` | Event log + activity log (SQLite) |
| `access/access.json` | Access control state (topic mode) |
| `instances/<name>/` | Per-instance runtime data |
| `instances/<name>/channel.sock` | IPC Unix socket |
| `instances/<name>/channel.mcp.pid` | MCP server PID (for orphan cleanup) |
| `instances/<name>/statusline.json` | Latest CLI status |
| `instances/<name>/session-id` | Session ID for `--resume` |
| `instances/<name>/window-id` | tmux window ID |
| `instances/<name>/daemon.pid` | Instance daemon PID |
| `instances/<name>/rotation-state.json` | Context rotation snapshot (consumed on restart) |
| `instances/<name>/crash-state.json` | Crash loop state (auto-cleared on next start) |
| `instances/<name>/crash-history.jsonl` | Crash history log (append-only) |
| `instances/<name>/prev-instructions` | Previous instructions hash (for change detection) |
| `instances/<name>/repos/` | Checked-out repo worktrees (auto-cleaned) |
