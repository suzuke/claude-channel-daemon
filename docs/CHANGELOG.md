# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Webhook notifications for fleet events (rotation, hang, cost alerts)
- HTTP health endpoint (`/health`, `/status`) for external monitoring
- Structured handover template with validation and retry on context rotation
- Permission relay UX improvements (timeout countdown, "Always Allow" persistence, post-decision feedback)
- Topic icon auto-update (running/stopped) + idle archive
- Filter out Telegram service messages (topic rename, pin, etc.) to save tokens

### Fixed
- Minimal `claude-settings.json` — only CCD MCP tools in allow list, no longer overrides user's global permission settings

## [1.9.1] - 2026-04-03

### Fixed
- Session snapshot now injected on health-check respawn — crash/kill recovery also gets context restored
- Snapshot paste includes "do NOT reply" instruction to prevent model from attempting an IPC reply that times out

## [1.9.0] - 2026-04-03

### Breaking Changes
- **System prompt injection replaced with MCP instructions.** Fleet context, custom `systemPrompt`, and collaboration rules are now injected via MCP server instructions instead of CLI `--system-prompt` flags. This change was necessary because:
  - Claude Code: `--system-prompt` was passed a file path as literal text instead of file contents — the fleet prompt was **never correctly injected** since inception
  - Gemini CLI: `GEMINI_SYSTEM_MD` overwrites the built-in system prompt and breaks skills functionality
  - Codex: `.prompt-generated` was dead code — written to disk but never read by the CLI
  - OpenCode: `instructions` array was overwritten instead of appended, breaking existing project instructions
- **Impact on existing setups:**
  - `fleet.yaml` `systemPrompt` field is preserved — it now injects via MCP instructions instead of CLI flags
  - `.prompt-generated`, `system-prompt.md`, `.opencode-instructions.md` files are no longer generated
  - Each CLI's built-in system prompt is no longer overridden or modified
  - Active Decisions are no longer preloaded into the system prompt — use `list_decisions` tool on demand
  - Session snapshots (context rotation) are now delivered as the first inbound message (`[system:session-snapshot]`) instead of being embedded in the system prompt

## [1.8.5] - 2026-04-03

### Fixed
- Unified log and notification format to `sender → receiver: summary` style across all cross-instance messages
- Task/query notifications now show the full message body; report/update notifications show only the summary

## [1.8.4] - 2026-04-03

### Fixed
- Cross-instance notification format: `sender → receiver: summary` for clarity
- General Topic instances no longer receive cross-instance notification posts
- Reduced cross-instance notification noise — sender topic post removed; target notification uses `task_summary` when available

## [1.8.3] - 2026-04-03

### Added
- **Team support** — named groups of instances for targeted broadcasting
  - `create_team` — define a team with members and optional description
  - `list_teams` — list all teams with member details
  - `update_team` — add/remove members or update description
  - `delete_team` — remove a team definition
  - `broadcast` now accepts a `team` parameter to target all members of a named team
  - `teams` section in `fleet.yaml` for persistent team definitions

## [1.8.2] - 2026-04-03

### Added
- `working_directory` is now optional in fleet.yaml — auto-created at `~/.agend/workspaces/<name>` when missing
- `create_instance` `directory` parameter is now optional (auto-workspace created when omitted)

### Fixed
- Context-bound routing now runs before IPC forwarding in topic mode (prevented "chat not found" errors)
- Telegram: `thread_id=1` correctly treated as General Topic (no message thread)
- Scheduler initializes before instances start, so active decisions load correctly on fleet spawn

## [1.8.1] - 2026-04-03

### Added
- `reply`, `react`, `edit_message` are now context-bound — `chat_id` and `thread_id` are no longer required in tool calls; the daemon fills them from the active conversation context
- Backend error pattern detection via PTY monitoring — auto-notify on rate limits, auth errors, and crashes
- Auto-dismiss runtime dialogs (e.g. Codex rate limit model-switch prompts)
- Model failover — auto-switch to backup model on rate limit (statusline + PTY detection)

### Fixed
- Recovery notification sent after PTY error monitor detects and handles an error
- Error monitor false positives reduced; invalid `chat_id` auto-corrected from context

## [0.3.7] - 2026-03-27

### Added
- `delete_instance` MCP tool for removing instances
- `create_instance --branch` — git worktree support for feature branches
- External adapter plugin loading — community adapters via `npm install ccd-adapter-*`
- Export channel types from package entry point for adapter authors
- Discord adapter (MVP) — connect, send/receive messages, buttons, reactions
- Per-instance restart notifications in Telegram topics after graceful restart

### Fixed
- `start_instance`, `create_instance`, `delete_instance` added to permission allow list
- Worktree instance names use `topic_name` instead of directory basename to avoid Unix socket path overflow (macOS 104-byte limit)
- `create_instance` with branch no longer triggers false `already_exists` on base repo
- postLaunch stability check replaced with 10s grace period
- Restart notification uses `fleetConfig.instances` + IPC push
- Discord adapter TypeScript errors resolved

## [0.3.6] - 2026-03-27

### Fixed
- Prevent MCP server zombie processes on instance restart
- Harden postLaunch auto-confirm against edge cases

## [0.3.5] - 2026-03-26

### Added
- Per-instance model selection via `create_instance(model: "sonnet")`
- Instance `description` field for better discoverability in `list_instances`
- Auto-prune stale external sessions from sessionRegistry (every 5 minutes)
- AgEnD landing page website (Astro + Tailwind, bilingual EN/zh-TW)
- GitHub Actions workflow for website deployment
- Security considerations section in README

### Changed
- Simplify model selection — only configurable via `create_instance`, not per-message
- Use single `query_sessions_response` for session pruning

### Fixed
- Security hardening — 10 vulnerability fixes (path traversal, input validation, etc.)
- Send full cross-instance messages to Telegram instead of 200-char preview truncation
- Remove IPC secret auth — socket `chmod 0o600` is sufficient and simpler

## [0.3.4] - 2026-03-26

### Changed
- Remove slash commands (`/open`, `/new`, `/meets`, `/debate`, `/collab`) — General instance handles project management via `create_instance` / `start_instance`
- Remove dead code: `sendTextWithKeyboard`, `spawnEphemeralInstance`, meeting channel methods

## [0.3.3] - 2026-03-25

### Fixed
- Correct `statusline.sh` → `statusline.js` in test assertion

## [0.3.2] - 2026-03-25

### Added
- Channel adapter factory with dynamic import for future multi-platform support
- Intent-oriented adapter methods: `promptUser`, `notifyAlert`, `createTopic`, `topicExists`
- "Always Allow" button on Telegram permission prompts
- Per-instance `cost_guard` field in InstanceConfig
- `topology` property on ChannelAdapter (`"topics"` | `"channels"` | `"flat"`)

### Changed
- Channel abstraction Phase A — remove all TelegramAdapter coupling from business logic (fleet-manager, daemon, topic-commands now use generic ChannelAdapter interface)
- CLI version reads from package.json instead of hardcoded value
- Schedule subcommands now have `.description()` for help text

### Fixed
- Shell injection in statusline script — replaced bash with Node.js script
- Timezone validation in setup wizard and config (Intl.DateTimeFormat)
- `max_age_hours` default aligned to 8h across setup-wizard, config, and README
- `pino-pretty` moved from devDependencies to dependencies (fixes `npm install -g`)
- `toolStatusLines` cleared on respawn to prevent unbounded growth
- Try-catch for `--config` JSON.parse in daemon-entry
- Dead code `resetToolStatus()` removed
