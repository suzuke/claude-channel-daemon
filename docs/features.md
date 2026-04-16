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

## Crash recovery

Watches Claude's status line JSON for context usage metrics (used for dashboard and logging). All CLI backends (Claude Code, Codex, Gemini CLI, OpenCode, Kiro CLI) have built-in auto-compact that handles context limits internally — AgEnD does not trigger restarts based on context usage or session age.

When a CLI process crashes, the daemon's health check detects the dead tmux window and:

1. **Snapshot** — collects recent user messages, tool activity, and statusline data into `rotation-state.json`
2. **Process cleanup** — kills the entire process tree (CLI + MCP server) via process group signal, and kills any orphan MCP server via PID file
3. **Resume attempt** — tries `--resume` to restore the full conversation history
4. **Fallback** — if resume fails, spawns a fresh session and injects the snapshot as context
5. **Backoff** — exponential backoff on repeated crashes; 3+ crashes in a 5-minute sliding window pauses respawn

### Fleet-level circuit breaker

When the tmux server itself crashes (not just a single window), all instances lose their windows simultaneously. The fleet-level circuit breaker detects this:

- 2+ tmux server crashes in 5 minutes → pauses all instance respawns for 30 seconds
- Prevents thundering herd where all instances try to respawn at once
- Auto-recovers after the pause period

### MCP server orphan prevention

When a CLI process dies, its MCP server child process should exit too. Three layers of protection:

1. **ppid polling** (primary) — MCP server polls `process.ppid` every 5 seconds. If reparented to PID 1 (parent died), exits immediately. Works on all platforms, immune to macOS libuv/kqueue bugs.
2. **stdin EOF listeners** (secondary) — listens for stdin `end`/`close`/`error` events. Works on Linux; unreliable on macOS due to libuv CPU spin on broken pipes.
3. **PID file kill** (daemon-side) — MCP server writes its PID to `channel.mcp.pid`. On crash respawn, daemon reads the file and SIGTERMs the orphan before spawning a new CLI.

## Instance replacement

When an instance's context is polluted or it's stuck in a loop, use `replace_instance` to atomically swap it with a fresh one:

1. Collects handover context from the daemon's ring buffer (recent messages, events, tool activity)
2. Stops the old instance and preserves its config
3. Creates a new instance with the same config, reusing the Telegram topic
4. Sends handover context to the new instance via the standard message delivery path

## Peer-to-peer agent collaboration

Every instance is an equal peer that can discover, wake, create, and message other instances. No dispatcher needed — collaboration emerges from the tools available to each agent.

**Core MCP tools:**

- `list_instances` — discover all configured instances (running or stopped) with status, working directory, and last activity
- `send_to_instance` — send a message to another instance or external session; supports structured metadata (`request_kind`, `requires_reply`, `correlation_id`, `task_summary`)
- `start_instance` — wake a stopped instance so you can message it
- `create_instance` — create a new instance with a topic (directory optional; auto-created at `~/.agend/workspaces/<name>` if omitted); supports `branch` for git worktree isolation
- `delete_instance` — remove an instance and its topic
- `replace_instance` — replace an instance with a fresh one (handover + delete + create)
- `describe_instance` — get detailed info about a specific instance (description, model, last activity)

**High-level collaboration tools** (prefer these over raw `send_to_instance`):

- `request_information` — ask another instance a question and expect a reply (`request_kind=query`, `requires_reply=true`)
- `delegate_task` — assign work to another instance with success criteria (`request_kind=task`, `requires_reply=true`)
- `report_result` — return results to the requester, echoing `correlation_id` to link the response to its request

**Team tools** (target groups of instances):

- `create_team` — define a named group of instances
- `list_teams` — list all teams with member details
- `update_team` — add/remove members or update description
- `delete_team` — remove a team definition
- `broadcast(team: "name", ...)` — send a message to all members of a team

When an instance sends to another, a notification appears in the target's topic: `sender → receiver: summary`. General Topic instances are excluded from these notifications to reduce noise.

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
    "agend": {
      "command": "node",
      "args": ["path/to/dist/channel/mcp-server.js"],
      "env": {
        "AGEND_SOCKET_PATH": "~/.agend/instances/<name>/channel.sock"
      }
    }
  }
}
```

The daemon automatically isolates external sessions from internal ones using env var layering:

| Session type | Identity source | Example |
|---|---|---|
| Internal (daemon-managed) | `AGEND_INSTANCE_NAME` via tmux env | `ccplugin` |
| External (custom name) | `AGEND_SESSION_NAME` in `.mcp.json` env | `dev` |
| External (zero-config) | `external-<basename(cwd)>` fallback | `external-myproject` |

Internal sessions get `AGEND_INSTANCE_NAME` injected by the daemon into the tmux shell environment. External sessions don't have this, so they fall through to `AGEND_SESSION_NAME` (if set) or an auto-generated name based on the working directory. This means the same `.mcp.json` produces different identities for internal vs external sessions — no configuration conflicts.

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

When the primary model hits a rate limit, the daemon automatically switches to a backup model on the next session restart. Configure a fallback chain in `fleet.yaml`:

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
npm install agend-plugin-slack
```

The daemon discovers adapters matching the `agend-plugin-*` or `agend-adapter-*` naming convention. Channel types are exported from the package entry point for adapter authors.

## Kiro CLI backend

Backend for AWS Kiro CLI (`backend: kiro-cli`). Supports session resume, MCP config, and models: `auto`, `claude-sonnet-4.5`, `claude-haiku-4.5`. Configure in `fleet.yaml` like any other backend.

## agend quickstart

Simplified 4-question setup wizard for new users. Auto-detects installed backends, auto-discovers Telegram group ID via `getUpdates` polling, and generates a minimal `fleet.yaml` with sensible defaults. Replaces the 9-step `agend init` as the recommended onboarding path.

## Web Dashboard

`agend web` launches a browser-based dashboard with live fleet monitoring via Server-Sent Events (SSE). Includes an integrated chat UI with bidirectional sync to Telegram — messages sent from the Web UI appear in Telegram and vice versa.

## Built-in workflow template

Fleet collaboration workflow is auto-injected via MCP instructions. The `workflow` field in `fleet.yaml` controls this:

- `"builtin"` (default) — standard collaboration workflow
- `"file:./path.md"` — custom workflow from file
- `false` — disable workflow injection

## Workflow layering: coordinator vs executor

The General instance receives the full coordinator playbook (choosing collaborators, task sizing, delegation principles, goal & decision management). Other instances get a slimmed executor workflow (communication rules, progress tracking, context protection). This ensures the General instance acts as an intelligent dispatcher while worker instances stay focused.

## Crash-aware snapshot restore

Context snapshots are now written on crash detection, not just on context rotation. The snapshot file persists on disk with an in-memory consumption flag, enabling recovery even after daemon restarts. Agents resume with context after unexpected crashes, not just planned rotations.

## Error monitor hash dedup

The PTY error monitor records the pane content hash at recovery time. If the same error appears on the same screen, it is suppressed to prevent stale re-detection loops. This eliminates false positive error notifications from persistent terminal output.

## Parallel startup

Fleet instances now start in parallel instead of sequentially. Includes handling for tmux duplicate session race conditions that can occur when many instances spawn simultaneously.

## Fleet ready notification

After `fleet start` or `fleet restart`, a "Fleet ready. N/M instances running." message is posted to the General topic. If any instances failed to start, they are listed in the notification.

## create_instance systemPrompt parameter

Agents can pass custom system prompts when creating instances via the `systemPrompt` parameter. Supports inline text. The prompt is injected via MCP instructions alongside the fleet context.

## project_roots enforcement on create_instance

When `project_roots` is configured in `fleet.yaml`, `create_instance` validates that the requested working directory falls under one of the configured roots. Requests for directories outside the boundary are rejected with an error.

## reply_to_text injection

When a user replies to a previous message in Telegram, the quoted text is included in the formatted message delivered to the agent. This gives agents context about what the user is referring to.

## delete_instance team cleanup

When an instance is deleted via `delete_instance`, it is automatically removed from all teams it belongs to. No manual team membership cleanup is needed.

## HTML Chat Export

`agend export-chat` exports fleet activity as a self-contained HTML file. Supports `--from` and `--to` date filters and `-o` for output path. The exported file includes all messages, tool calls, and cross-instance communications in a readable chat format.

## Mirror Topic

Configure `mirror_topic_id` in `fleet.yaml` to designate a Telegram topic for observing cross-instance communication. All `send_to_instance` messages are mirrored to this topic in real time. This is a daemon-level hook with zero changes to agent behavior — agents don't know they're being observed.

## Codex session resume

OpenAI Codex backend supports session resume. When a session-id file exists, the backend uses `codex resume <session-id>` instead of starting fresh. Also detects "You've hit your usage limit" as a pause-triggering error.

## Rate limit failover cooldown

A 5-minute cooldown prevents repeated model failover triggering. After a failover occurs, subsequent rate limit errors within the cooldown window are suppressed. This prevents cascading failovers when error text persists in the terminal buffer.

## CLI UX improvements

- `agend fleet restart <name>` — restart a specific instance instead of the entire fleet
- `agend attach` — fuzzy match with interactive numbered menu when ambiguous
- `agend logs` — standalone log viewer with ANSI stripping, `-n/--lines` and `-f/--follow` options

## .env priority override

Values in `~/.agend/.env` now properly override inherited shell environment variables. This ensures token isolation — a bot token set in `.env` takes precedence over any `AGEND_BOT_TOKEN` that might exist in the shell environment.

## Backend-aware General instructions

When auto-creating the General topic instance, AgEnD writes the correct instruction file based on the configured backend:

- Claude Code → `CLAUDE.md`
- Codex → `AGENTS.md`
- Gemini CLI → `GEMINI.md`
- Kiro CLI → `.kiro/steering/project.md`
- OpenCode → uses MCP instructions directly

## Builtin text standardization

All system-generated text (schedule notifications, voice message labels, general instructions, fleet notifications) is now in English. Previously some messages were in Chinese.

## AGEND_HOME — configurable data directory

Set `AGEND_HOME` environment variable to change the data directory (default: `~/.agend`). Useful for running multiple isolated AgEnD installations. Each AGEND_HOME gets its own tmux socket to prevent conflicts.

## Fleet templates

Define reusable fleet configurations in `fleet.yaml` under the `templates` section. Deploy a template to create multiple instances and a team in one operation:

- `deploy_template` — creates instances (each with its own git worktree) and optionally a team
- `teardown_deployment` — stops and deletes all instances and team from a deployment
- `list_deployments` — shows active deployments with instance status

## Unified additive system prompt

Fleet instructions are injected additively — they don't override the CLI's built-in system prompt. Each backend uses its native mechanism:

- Claude Code: `--append-system-prompt-file`
- Kiro CLI: `.kiro/steering/` directory
- Gemini CLI: `GEMINI.md` in working directory
- Codex: `AGENTS.md` in working directory
- OpenCode: MCP instructions

## Auto-dismiss interactive prompts

Backend-defined startup and runtime dialogs are automatically dismissed without human intervention:

- Trust folder confirmations
- Resume session pickers
- Rate limit model switch prompts (Codex)
- Permission bypass confirmations

Each backend defines its own dialog patterns and key sequences in `getStartupDialogs()` and `getRuntimeDialogs()`.

## CLI mode (agent_mode)

Alternative to MCP tools for backends that don't support MCP well. Set `agent_mode: cli` in fleet.yaml to use an HTTP-based agent CLI endpoint instead of MCP server. The agent CLI provides the same fleet tools via command-line HTTP calls.

## Error state warning

When `send_to_instance`, `delegate_task`, or `request_information` targets an instance that is rate-limited, paused, or in crash loop, the sender receives a warning in the tool response:

```json
{ "sent": true, "warning": "instance-name is currently in error state..." }
```

The message is still delivered — the warning is advisory, letting the sender decide whether to retry or escalate.

## systemPrompt file paths

The `systemPrompt` field in fleet.yaml supports a `file:` prefix to load content from a file:

```yaml
instances:
  my-project:
    systemPrompt: "file:prompts/role.md"
```

The file path is resolved relative to the working directory. If the file doesn't exist, the prompt is treated as empty.

## Staggered startup

Configure parallel instance startup with concurrency limits:

```yaml
defaults:
  startup:
    concurrency: 3        # max instances starting simultaneously
    stagger_delay_ms: 2000 # delay between groups
```

Instances sharing the same working directory are serialized within a group to avoid config file races.
