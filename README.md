# AgEnD

[![npm](https://img.shields.io/npm/v/@suzuke/agend)](https://www.npmjs.com/package/@suzuke/agend)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg)](https://nodejs.org)

**Agent Engineering Daemon** — run a fleet of AI coding agents from your phone.

One Telegram bot, multiple CLI backends (Claude Code, Gemini CLI, Codex, OpenCode), unlimited projects. Each Forum Topic is an independent agent session with crash recovery and zero babysitting.

[繁體中文](README.zh-TW.md)

> **⚠️** All CLI backends run with `--dangerously-skip-permissions` (or equivalent). See [Security](SECURITY.md).

## Problems agend solves

| Without agend | With agend |
|---|---|
| Close the terminal, agent goes offline | Runs as a system service — survives reboots |
| One terminal = one project | One bot, unlimited projects running in parallel |
| Long-running sessions accumulate stale context | Auto-rotates sessions by max age to stay fresh |
| No idea what your agents are doing overnight | Daily cost reports + hang detection alerts |
| Cron tasks disappear when the session ends | Persistent schedules backed by SQLite |
| Rate limited on one model, everything stops | Auto-failover to backup models |
| Can't approve tool use from your phone | Inline Telegram buttons with countdown + Always Allow |
| Agents work in silos, can't coordinate | Peer-to-peer collaboration via MCP tools |
| Runaway costs from unattended sessions | Per-instance daily spending limits with auto-pause |

## Quick start

```bash
brew install tmux               # macOS (prerequisite)
npm install -g @suzuke/agend    # install AgEnD
agend init                      # interactive setup (choose backend + channel)
agend fleet start               # launch the fleet
```

## Features

- **Fleet mode** — one bot, N projects, each in its own Telegram Forum Topic
- **Persistent schedules** — cron-based tasks that survive restarts (SQLite-backed)
- **Context rotation** — auto-restart long-running sessions to keep context fresh (max-age based)
- **Peer-to-peer collaboration** — agents discover, wake, and message each other via MCP tools
- **General Topic** — natural language dispatcher that routes tasks to the right agent
- **Permission relay** — inline Telegram buttons for Allow/Deny with countdown + Always Allow
- **Voice messages** — Groq Whisper transcription, talk to your agents
- **Cost guard** — per-instance daily spending limits with auto-pause
- **Hang detection** — auto-detect stuck sessions, notify with restart buttons
- **Model failover** — auto-switch to backup model on rate limits
- **Daily summary** — fleet cost report posted to Telegram
- **External sessions** — connect local Claude Code to the fleet via IPC
- **Discord adapter** — use Discord instead of (or alongside) Telegram
- **Health endpoint** — HTTP API for external monitoring
- **Webhook notifications** — push events to Slack or custom endpoints
- **System service** — one command to install as launchd/systemd service

## Requirements

- Node.js >= 20
- tmux
- One of the supported AI coding CLIs (installed and authenticated):

| Backend | Install | Auth |
|---------|---------|------|
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude` (OAuth) or `ANTHROPIC_API_KEY` |
| OpenAI Codex | `npm i -g @openai/codex` | `OPENAI_API_KEY` |
| Gemini CLI | `npm i -g @google/gemini-cli` | `gemini` (Google OAuth) |
| OpenCode | `go install github.com/opencode-ai/opencode@latest` | Configure provider API key |

- Telegram bot token ([@BotFather](https://t.me/BotFather)) or Discord bot token
- Groq API key (optional, for voice)

## Documentation

- [Features](docs/features.md) — detailed feature documentation
- [CLI Reference](docs/cli.md) — all commands and options
- [Configuration](docs/configuration.md) — fleet.yaml, .env, data directory
- [Security](SECURITY.md) — trust model and hardening

## Known limitations

- macOS (launchd) and Linux (systemd) supported; Windows is not
- Official Telegram plugin in global `enabledPlugins` causes 409 polling conflicts

## License

MIT
