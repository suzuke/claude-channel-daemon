# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **Health check loop stops when instance directory is removed externally** — previously, `rm -rf ~/.agend/instances/<name>` while the daemon was running caused the health check to respawn-crash every ~30s indefinitely, spamming `ENOENT … rotation-state.json` / `tmux server died` / `Failed to respawn Claude window`. Loop now detects missing `instanceDir` at the start of each tick and pauses itself.

## [1.23.0] - 2026-04-20

Phase 1–4 of the security/reliability fix plan (`docs/fix-plan.md`) closes here. 36 individual fixes/refactors across 7 PRs (#33, #38, #39, #40, #41, #42, #43, #44).

### Security
- **Phase 1 boundaries** (PR #33) — per-instance `/agent` token, zod validation on all `/ui/*` mutations, template var sanitization, tar entry validation, symlink resolution for `project_roots`, branch/logPath argument injection hardening, `web.token` 0o600.
- **Telegram apiRoot allowlist** (P3.3, `9a7b16b`) — prevents bot-token exfil via attacker-controlled `apiRoot`.
- **Webhook HMAC-SHA256 signing** (P3.1, `e65b97c`) — outbound webhooks now signed; receivers can verify origin.
- **STT requires explicit opt-in** (P3.4, `1fc513e`) — voice transcription no longer activates from env var alone; needs `stt.enabled: true` in `fleet.yaml`.
- **`/update` hardened** (P3.6, `740c202`, `d38a583`) — empty `allowed_users` rejects `/update` entirely; two-step token confirm (8 hex, 60s TTL); version pin during install; auto-rollback on health check fail; supersede notifications.
- **`access-path` rejects path traversal in instance names** (P4.3, `d5d41b7`) — whitelist `^[A-Za-z0-9._-]+$`, rejects `..` / `/` / `\` / NUL.
- **`.env` file mode 0o600** (P4.4, `49a4328`) — wizard writes credential files with restrictive permissions + chmod fallback.
- **CORS tightened, Bearer auth supported** (P3.5, `b180232`) — wildcard CORS removed; web API accepts `Authorization: Bearer <token>` header.
- **`paths.ts` md5 → sha256** (P4.5, `1f91c3c`) — eliminates FIPS / scanner alerts. Custom `AGEND_HOME` users will see tmux session/socket suffix change once on upgrade.

### Fixed
- **Telegram 409 polling cap** (P3.2, `c67f776`) — caps retries to 30 to prevent infinite poll loops.
- **Topic archiver persistence** (P2.6, `f134a66`, `42d5d1f`) — archived topic state now persists across restarts via atomic write of `<dataDir>/archived-topics.json`.
- **IPC single-line buffer cap 10MB → 1MB** (P3.7, `d446384`) — overflow rejected with structured error instead of OOM.
- **Tmux pane cache invalidation on control-mode reconnect** (P2.1, `e967bbb`).
- **TranscriptMonitor reentry guard** (P2.4, `65be144`) — prevents overlapping `pollIncrement` runs.
- **Scheduler catch-up for missed runs within 24h** (P2.3, `01e1e32`, `24d6f8a`).
- **Cost-guard daily-cap reset on session rotation** (P2.2, `875a0b2`) — `warnEmitted`/`limitEmitted` flags now reset properly so post-rotation sessions don't silently exceed daily cap.
- **SSE dead client eviction + socket error handling** (P2.5, `ae2a810`) — `broadcastSseEvent` no longer breaks the loop on a dead client write; `req.on("error")` now cleans up client set on ECONNRESET.
- **Drop redundant sleep+reconnect after instance start** (P2.7, `872547b`) — `startInstance` await chain already guarantees IPC ready; secondary `connectIpcToInstance` was pure dead code.
- **Cost-guard DST handling** (P2.8, `3c9ff9f`) — `msUntilMidnight` now uses `Intl.DateTimeFormat` + binary search instead of `setHours(24,0,0,0)`, so DST spring/fall transitions don't shift the daily reset by ±1h.
- **MessageQueue flood-control backoff reset** (P3.8, `3474c04`) — backoff now actually resets after status_update drop instead of staying at ~30s.

### Changed
- **`fleet-manager.ts` decomposed** (P4.1, PR #43) — 2842 → 1658 lines (-1184). Four new modules:
  - `fleet-dashboard-html.ts` (442 lines) — dashboard HTML constant
  - `fleet-instructions.ts` (168 lines) — `GENERAL_INSTRUCTIONS` + `ensureGeneralInstructions`
  - `fleet-rpc-handlers.ts` (387 lines) — IPC + HTTP CRUD dispatch
  - `fleet-health-server.ts` (326 lines) — `startHealthServer` + `getUiStatus` + `extractWebToken`

  All modules use a Context-injection pattern: each declares a narrow `XxxContext` interface, FleetManager `implements` it, and exported functions take `this` as their first arg.
- **`daemon.handleToolCall` factored** (P4.2, `e6a9596`) — extracted `dispatchFleetRpc(fleetReqId, broadcast, timeoutMs, timeoutMessage, respond)` helper. `handleToolCall` 182 → ~120 lines, daemon.ts -51 lines net.
- **`validateTimezone` unified** (P4.4, `49a4328`) — `scheduler/scheduler.ts` no longer duplicates the validator; imports the canonical version from `config.ts`.

### Docs
- **`docs/fix-plan.md` Phase 1–4 closed** — all P-items either ✅ or moved to **Deferred / Future Work** (logger rotation, cost-guard tiebreaker — both feature-class, not fix-class).
- **`docs/p4.1-split-plan.md` archived** — record of the four-module decomposition strategy.
- **`docs/issue-evaluations.md` added** — analysis of open issues #24 (usage-limit notify) and #8 (default topic preset) with effort/tradeoff breakdowns for future planning.

## [1.22.1] - 2026-04-19

### Fixed
- **Discord attachment download** — `downloadAttachment()` now actually works. Attachments are fetched from the Discord CDN and written to `inboxDir` during `messageCreate` (before the CDN URL expires), and `downloadAttachment()` returns the local path. Also: image attachments are classified as `photo` (enables auto-download on the agent side), filenames are prefixed with the Discord attachment ID to prevent collisions, downloads run in parallel across a message's attachments, failures are logged instead of silently swallowed, and `stop()` cleans up any undrained files. Closes #27.

## [1.22.0] - 2026-04-18

### Added
- **`agend ls` shows Kiro CLI context usage** — for instances running Kiro backend, the listing now reports current context window consumption alongside the other status columns.
- **`agend ls` shows system memory usage** — top-of-listing summary includes host memory pressure so fleet operators can spot memory-starved boxes at a glance.
- **Install script WSL detection** — `install.sh` now detects WSL and avoids picking up a Windows-side `node` on the Linux PATH, which previously caused silent failures during first-run setup.

### Changed
- **Install script URL uses GitHub Pages** — README one-liner points at `https://suzuke.github.io/AgEnD/install.sh` (the official hosted copy) instead of a raw GitHub URL.

### Docs
- **Install one-liner surfaced in both READMEs and the website hero** — previously only documented in the CHANGELOG.
- **WSL installation notes added to README**.
- **Website zh-TW hero tightened** — dropped shipping-speak (`交付`) in favor of dispatcher vocabulary consistent with the rest of the page.

## [1.21.7] - 2026-04-17

### Changed
- **MCP tool schemas unified on zod** — every outbound tool now has a zod schema in `src/outbound-schemas.ts`; `src/channel/mcp-tools.ts` derives `inputSchema` via `z.toJSONSchema()`. Hand-written JSON Schema removed. Required fields now reject empty strings (`minLength: 1`) where the old handlers relied on truthy checks.
- **Outbound handlers validate at entry** — all 18 handlers in `src/outbound-handlers.ts` run `safeParse` before doing work; the ~35 unchecked `args.X as string` casts are gone. `wrapAsSend` also takes a schema, so `request_information` / `delegate_task` / `report_result` get the same guarantees.

## [1.21.6] - 2026-04-17

### Security
- **Web API surface hardening** (H1, H2, H7)
- **Auth, path safety, and leak fixes** across the daemon (H3, H4, H5, H6)
- **Backend command hardening** — model name validation and env value quoting in `buildCommand()`
- **CLI helpers** — avoid shell invocation and redact tokens from `ps` output
- **Scheduler hardening** — timezone whitelist, file count cap, lightweight mode guard
- **Kiro MCP wrapper permissions** — `wrapper.sh` tightened to `0o700` (owner-only)
- **Outbound error sanitization** — tool errors returned to agents strip `$HOME` paths and truncate at 300 chars before exposure

### Fixed
- **Discord expired interaction crash** — adapter now catches expired-interaction errors to prevent daemon crash (upstream PR #26)
- **Scheduler overlapping fires** — atomic update prevents double-firing when two ticks race

### Changed
- **Fleet-manager error observability** — previously swallowed errors are now logged; adapter notices promoted to higher severity

## [1.21.5] - 2026-04-15

### Added
- **Error state warning on `send_to_instance`** — when the target instance is rate-limited, paused, or in crash loop, the sender receives a warning in the tool response (#24)
- **Codex weekly limit detection** — detects "less than N% of your weekly limit" warning and notifies via Telegram (action: notify)

### Fixed
- **MCP server orphan detection via ppid polling** — primary orphan detection now uses `process.ppid` polling (5s interval) instead of stdin EOF, which fails on macOS due to a libuv/kqueue bug that causes CPU spin instead of emitting `'end'`
- **Fleet-level tmux server circuit breaker** — 2+ tmux server crashes in 5 minutes pauses all instance respawns for 30s, preventing thundering herd
- **Process tree kill on spawn failure** — `killProcessTree()` sends SIGTERM to the entire process group (CLI + MCP server) before killing the tmux window
- **Sliding window crash detection** — replaced `rapidCrashCount` (broken by backoff delays > 60s) with `crashTimestamps` sliding window: 3+ crashes in 5 minutes triggers pause

## [1.21.4] - 2026-04-14

### Fixed
- **MCP server orphan cleanup on crash respawn** — daemon reads `channel.mcp.pid` and kills orphan MCP server before spawning new CLI
- **stdin EOF detection for MCP server** — added `process.stdin.on('end'/'close'/'error')` listeners and PID file mechanism (later superseded by ppid polling in v1.21.5)

## [1.21.3] - 2026-04-14

### Fixed
- E2E: mock CLI crash should exit with code 1, not 0

## [1.21.2] - 2026-04-13

### Fixed
- **Delay writing prev-instructions until session established** — prevents change detection from failing on retry when first spawn attempt fails
- E2E: update workflow-template test assertions for new heading behavior

## [1.21.1] - 2026-04-13

### Fixed
- **Kiro CLI 2.0.0 support** — updated ready pattern and startup dialogs for new TUI; fixed false "not found" match

## [1.21.0] - 2026-04-13

### Added
- **CLI mode** — `agent_mode: cli` config switches from MCP tools to HTTP-based agent CLI endpoint
- **Agent CLI endpoint** — HTTP-based alternative to MCP tools for backends that don't support MCP well
- **Idle task nudge** — automatically nudges idle instances with pending tasks from the task board

### Fixed
- Kiro: auto-dismiss trust-all-tools TUI confirmation on startup
- OpenCode: don't add `--continue` when skipResume is true

## [1.20.4] - 2026-04-12

### Added
- **Auto-dismiss interactive prompts** — backend-defined startup and runtime dialogs are automatically dismissed (trust folders, resume pickers, rate limit model switches)
- **systemPrompt file: paths** — supports comma-separated `file:` paths and YAML arrays for multi-file prompt modularization

### Fixed
- Claude Code: add session resume prompt to startup dialogs
- Instructions: avoid empty Development Workflow heading when workflow content has its own headers
- Handle EADDRINUSE on health server — kill old process and retry
- Discord onboarding: 10 UX pain points fixed
- Kiro: use single-quoted env exports in MCP wrapper to prevent backtick/dollar interpretation

## [1.20.2] - 2026-04-11

### Added
- **`agend health`** — fleet health diagnostics via HTTP endpoint (`/health`, `/status`)
- **Communication efficiency rules** in workflow template — structured task flow, silence = agreement, batch points

### Fixed
- OpenCode skipResume not honored + restart notification mismatch
- Safe worktree cleanup when directory is not a valid git worktree

### Changed
- Communication protocol refactored — reduce ack spam with structured task flow

## [1.20.0] - 2026-04-10

### Added
- **`replace_instance` tool** — atomically replace an instance with a fresh one, collecting handover context from the daemon's ring buffer
- **ContextGuardian simplified** — removed max_age timer, state machine, and all restart triggers. Pure monitoring only.

### Fixed
- Skip snapshot injection when `--resume` succeeds on crash recovery
- Clean stale MCP entries on instance removal + writeConfig

## [1.19.1] - 2026-04-10

### Fixed
- **3 UX pain points** — instructions reload on restart, config reload on single instance restart, Web UI create instance missing fields

## [1.19.0] - 2026-04-09

### Added
- **Fleet templates** — `deploy_template` / `teardown_deployment` / `list_deployments` for reusable fleet configurations
- **Configurable staggered startup** — `startup.concurrency` and `startup.stagger_delay_ms` in fleet.yaml defaults
- **Backend column** in fleet status and MCP `list_instances`

### Changed
- `agend logs` consolidated — reads fleet.log directly
- `agend fleet status` and `agend ls` merged into single command

### Fixed
- Clean up orphaned tmux windows on fleet startup
- Prevent quit command race condition during fleet stopAll

## [1.18.0] - 2026-04-08

### Added
- **Unified additive system prompt injection** — all 5 backends now use `--append-system-prompt-file` (Claude Code), steering files (Kiro), or equivalent. Fleet instructions no longer override built-in prompts.

### Fixed
- Always kill tmux window on instance stop/delete
- OpenCode uses "instructions" not "contextPaths" in opencode.json

## [1.17.5] - 2026-04-08

### Added
- **Crash output capture** — captures tmux pane content on crash for diagnostics
- **tmux server crash detection** — distinguishes server-level crash from single window crash

### Fixed
- Kiro MCP env isolation — wrapper script approach replaces process.env pollution
- Kiro MCP transport handshake failure — stdin race condition
- Graceful shutdown via quit command before killing tmux window
- Distinguish normal exit (code 0) vs crash by exit code in health check
- Pre-trust codex workspace + add trust dialog pattern
- Fleet start `--instance` delegates to running daemon via HTTP API

## [1.17.3] - 2026-04-07

### Added
- **Per-instance memory usage** in `agend ls`
- **Channel-aware replies** — pass source in inbound meta + fix format passthrough

### Fixed
- Codex MCP shell escaping + stale snapshot injection on restart

## [1.17.1] - 2026-04-07

### Added
- **tmux socket isolation** for custom AGEND_HOME — prevents conflicts between multiple AgEnD installations

## [1.17.0] - 2026-04-07

### Added
- **`AGEND_HOME` env var** — configurable data directory (default: `~/.agend`)

### Fixed
- Kiro CLI crash loop on restart — skipResume + tmux cleanup

## [1.16.2] - 2026-04-07

### Fixed
- Crash respawn orphan cleanup must not block spawnClaudeWindow

## [1.16.1] - 2026-04-07

### Fixed
- Prevent tmux server death during concurrent context rotation
- P2 code review improvements

## [1.16.0] - 2026-04-07

### Fixed
- P0+P1 code review findings (security, error handling, edge cases)

## [1.15.8] - 2026-04-06

### Fixed
- Codex uses `resume --last` (per-CWD scoped, no SQLite dependency)

## [1.15.6] - 2026-04-06

### Fixed
- Kiro resume uses boolean `--resume` flag

## [1.15.5] - 2026-04-06

### Fixed
- Error monitor scans only after last prompt marker (reduces false positives)

## [1.15.3] - 2026-04-06

### Fixed
- stop() cleanup + IPC reconnect on restart (#14, #12)

## [1.15.1] - 2026-04-06

### Added
- **Auto-inject active decisions** into MCP instructions via env var
- `/update` topic command for refreshing instance configuration

## [1.15.0] - 2026-04-06

### Added
- Webhook notifications for fleet events (rotation, hang, cost alerts)
- HTTP health endpoint (`/health`, `/status`) for external monitoring
- Structured handover template with validation and retry on context rotation
- Permission relay UX improvements (timeout countdown, "Always Allow" persistence, post-decision feedback)
- Topic icon auto-update (running/stopped) + idle archive
- Filter out Telegram service messages (topic rename, pin, etc.) to save tokens

### Changed
- **Crash recovery tries --resume first** — on crash respawn, attempts `--resume` to restore full conversation history before falling back to fresh session + snapshot injection

### Fixed
- Minimal `claude-settings.json` — only AgEnD MCP tools in allow list, no longer overrides user's global permission settings

## [1.14.0] - 2026-04-07

### Added
- **Plugin system + Discord adapter extraction** — Discord adapter moved to standalone `agend-plugin-discord` package; factory.ts supports `agend-plugin-{type}` / `agend-adapter-{type}` / bare name conventions; main package exports (`/channel`, `/types`) enable third-party plugins
- **Web UI Phase 2: full control dashboard** — instance stop/start/restart/delete with name confirmation, create instance form (directory optional, backend auto-detect), task board CRUD, schedule management, team management, fleet config editor (form-based with sensitive field masking)
- **Web UI layout: Fleet vs Instance** — sidebar "Fleet" entry for fleet-level tabs (Tasks, Schedules, Teams, Config); instance tabs limited to Chat + Detail; cross-navigation links between fleet and instance views
- **Web UI UX improvements** — toast notifications, loading states, cron human-readable descriptions, larger status dots, empty state guidance, cost labels, website-consistent styling (#2AABEE accent, Inter + JetBrains Mono fonts)
- **Backend auto-detection** — `GET /ui/backends` scans PATH for installed CLIs; Create Instance dropdown shows installed/not-installed status
- **Instance-specific restart** — `agend fleet restart <instance>` via fleet HTTP API (`POST /restart/:name`)
- **Bootstrap install script** — `curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash`
- **project_roots enforcement** — `create_instance` rejects directories outside configured roots

### Fixed
- **Web UI reply context** — first web message no longer causes "No active chat context"; uses real Telegram group_id/topic_id
- **Web↔Telegram bidirectional sync** — web messages forwarded to Telegram with `🌐` prefix; Telegram messages pushed to Web UI via SSE
- **SSE instant status refresh** — action buttons update immediately after stop/start/restart/delete
- **.env override** — `.env` file values unconditionally override inherited shell environment variables
- **tmux duplicate session race** — `ensureSession()` handles concurrent parallel startup
- **Create Instance form** — directory optional with dynamic topic_name requirement

### Changed
- **discord.js removed from core dependencies** — only needed when `agend-plugin-discord` is installed
- **Web API extracted to `web-api.ts`** — reduces fleet-manager.ts size; all `/ui/*` routes in dedicated module
- **Auth unified** — all Web UI endpoints (including restart) require token authentication

## [1.13.0] - 2026-04-06

### Added
- **Web UI Phase 2: full control dashboard** — create/delete instances, task board CRUD (create, claim, complete), schedule management (create, delete), team management (create with member checkboxes, delete), fleet config viewer (read-only, sanitized)
- **Web UI styling** — aligned with website design: Telegram blue `#2AABEE` accent, Inter + JetBrains Mono fonts, dark theme, rounded cards, toast notifications, loading states
- **Bootstrap install script** — `curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash` for one-line setup (Node.js via nvm, tmux, agend, backend detection)
- **project_roots enforcement** — `create_instance` rejects directories outside configured `project_roots` boundary
- **Auth unification** — all Web UI endpoints (including restart) require token authentication

### Fixed
- **Web UI reply context** — first message from Web UI no longer causes "No active chat context" error; uses real Telegram group_id/topic_id
- **Instant status refresh** — instance action buttons update immediately after stop/start/restart/delete via SSE
- **Web↔Telegram bidirectional sync** — web messages forwarded to Telegram topic with `🌐` prefix; Telegram messages pushed to Web UI via SSE

### Documentation
- Full documentation audit: 20+ missing features added across all docs
- Website redesigned with Spectra-inspired dark-first design

## [1.12.0] - 2026-04-06

### Added
- **Web UI dashboard** — `agend web` launches browser-based fleet monitoring with live SSE updates and integrated chat UI with bidirectional Telegram sync
- **agend quickstart** — simplified 4-question setup wizard replacing `agend init` as the recommended onboarding path
- **project_roots enforcement** — `create_instance` validates working directory is under configured `project_roots` boundary
- **HTML Chat Export** — `agend export-chat` exports fleet activity as self-contained HTML with date filtering (`--from`, `--to`)
- **Mirror Topic** — `mirror_topic_id` config for observing cross-instance communication in a dedicated topic

### Fixed
- **Parallel startup** — handle tmux duplicate session race when spawning many instances simultaneously
- **.env priority override** — `.env` file values now properly override inherited shell environment variables
- **Web UI chat sync** — bidirectional message sync between Web UI and Telegram

### Documentation
- README revamped with hero section, feature highlights, architecture diagram, and "How it works" flow
- Quick Start updated to use `agend quickstart` command
- Full documentation audit: features.md, cli.md, configuration.md updated with all v1.11.0-v1.12.0 features

## [1.11.0] - 2026-04-05

### Added
- **Kiro CLI backend** — new backend for AWS Kiro CLI (`backend: kiro-cli`). Session resume, MCP config, error patterns, models: auto, claude-sonnet-4.5, claude-haiku-4.5, deepseek-3.2, and more
- **Built-in workflow template** — fleet collaboration workflow auto-injected via MCP instructions. Configurable via `workflow` field in fleet.yaml (`"builtin"`, `"file:path"`, or `false`)
- **Workflow split: coordinator vs executor** — General instance gets full coordinator playbook (Choosing Collaborators, Task Sizing, Delegation Principles, Goal & Decision Management). Other instances get slimmed executor workflow (Communication Rules, Progress Tracking, Context Protection)
- **`create_instance` systemPrompt parameter** — agents can pass custom system prompts when creating instances (inline text only)
- **Fleet ready Telegram notifications** — `startAll` and `restartInstances` send "Fleet ready. N/M instances running." to General topic with failed instance reporting
- **E2E test framework** — 79+ tests running exclusively in Tart VMs. Mock backend with `pty_output` directive for error simulation. T15 workflow template tests, T16 failover cooldown tests
- **Token overhead measurement** — test script (`scripts/measure-token-overhead.sh`) and report. Full profile: +887 tokens (0.44% of 200K context, $0.003/msg)
- **Codex usage limit detection** — "You've hit your usage limit" error pattern (action: pause)
- **MockBackend error patterns** — `MOCK_RATE_LIMIT` and `MOCK_AUTH_ERROR` for E2E testing

### Fixed
- **Crash recovery snapshot restore** — write snapshot on crash detection (not just context rotation); replace single-consume file deletion with in-memory `snapshotConsumed` flag so file persists for daemon restart recovery (#11 related)
- **Codex session resume** — `CodexBackend.buildCommand()` now uses `codex resume <session-id>` when session-id file exists (#11)
- **Rate limit failover loop** — 5-minute cooldown on failover-type PTY errors prevents repeated triggering when error text persists in terminal buffer (#10)
- **PTY error monitor hash dedup** — record pane hash at recovery time; suppress same error on same screen to prevent stale re-detection loops
- **CLI restart wait** — replace fixed 1s delay between bootout/bootstrap with dynamic polling (up to 30s) for process exit. Fixes "Bootstrap failed: Input/output error" with many instances
- **CLI attach interactive selection** — fuzzy match ambiguity now shows numbered menu instead of error
- **CLI logs ANSI cleanup** — enhanced `stripAnsi()` handles cursor movement, DEC private modes, carriage returns, and remaining control characters
- **`reply_to_text` in agent messages** — user reply-to context now included in formatted messages pasted to agent
- **General instructions per-backend** — auto-create writes correct file based on `fleet.defaults.backend` (CLAUDE.md, AGENTS.md, GEMINI.md, .kiro/steering/project.md)
- **General instructions on every start** — `ensureGeneralInstructions()` called on every `startInstance` for general_topic instances, not just auto-create
- **Builtin text English-only** — all system-generated text translated from Chinese to English (schedule notifications, voice message labels, general instructions)
- **General delegation principles** — rewritten for coordinator role: delegate proactively with specific conditions instead of "do it yourself"

### Changed
- Fleet start/restart notifications unified to "Fleet ready. N/M instances running." format, sent to General topic
- `buildDecisionsPrompt()` dead code removed (intentionally disconnected in v1.9.0)
- `getActiveDecisionsForProject()` removed from fleet-manager (dead code)

### Documented
- OpenCode MCP instructions limitation (v1.3.10 doesn't read MCP instructions field)
- Kiro CLI MCP instructions limitation (unverified)
- Token overhead report (EN + zh-TW) with reproducible test script

## [1.10.0] - 2026-04-05

_Intermediate release, changes included in 1.11.0 above._

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
