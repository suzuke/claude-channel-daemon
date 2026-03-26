# claude-channel-daemon

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-compatible-blueviolet.svg)](https://docs.anthropic.com/en/docs/claude-code)

**Run a fleet of Claude Code agents from your phone.** One Telegram bot, unlimited projects — each Forum Topic is an independent Claude session with crash recovery and zero babysitting.

[繁體中文](README.zh-TW.md)

> **⚠️** The daemon uses Claude Code's native permission relay — permission requests are forwarded to Telegram as inline buttons (Allow/Deny). See [Permission System](#permission-system).

## Why this exists

Claude Code's official Telegram plugin gives you **1 bot = 1 session**. Close the terminal and it goes offline. No sandbox. No scheduling. No multi-project support.

**claude-channel-daemon** turns Claude Code into an always-on, multi-project AI engineering team you control from Telegram:

| Feature | Official Plugin | claude-channel-daemon |
|---------|:-:|:-:|
| Multiple projects simultaneously | — | **N sessions, 1 bot** |
| Survives terminal close / SSH disconnect | — | **tmux persistence** |
| Cron-based scheduled tasks | — | **Built-in** |
| Auto context rotation (prevent stale sessions) | — | **Built-in** |
| Permission requests via Telegram | — | **Inline buttons** |
| Voice messages → Claude | — | **Groq Whisper** |
| Create topic = auto-bind project | — | **Built-in** |
| Install as system service (launchd/systemd) | — | **One command** |
| Crash recovery | — | **Auto-restart** |
| Cost guard (daily spending limits) | — | **Built-in** |
| Fleet status from Telegram | — | **/status command** |
| Daily fleet summary | — | **Scheduled report** |
| Hang detection | — | **Auto-detect + notify** |

## Who is this for

- **Solo developers** who want Claude working on multiple repos around the clock
- **Small teams** sharing a single bot — each team member gets their own Forum Topic
- **CI/CD power users** who want cron-scheduled Claude tasks (daily PR reviews, deploy checks)
- **Security-conscious users** who need explicit permission approval for tool use
- Anyone who's tired of keeping a terminal window open just to talk to Claude

## How it compares

| | claude-channel-daemon | Claude Code Telegram Plugin | Cursor / Windsurf | Cline (VS Code) |
|---|:-:|:-:|:-:|:-:|
| Runs headless (no IDE/terminal) | **Yes** | Needs terminal | No | No |
| Multi-project fleet | **Yes** | 1 session | 1 window | 1 window |
| Scheduled tasks | **Yes** | No | No | No |
| Context auto-rotation | **Yes** | No | N/A | No |
| Permission approval flow | **Yes** | No | N/A | Limited |
| Mobile-first (Telegram) | **Yes** | Yes | No | No |
| Voice input | **Yes** | No | No | No |
| System service | **Yes** | No | N/A | N/A |
| Cost controls | **Yes** | No | N/A | N/A |
| Crash recovery | **Yes** | No | N/A | N/A |

## Architecture

```
                          ┌─────────────────────────────────────────────────────────┐
                          │                    Fleet Manager                        │
                          │                                                         │
Telegram ◄──long-poll──► │  TelegramAdapter (Grammy)     Scheduler (croner)        │
                          │       │                          │                      │
                          │  threadId routing table          │ cron triggers         │
                          │  #277→proj-a  #672→proj-b        │                      │
                          │       │                          │                      │
                          │  ┌────┴────┐  ┌────┴────┐  ┌────┴────┐                 │
                          │  │Daemon A  │  │Daemon B  │  │Daemon C  │                │
                          │  │Permission│  │Permission│  │Permission│                │
                          │  │Relay     │  │Relay     │  │Relay     │                │
                          │  │Context   │  │Context   │  │Context   │                │
                          │  │Guardian  │  │Guardian  │  │Guardian  │                │
                          │  └────┬─────┘  └────┬─────┘  └────┬─────┘                │
                          │       │              │              │                     │
                          │  ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐               │
                          │  │tmux win  │  │tmux win  │  │tmux win  │               │
                          │  │Claude    │  │Claude    │  │Claude    │               │
                          │  │+MCP srv  │  │+MCP srv  │  │+MCP srv  │               │
                          │  └──────────┘  └──────────┘  └──────────┘               │
                          └─────────────────────────────────────────────────────────┘
```

## Key features

### Fleet mode — one bot, many projects

Each Telegram Forum Topic maps to an independent Claude Code session. Create a topic, pick a project directory, and Claude starts working. Delete the topic, instance stops. Scale to as many projects as your machine can handle.

### Scheduled tasks

Claude can create cron-based schedules via MCP tools. Schedules survive daemon restarts (SQLite-backed).

```
User: "Every morning at 9am, check if there are any open PRs that need review"
Claude: → create_schedule(cron: "0 9 * * *", message: "Check open PRs needing review")
```

Available MCP tools: `create_schedule`, `list_schedules`, `update_schedule`, `delete_schedule`

Schedules can target a specific instance or the same instance that created them. When a schedule triggers, the daemon pushes the message to Claude as if a user sent it.

### Context rotation

Watches Claude's status line JSON. A state machine with 5 states:

```
NORMAL → PENDING → HANDING_OVER → ROTATING → GRACE
```

- **PENDING** — context exceeds threshold (default 60%), waiting for Claude to go idle
- **HANDING_OVER** — sends a prompt asking Claude to save state to `memory/handover.md`
- **ROTATING** — kills tmux window, spawns fresh session with `--resume`
- **GRACE** — 10-minute cooldown to prevent rapid re-rotation

Also rotates after `max_age_hours` (default 8h) regardless of context usage.

### Cross-instance messaging

Instances can communicate with each other via MCP tools:

- `send_to_instance` — send a message to another running instance or external session
- `list_instances` — discover all running instances and external sessions

Messages are posted to the recipient's Telegram topic for visibility. Sender topic notifications are only posted for instance-to-instance messages (not from external sessions).

### External session support

You can connect a local Claude Code session to the daemon's channel tools (reply, send_to_instance, etc.) by pointing `.mcp.json` at an instance's IPC socket:

```json
{
  "mcpServers": {
    "ccd-channel": {
      "command": "node",
      "args": ["path/to/dist/channel/mcp-server.js"],
      "env": {
        "CCD_SOCKET_PATH": "~/.claude-channel-daemon/instances/<name>/channel.sock"
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

### Graceful restart

`ccd fleet restart` sends SIGUSR2 to the fleet manager. It waits for all instances to go idle (no transcript activity for 10s), then restarts them one by one. A 5-minute timeout prevents hanging on stuck instances.

### Telegram commands

In topic mode, the bot responds to commands in the General topic:

- `/open [keyword]` — browse and bind an existing project directory to a new topic
- `/new <name>` — create a new project directory + git init + bind to topic
- `/meets "topic"` — start a multi-angle discussion using Agent Teams
- `/debate "topic"` — start a pro/con debate
- `/collab --repo ~/app "task"` — start collaborative coding with git worktrees
- `/status` — show fleet status and costs

### Permission system

Uses Claude Code's native permission relay — permission requests are forwarded to Telegram as inline buttons (Allow/Deny). When Claude requests a sensitive tool use, the daemon surfaces it to you in Telegram and waits for your response before proceeding.

### Voice transcription

Telegram voice messages are transcribed via Groq Whisper API and sent to Claude as text. Works in both topic mode and DM mode. Requires `GROQ_API_KEY` in `.env`.

### Auto topic binding

In topic mode, creating a new Telegram Forum Topic triggers an interactive directory browser. Pick a project directory → instance auto-configured, topic bound, Claude starts. Deleting a topic auto-unbinds and stops the instance.

### Cost guard

Prevent bill shock when running unattended. Configure daily spending limits in `fleet.yaml`:

```yaml
defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: "Asia/Taipei"
```

When an instance approaches the limit, a warning is posted to its Telegram topic. When the limit is reached, the instance is automatically paused and a notification is sent. Paused instances resume the next day or when manually restarted.

### Fleet status

Use `/status` in the General topic to see a live overview:

```
🟢 proj-a — ctx 42%, $3.20 today
🟢 proj-b — ctx 67%, $8.50 today
⏸ proj-c — paused (cost limit)

Fleet: $11.70 / $50.00 daily
```

### Daily summary

A daily report is posted to the General topic at a configurable time (default 21:00):

```
📊 Daily Report — 2026-03-26

proj-a: $8.20, 2 rotations
proj-b: $2.10
proj-c: $0.00 ⚠️ 1 hang

Total: $10.30
```

### Hang detection

If an instance shows no activity for 15 minutes (configurable), the daemon posts a notification with inline buttons:

- **Force restart** — stops and restarts the instance
- **Keep waiting** — dismisses the alert

Uses multi-signal detection: checks both transcript activity and statusline freshness to avoid false positives during long-running tool calls.

### Rate limit-aware scheduling

When the 5-hour API rate limit exceeds 85%, scheduled triggers are automatically deferred instead of firing. A notification is posted to the instance's topic. Deferred schedules are not lost — they will fire on the next cron tick when rate limits are below threshold.

## Quick start

```bash
git clone https://github.com/suzuke/claude-channel-daemon.git
cd claude-channel-daemon
npm install && npm link

# Prerequisites
brew install tmux        # macOS

# Interactive setup
ccd init

# Start the fleet
ccd fleet start
```

## Commands

```
ccd init                  Interactive setup wizard
ccd fleet start           Start all instances
ccd fleet stop            Stop all instances
ccd fleet restart         Graceful restart (wait for idle)
ccd fleet status          Show instance status
ccd fleet logs <name>     Show instance logs
ccd fleet history         Show event history (cost, rotations, hangs)
ccd fleet start <name>    Start specific instance
ccd fleet stop <name>     Stop specific instance
ccd schedule list         List all schedules
ccd schedule add          Add a schedule from CLI
ccd schedule delete <id>  Delete a schedule
ccd schedule enable <id>  Enable a schedule
ccd schedule disable <id> Disable a schedule
ccd schedule history <id> Show schedule run history
ccd topic list            List topic bindings
ccd topic bind <n> <tid>  Bind instance to topic
ccd topic unbind <n>      Unbind instance from topic
ccd access lock <n>       Lock instance access
ccd access unlock <n>     Unlock instance access
ccd access list <n>       List allowed users
ccd access remove <n> <uid> Remove user
ccd access pair <n> <uid> Generate pairing code
ccd export [path]         Export config for device migration
ccd export --full [path]  Export config + all instance data
ccd import <file>         Import config from export file
ccd install               Install as system service
ccd uninstall             Remove system service
```

## Configuration

Fleet config at `~/.claude-channel-daemon/fleet.yaml`:

```yaml
project_roots:
  - ~/Projects

channel:
  type: telegram
  mode: topic           # topic (recommended) or dm
  bot_token_env: CCD_BOT_TOKEN
  group_id: -100xxxxxxxxxx
  access:
    mode: locked         # locked or pairing
    allowed_users:
      - 123456789

defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: "Asia/Taipei"
  daily_summary:
    enabled: true
    hour: 21
    minute: 0
  context_guardian:
    threshold_percentage: 60
    max_age_hours: 8
  log_level: info

instances:
  my-project:
    working_directory: /path/to/project
    topic_id: 277
```

Secrets in `~/.claude-channel-daemon/.env`:
```
CCD_BOT_TOKEN=123456789:AAH...
GROQ_API_KEY=gsk_...          # optional, for voice transcription
```

## Data directory

`~/.claude-channel-daemon/`:

| Path | Purpose |
|------|---------|
| `fleet.yaml` | Fleet configuration |
| `.env` | Bot token + API keys |
| `fleet.log` | Fleet log (JSON) |
| `fleet.pid` | Fleet manager PID |
| `scheduler.db` | Schedule database (SQLite) |
| `events.db` | Event log (cost snapshots, rotations, hangs) |
| `instances/<name>/` | Per-instance data |
| `instances/<name>/daemon.log` | Instance log |
| `instances/<name>/session-id` | Session UUID for `--resume` |
| `instances/<name>/statusline.json` | Latest Claude status line |
| `instances/<name>/channel.sock` | IPC Unix socket |
| `instances/<name>/claude-settings.json` | Per-instance Claude settings |
| `instances/<name>/memory.db` | Memory file backup (SQLite) |
| `instances/<name>/output.log` | Claude tmux output capture |

## Requirements

- Node.js >= 20
- tmux
- Claude Code CLI (`claude`)
- Telegram bot token ([@BotFather](https://t.me/BotFather))
- Groq API key (optional, for voice transcription)

## Known limitations

- Only tested on macOS
- Official telegram plugin in global `enabledPlugins` causes 409 polling conflicts (daemon retries with backoff)

## License

MIT
