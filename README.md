# claude-channel-daemon

A reliable daemon wrapper for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) Channels. Runs Claude Code CLI as a long-lived background service with automatic session management, context window rotation, and memory backup.

[中文版 README](README.zh-TW.md)

## Why

Claude Code's Telegram plugin requires an active CLI session — close the terminal and the bot dies. This daemon solves that by:

- Running Claude Code in the background via `node-pty`
- Automatically restarting on crashes with exponential backoff
- Rotating sessions when context usage gets too high
- Backing up memory to SQLite
- Installing as a system service (launchd / systemd)

## Quick Start

```bash
# Clone and install
git clone https://github.com/suzuke/claude-channel-daemon.git
cd claude-channel-daemon
npm install

# Interactive setup
npx tsx src/cli.ts init

# Start the daemon
npx tsx src/cli.ts start
```

## CLI Commands

```
claude-channel-daemon start    Start the daemon
claude-channel-daemon stop     Stop the daemon
claude-channel-daemon status   Show running status
claude-channel-daemon logs     Show daemon logs (-n lines, -f follow)
claude-channel-daemon install  Install as system service
claude-channel-daemon uninstall Remove system service
claude-channel-daemon init     Interactive setup wizard
```

## Architecture

```
┌─────────────────────────────────────────────┐
│              claude-channel-daemon           │
│                                             │
│  ┌─────────────────┐  ┌──────────────────┐  │
│  │ Process Manager  │  │ Context Guardian │  │
│  │ (node-pty)       │  │ (rotation)       │  │
│  └────────┬─────────┘  └────────┬─────────┘  │
│           │                      │            │
│  ┌────────┴─────────┐  ┌────────┴─────────┐  │
│  │  Memory Layer     │  │   Service        │  │
│  │  (SQLite backup)  │  │   (launchd/      │  │
│  │                   │  │    systemd)      │  │
│  └───────────────────┘  └──────────────────┘  │
│                                             │
│           ┌──────────────┐                  │
│           │  Claude Code  │                  │
│           │  CLI (PTY)    │                  │
│           │  + Telegram   │                  │
│           │    Plugin     │                  │
│           └──────────────┘                  │
└─────────────────────────────────────────────┘
```

### Process Manager

Spawns Claude Code via `node-pty` with channel mode enabled. Handles session persistence (resume via UUID), graceful shutdown (`/exit`), and automatic restarts with configurable backoff.

### Context Guardian

Monitors context window usage via Claude Code's status line JSON. Triggers session rotation when usage exceeds the configured threshold or max session age. Supports three strategies: `status_line`, `timer`, or `hybrid`.

### Memory Layer

Watches Claude's memory directory with chokidar and backs up files to SQLite for persistence across session rotations.

### Service Installer

Generates and installs system service files — launchd plist for macOS, systemd unit for Linux. Starts automatically on boot.

## Configuration

Config file: `~/.claude-channel-daemon/config.yaml`

```yaml
channel_plugin: telegram@claude-plugins-official
working_directory: /path/to/your/project

restart_policy:
  max_retries: 10
  backoff: exponential  # or linear
  reset_after: 300      # seconds of stability before resetting retry counter

context_guardian:
  threshold_percentage: 80  # rotate when context reaches this %
  max_age_hours: 4          # max session age before rotation
  strategy: hybrid          # status_line | timer | hybrid

memory:
  auto_summarize: true
  watch_memory_dir: true
  backup_to_sqlite: true

log_level: info  # debug | info | warn | error
```

## Data Directory

All state is stored in `~/.claude-channel-daemon/`:

| File | Purpose |
|------|---------|
| `config.yaml` | Main configuration |
| `daemon.pid` | Process ID (while running) |
| `session-id` | Saved UUID for session resume |
| `statusline.json` | Current context/cost status |
| `claude-settings.json` | Injected Claude Code settings |
| `memory.db` | SQLite memory backup |
| `.env` | Telegram bot token |

## Permissions

The daemon injects a settings file with pre-configured permissions:

**Allowed:** Read, Edit, Write, Glob, Grep, Bash, WebFetch, WebSearch, Agent, Telegram reply

**Denied:** `rm -rf /`, `git push --force`, `git reset --hard`, `git clean -f`, `dd`, `mkfs`

A PreToolUse hook integrates with the Telegram plugin's remote approval system for dangerous operations.

## Requirements

- Node.js >= 20
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed
- Telegram bot token (created via [@BotFather](https://t.me/BotFather))

## License

MIT
