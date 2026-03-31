# Features

## Fleet mode — one bot, many projects

Each Telegram Forum Topic maps to an independent Claude Code session. Create a topic, pick a project directory, and Claude starts working. Delete the topic, instance stops. Scale to as many projects as your machine can handle.

## Scheduled tasks

Claude can create cron-based schedules via MCP tools. Schedules survive daemon restarts (SQLite-backed).

```
User: "Every morning at 9am, check if there are any open PRs that need review"
Claude: → create_schedule(cron: "0 9 * * *", message: "Check open PRs needing review")
```

Available MCP tools: `create_schedule`, `list_schedules`, `update_schedule`, `delete_schedule`

Collaboration MCP tools: `list_instances`, `send_to_instance`, `start_instance`, `create_instance`, `delete_instance`

Schedules can target a specific instance or the same instance that created them. When a schedule triggers, the daemon pushes the message to Claude as if a user sent it.

## Context rotation

Watches Claude's status line JSON. When context usage exceeds the threshold or the session reaches its max age, the daemon performs a simple restart:

```
NORMAL → RESTARTING → GRACE
```

1. **Trigger** — context exceeds threshold (default 80%) or `max_age_hours` reached (default 8h)
2. **Idle barrier** — waits up to 5 seconds for current activity to settle (best-effort, not a handover)
3. **Snapshot** — daemon collects recent user messages, tool activity, and statusline data into `rotation-state.json`
4. **Restart** — kills tmux window, spawns fresh session with the snapshot injected into the system prompt
5. **Grace** — 10-minute cooldown to prevent rapid re-rotation

No handover prompt is sent to Claude. Recovery context comes entirely from the daemon-side snapshot.

## Peer-to-peer agent collaboration

Every instance is an equal peer that can discover, wake, create, and message other instances. No dispatcher needed — collaboration emerges from the tools available to each agent.

**Core MCP tools:**

- `list_instances` — discover all configured instances (running or stopped) with status, working directory, tags, and last activity
- `send_to_instance` — send a message to another instance or external session; supports structured metadata (`request_kind`, `requires_reply`, `correlation_id`, `task_summary`)
- `start_instance` — wake a stopped instance so you can message it
- `create_instance` — create a new instance with a topic from a project directory (supports `--branch` for git worktree isolation)
- `delete_instance` — remove an instance and its topic
- `describe_instance` — get detailed info about a specific instance (description, tags, model, last activity)

**High-level collaboration tools** (prefer these over raw `send_to_instance`):

- `request_information` — ask another instance a question and expect a reply (`request_kind=query`, `requires_reply=true`)
- `delegate_task` — assign work to another instance with success criteria (`request_kind=task`, `requires_reply=true`)
- `report_result` — return results to the requester, echoing `correlation_id` to link the response to its request

Messages are posted to the recipient's Telegram topic for visibility. Sender topic notifications are only posted for instance-to-instance messages (not from external sessions).

If you `send_to_instance` a stopped instance, the error tells you to use `start_instance()` first — agents self-correct without human intervention.

### Fleet context system prompt

On startup, each instance automatically receives a fleet context system prompt that tells it:

- Its own identity (`instanceName`) and working directory
- The full list of fleet tools and how to use them
- Collaboration rules: how to handle `from_instance` messages, when to echo `correlation_id`, scope awareness (never assume direct file access to another instance's repo)

This means instances understand their role in the fleet from the first message, without any manual configuration.

## General Topic instance

A regular instance bound to the Telegram General Topic. Auto-created on fleet startup, it serves as a natural language entry point for tasks that don't belong to a specific project. Its behavior is defined entirely by its project's `CLAUDE.md`:

- Simple tasks (web search, translation, general questions) — handles directly
- Project-specific tasks — uses `list_instances()` to find the right agent, `start_instance()` if needed, then `send_to_instance()` to delegate
- New project requests — uses `create_instance()` to set up a new agent

Use `/status` in the General topic for a fleet overview. All other project management is handled by the General instance through natural language.

## External session support

You can connect a local Claude Code session to the daemon's channel tools (reply, send_to_instance, etc.) by pointing `.mcp.json` at an instance's IPC socket:

```json
{
  "mcpServers": {
    "ccd-channel": {
      "command": "node",
      "args": ["path/to/dist/channel/mcp-server.js"],
      "env": {
        "CCD_SOCKET_PATH": "~/.agend/instances/<name>/channel.sock"
      }
    }
  }
}
```

The daemon automatically isolates external sessions from internal ones using env var layering:

| Session type | Identity source | Example |
|---|---|---|
| Internal (daemon-managed) | `CCD_INSTANCE_NAME` via tmux env | `ccplugin` |
| External (custom name) | `CCD_SESSION_NAME` in `.mcp.json` env | `dev` |
| External (zero-config) | `external-<basename(cwd)>` fallback | `external-myproject` |

Internal sessions get `CCD_INSTANCE_NAME` injected by the daemon into the tmux shell environment. External sessions don't have this, so they fall through to `CCD_SESSION_NAME` (if set) or an auto-generated name based on the working directory. This means the same `.mcp.json` produces different identities for internal vs external sessions — no configuration conflicts.

External sessions appear in `list_instances` and can be targeted by `send_to_instance`.

## Permission system

Uses Claude Code's native permission relay — permission requests are forwarded to Telegram as inline buttons (Allow/Deny). When Claude requests a sensitive tool use, the daemon surfaces it to you in Telegram and waits for your response before proceeding.

Permission prompts show a countdown timer that updates every 30 seconds. An "Always Allow" button lets you approve all future uses of a specific tool for the current session. Decisions are shown inline after you respond ("✅ Approved" / "❌ Denied").

## Voice transcription

Telegram voice messages are transcribed via Groq Whisper API and sent to Claude as text. Works in both topic mode and DM mode. Requires `GROQ_API_KEY` in `.env`.

## Dynamic instance management

Instances are created through the General instance using `create_instance`. Tell the General instance what project you want to work on — it creates a Telegram topic, binds the project directory, and starts Claude automatically. Instances can also be created with `--branch` to spawn a git worktree for feature branch isolation. Deleting a topic auto-unbinds and stops the instance. Use `delete_instance` to fully remove an instance and its topic.

## Cost guard

Prevent bill shock when running unattended. Configure daily spending limits in `fleet.yaml`:

```yaml
defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: "Asia/Taipei"
```

When an instance approaches the limit, a warning is posted to its Telegram topic. When the limit is reached, the instance is automatically paused and a notification is sent. Paused instances resume the next day or when manually restarted.

## Fleet status

Use `/status` in the General topic to see a live overview:

```
🟢 proj-a — ctx 42%, $3.20 today
🟢 proj-b — ctx 67%, $8.50 today
⏸ proj-c — paused (cost limit)

Fleet: $11.70 / $50.00 daily
```

## Daily summary

A daily report is posted to the General topic at a configurable time (default 21:00):

```
📊 Daily Report — 2026-03-26

proj-a: $8.20, 2 restarts
proj-b: $2.10
proj-c: $0.00 ⚠️ 1 hang

Total: $10.30
```

## Hang detection

If an instance shows no activity for 15 minutes (configurable), the daemon posts a notification with inline buttons:

- **Force restart** — stops and restarts the instance
- **Keep waiting** — dismisses the alert

Uses multi-signal detection: checks both transcript activity and statusline freshness to avoid false positives during long-running tool calls.

## Rate limit-aware scheduling

When the 5-hour API rate limit exceeds 85%, scheduled triggers are automatically deferred instead of firing. A notification is posted to the instance's topic. Deferred schedules are not lost — they will fire on the next cron tick when rate limits are below threshold.

## Model failover

When the primary model hits a rate limit, the daemon automatically switches to a backup model on the next context rotation. Configure a fallback chain in `fleet.yaml`:

```yaml
instances:
  my-project:
    model_failover: ["opus", "sonnet"]
```

The daemon notifies you in Telegram when a failover occurs and switches back to the primary model when rate limits recover.

## Graceful restart

`agend fleet restart` sends SIGUSR2 to the fleet manager. It waits for all instances to go idle (no transcript activity for 10s), then restarts them one by one. A 5-minute timeout prevents hanging on stuck instances.

## Topic icon + idle archive

Running instances get a visual icon indicator in Telegram. When an instance stops or crashes, the icon changes. Idle instances are automatically archived — sending a message to an archived topic re-opens it automatically.

## Daemon-side restart snapshot

Before each context restart, the daemon saves a `rotation-state.json` with recent user messages, tool activity, context usage, and statusline data. The next session receives this snapshot in its system prompt, providing continuity without relying on Claude to write a handover report.

## Service message filter

Telegram system events (topic rename, pin, member join, etc.) are filtered out before reaching Claude, saving context window tokens.

## Health endpoint

A lightweight HTTP endpoint for external monitoring tools:

```
GET /health  → { status: "ok", instances: 3, uptime: 86400 }
GET /status  → { instances: [{ name, status, context_pct, cost_today }] }
```

Configure in `fleet.yaml`:

```yaml
health_port: 19280  # top-level, default 19280, binds to 127.0.0.1
```

## Webhook notifications

Push fleet events to external endpoints (Slack, custom dashboards, etc.):

```yaml
defaults:
  webhooks:
    - url: https://hooks.slack.com/...
      events: ["restart", "hang", "cost_warn"]
    - url: https://custom.endpoint/ccd
      events: ["*"]
```

## Discord adapter (MVP)

Connect your fleet to Discord instead of (or alongside) Telegram. Configure in `fleet.yaml`:

```yaml
channel:
  type: discord
  bot_token_env: CCD_DISCORD_TOKEN
  guild_id: "123456789"
```

## External adapter plugin system

Community adapters can be installed via npm and loaded automatically:

```bash
npm install ccd-adapter-slack
```

The daemon discovers adapters matching the `ccd-adapter-*` naming convention. Channel types are exported from the package entry point for adapter authors.
