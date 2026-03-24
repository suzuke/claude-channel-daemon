# claude-channel-daemon

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-compatible-blueviolet.svg)](https://docs.anthropic.com/en/docs/claude-code)

**Run a fleet of Claude Code agents from your phone.** One Telegram bot, unlimited projects — each Forum Topic is an independent Claude session with Docker sandbox, crash recovery, and zero babysitting.

[繁體中文](README.zh-TW.md)

> **⚠️** The daemon pre-approves most tools. Dangerous Bash commands (rm, sudo, git push...) are forwarded to Telegram for manual approval. If the approval server is unreachable, dangerous commands are denied. See [Permission Architecture](#approval-system).

## Why this exists

Claude Code's official Telegram plugin gives you **1 bot = 1 session**. Close the terminal and it goes offline. No sandbox. No scheduling. No multi-project support.

**claude-channel-daemon** turns Claude Code into an always-on, multi-project AI engineering team you control from Telegram:

| Feature | Official Plugin | claude-channel-daemon |
|---------|:-:|:-:|
| Multiple projects simultaneously | — | **N sessions, 1 bot** |
| Survives terminal close / SSH disconnect | — | **tmux persistence** |
| Docker-sandboxed Bash execution | — | **Built-in** |
| Cron-based scheduled tasks | — | **Built-in** |
| Auto context rotation (prevent stale sessions) | — | **Built-in** |
| Dangerous command approval via Telegram | — | **Inline buttons** |
| Voice messages → Claude | — | **Groq Whisper** |
| Create topic = auto-bind project | — | **Built-in** |
| Install as system service (launchd/systemd) | — | **One command** |
| Crash recovery | — | **Auto-restart** |

## Who is this for

- **Solo developers** who want Claude working on multiple repos around the clock
- **Small teams** sharing a single bot — each team member gets their own Forum Topic
- **CI/CD power users** who want cron-scheduled Claude tasks (daily PR reviews, deploy checks)
- **Security-conscious users** who need sandboxed execution and explicit approval for dangerous commands
- Anyone who's tired of keeping a terminal window open just to talk to Claude

## How it compares

| | claude-channel-daemon | Claude Code Telegram Plugin | Cursor / Windsurf | Cline (VS Code) |
|---|:-:|:-:|:-:|:-:|
| Runs headless (no IDE/terminal) | **Yes** | Needs terminal | No | No |
| Multi-project fleet | **Yes** | 1 session | 1 window | 1 window |
| Docker sandbox | **Yes** | No | No | No |
| Scheduled tasks | **Yes** | No | No | No |
| Context auto-rotation | **Yes** | No | N/A | No |
| Command approval flow | **Yes** | No | N/A | Limited |
| Mobile-first (Telegram) | **Yes** | Yes | No | No |
| Voice input | **Yes** | No | No | No |
| System service | **Yes** | No | N/A | N/A |
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
                          │  │Approval  │  │Approval  │  │Approval  │                │
                          │  │Context   │  │Context   │  │Context   │                │
                          │  │Guardian  │  │Guardian  │  │Guardian  │                │
                          │  └────┬─────┘  └────┬─────┘  └────┬─────┘                │
                          │       │              │              │                     │
                          │  ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐               │
                          │  │tmux win  │  │tmux win  │  │tmux win  │               │
                          │  │Claude    │  │Claude    │  │Claude    │               │
                          │  │+MCP srv  │  │+MCP srv  │  │+MCP srv  │               │
                          │  └────┬─────┘  └────┴─────┘  └────┴─────┘               │
                          └───────┼─────────────────────────────────────────────────┘
                                  │ CLAUDE_CODE_SHELL
                                  ▼
                          ┌─────────────────────────────────────────┐
                          │         Docker Container (ccd-shared)   │
                          │                                         │
                          │  All Bash commands execute here          │
                          │  ~/projects/ (bind mount)               │
                          │  ~/.claude/ (bind mount)                │
                          │                                         │
                          │  Isolated from: ~/Desktop, ~/Downloads  │
                          │  /etc, /usr, host processes             │
                          └─────────────────────────────────────────┘
```

## Key features

### Fleet mode — one bot, many projects

Each Telegram Forum Topic maps to an independent Claude Code session. Create a topic, pick a project directory, and Claude starts working. Delete the topic, instance stops. Scale to as many projects as your machine can handle.

### Docker sandbox

Bash commands run inside a shared Docker container. Claude Code itself stays on the host (preserving Keychain auth, tmux attach, hooks). Only shell execution is sandboxed.

```yaml
# fleet.yaml
sandbox:
  enabled: true
  network: bridge    # "none" (default) = no network; "bridge" = full network (needed for apt/pip install)
  extra_mounts:
    - ~/.gitconfig:~/.gitconfig:ro
    - ~/.ssh:~/.ssh:ro
```

**How it works:** The daemon sets `CLAUDE_CODE_SHELL` to a wrapper script (`sandbox-bash`) that forwards commands via `docker exec` to the shared container. All project directories are bind-mounted at their original absolute paths — zero path translation needed.

**Auto-bake:** When Claude installs packages inside the container (pip, apt, cargo, npm), the daemon records these commands. During context rotation, if enough packages have accumulated, it automatically appends them to `Dockerfile.sandbox` and rebuilds the image — so packages persist across container rebuilds. Run `ccd sandbox bake --dry-run` to preview, or `ccd sandbox bake` to trigger manually.

**What's isolated:**
| Visible inside sandbox | NOT visible |
|----------------------|-------------|
| `project_roots` directories (rw) | `~/Desktop`, `~/Downloads` |
| `~/.claude/` (sessions, auth) | `/etc`, `/usr` (host) |
| `~/.gitconfig`, `~/.ssh` (ro) | Host processes |
| `$TMPDIR` (cwd tracking) | Other user directories |

**What's NOT sandboxed:** Claude's built-in file tools (Read, Write, Edit, Glob, Grep) operate directly on the host filesystem — only Bash tool commands go through Docker.

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

### Approval system

A PreToolUse hook forwards every Bash command to the approval server:

| Command | Result |
|---------|--------|
| `ls`, `cat`, `npm install`, `git status` | Auto-approved |
| `rm`, `mv`, `sudo`, `kill`, `git push/reset/clean` | → Telegram inline buttons |
| `rm -rf /`, `dd`, `mkfs` | Hard-denied in settings |
| Approval server unreachable | Denied (fail-closed) |

```
Claude calls Bash tool
  → PreToolUse hook fires (on host, not in Docker)
  → curl POST to approval server (127.0.0.1:PORT)
  → safe? → allow
  → dangerous? → IPC → fleet manager → Telegram inline buttons → you decide
  → server down? → deny
```

### Voice transcription

Telegram voice messages are transcribed via Groq Whisper API and sent to Claude as text. Works in both topic mode and DM mode. Requires `GROQ_API_KEY` in `.env`.

### Auto topic binding

In topic mode, creating a new Telegram Forum Topic triggers an interactive directory browser. Pick a project directory → instance auto-configured, topic bound, Claude starts. Deleting a topic auto-unbinds and stops the instance.

## Quick start

```bash
git clone https://github.com/suzuke/claude-channel-daemon.git
cd claude-channel-daemon
npm install && npm link

# Prerequisites
brew install tmux        # macOS
# Docker Desktop or OrbStack (for sandbox mode)

# Interactive setup
ccd init

# Start the fleet
ccd fleet start
```

### Docker sandbox setup

```bash
# Build the sandbox image (one-time)
docker build -f Dockerfile.sandbox -t ccd-sandbox:latest \
  --build-arg HOST_UID=$(id -u) --build-arg HOST_GID=$(id -g) .

# Add to fleet.yaml:
#   sandbox:
#     enabled: true

# Restart fleet — container is created automatically
ccd fleet stop && ccd fleet start
```

## Commands

```
ccd init                  Interactive setup wizard
ccd fleet start           Start all instances
ccd fleet stop            Stop all instances
ccd fleet status          Show instance status
ccd fleet logs <name>     Show instance logs
ccd fleet start <name>    Start specific instance
ccd fleet stop <name>     Stop specific instance
ccd schedule list         List all schedules
ccd schedule delete <id>  Delete a schedule
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
sandbox:
  enabled: true
  extra_mounts:
    - /Users/me/.gitconfig:/Users/me/.gitconfig:ro
    - /Users/me/.ssh:/Users/me/.ssh:ro

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
| `instances/<name>/` | Per-instance data |
| `instances/<name>/daemon.log` | Instance log |
| `instances/<name>/session-id` | Session UUID for `--resume` |
| `instances/<name>/statusline.json` | Latest Claude status line |
| `instances/<name>/channel.sock` | IPC Unix socket |
| `instances/<name>/sandbox-bash` | Sandbox shell wrapper (when enabled) |
| `instances/<name>/claude-settings.json` | Per-instance Claude settings |
| `instances/<name>/memory.db` | Memory file backup (SQLite) |
| `instances/<name>/output.log` | Claude tmux output capture |

## Requirements

- Node.js >= 20
- tmux
- Claude Code CLI (`claude`)
- Telegram bot token ([@BotFather](https://t.me/BotFather))
- Docker Desktop or OrbStack (optional, for sandbox mode)
- Groq API key (optional, for voice transcription)

## Known limitations

- Only tested on macOS (Docker sandbox uses macOS-specific paths)
- Sandbox only isolates Bash tool — Read/Write/Edit/Glob/Grep operate on host filesystem
- `~/.ssh` is mounted read-only into sandbox — Claude can read but not modify SSH keys
- Official telegram plugin in global `enabledPlugins` causes 409 polling conflicts (daemon retries with backoff)

## License

MIT
