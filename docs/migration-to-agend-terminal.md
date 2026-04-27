# Migrating from AgEnD (TS) to agend-terminal (Rust)

> [!IMPORTANT]
> This guide is the canonical migration reference for moving an existing
> `@suzuke/agend` (TypeScript) install to
> [`agend-terminal`](https://github.com/suzuke/agend-terminal) (Rust). It is
> built incrementally — Sprint 2 Phase A landed Sections 2 + 3 first because
> CLI flags and `fleet.yaml` schema are the highest-friction surface for
> existing operators. Other sections fill in over Phases B and C.

> [!WARNING]
> `agend-terminal` is a Rust rewrite, not a port. The `fleet.yaml` schema is
> deliberately leaner than the TS one — many per-instance knobs that lived in
> the YAML have moved to env vars, backend presets, or per-backend instruction
> files. **Read Section 3 carefully before copying your existing config.**

## Why migrate? {#why-migrate}

*(Phase C — covers: motivation, agend-terminal feature delta over @suzuke/agend, when not to migrate, supported migration window.)*

## CLI flag mapping {#cli-flag-mapping}

`agend-terminal` exposes a **single flat command list** (see [`src/main.rs:165-337`](https://github.com/suzuke/agend-terminal/blob/main/src/main.rs#L165-L337)) rather than the multi-group structure (`agend fleet …`, `agend backend …`, …) you are used to from `@suzuke/agend`. Most subcommand groups collapse to top-level commands; several are removed entirely (functionality moved to MCP tools, TUI overlays, env vars, or deferred).

### Top-level commands (TS top-level → Rust)

| `@suzuke/agend` | `agend-terminal` | Status / notes |
|---|---|---|
| `agend init` | — | **Removed.** Use `agend-terminal quickstart` for the interactive setup, or hand-author `fleet.yaml`. |
| `agend quickstart` | `agend-terminal quickstart` | ✓ Renamed equivalent. |
| `agend start` | `agend-terminal start` | ✓ Starts the daemon. Note: Rust also has `agend-terminal daemon` for explicit daemon-mode launch and `agend-terminal app` for the TUI multi-pane terminal — these are distinct on Rust side, whereas TS folds the multiplex into `start`. |
| `agend stop` | `agend-terminal stop` | ✓ |
| `agend restart` | — | **Removed.** Use `stop` + `start`. |
| `agend ls` | `agend-terminal ls` (alias of `list`) | ✓ |
| `agend health` | `agend-terminal doctor` | **Renamed.** Combines health + backend probe into one diagnostic. |
| `agend attach <instance>` | `agend-terminal attach <instance>` | ✓ Native PTY multiplexing replaces the TS `tmux` wrapper, so attach quit shortcuts may differ. |
| `agend logs <instance>` | — | **Removed.** Read log files directly under `$AGEND_HOME` (`daemon.log` and per-instance log files). |
| `agend update` | `agend-terminal upgrade` (Unix-only) | **Renamed and platform-narrowed.** Hot in-place upgrade; takes `--binary <path>`, `--yes`, `--install-supervisor`, `--stability-secs N`, `--ready-timeout-secs N`. |
| `agend reload` | — | **Removed.** Stop and restart the daemon to pick up `fleet.yaml` changes. |
| `agend install` / `agend uninstall` | — | **Removed.** Service install is delegated to OS-native tools (`systemd` / `launchd`) — the Rust binary does not register itself. |
| `agend web` | — | **Removed.** No web UI in `agend-terminal`; the TUI (`app`) replaces it. |
| `agend export` / `agend import` | — | **Removed.** No archive format yet; if you need to back up state, copy `$AGEND_HOME` directly. |
| `agend export-chat` | — | **Removed.** |
| — | `agend-terminal app` | **New.** Launches the multi-pane TUI. |
| — | `agend-terminal tray` | **New.** System-tray integration (feature-gated). |
| — | `agend-terminal inject <instance> <message>` | **New.** Inject a message into an instance's stdin without a Telegram round trip. |
| — | `agend-terminal kill <instance>` | **New.** Force-kill a hung instance. |
| — | `agend-terminal connect` | **New.** Connect a controller to a running daemon. |
| — | `agend-terminal demo` | **New.** Run a guided demo flow. |
| — | `agend-terminal bugreport` | **New.** Bundle logs/config for a bug report. |
| — | `agend-terminal completions` | **New.** Print shell completions. |
| — | `agend-terminal mcp` | **New.** MCP-related diagnostics. |
| — | `agend-terminal capture` | **New.** Capture a session snapshot for postmortem. |
| — | `agend-terminal test` / `verify` | **New.** Internal verification commands. |

### `agend fleet` group → flattened

| TS | Rust | Status |
|---|---|---|
| `agend fleet start` | `agend-terminal fleet start [config]` | ✓ |
| `agend fleet stop` | `agend-terminal fleet stop` | ✓ |
| `agend fleet restart` | — | **Removed.** Use `fleet stop` + `fleet start`. |
| `agend fleet status` | `agend-terminal status` | **Renamed and flattened** to top-level `status`. |
| `agend fleet logs` | — | **Removed.** Read log files directly. |
| `agend fleet history` | — | **Removed.** No equivalent. |
| `agend fleet activity` | — | **Removed.** No equivalent. |
| `agend fleet cleanup` | — | **Removed.** Rust does not auto-clean stale instance dirs; delete manually if needed. |
| — | `agend-terminal admin cleanup-branches [--yes]` | **New.** Admin sub-group; cleans up stale review branches. |

### `agend backend` group → mostly removed

| TS | Rust | Status |
|---|---|---|
| `agend backend doctor` | `agend-terminal doctor` | **Renamed and flattened.** Same diagnostic surface; no `backend` sub-group on Rust. |
| `agend backend trust <dir>` | — | **Removed.** Backends manage their own trust files; `agend-terminal` does not pre-approve directories. Run the backend CLI manually once to accept its trust prompt. |

### `agend topic ...` → removed (configuration-only)

`topic list` / `topic bind` / `topic unbind` have **no CLI equivalent** in `agend-terminal`. Topic-to-instance routing is configured in `fleet.yaml` (`instances.<name>.topic_id`); there is no runtime command to mutate the binding.

**Migration**: edit `fleet.yaml` directly. If you need to inspect current bindings at runtime, `agend-terminal status` lists each instance's `topic_id`.

### `agend access ...` → removed (replaced by `channel.user_allowlist`)

`access lock` / `unlock` / `list` / `remove` / `pair` have **no CLI equivalent** in `agend-terminal`. Access control is now declarative via the top-level `channel.user_allowlist` field — see High-friction #1 in Section 3.

**Migration**: replace runtime `access ...` mutations with edits to `channel.user_allowlist` in `fleet.yaml`, then restart the daemon.

### `agend schedule ...` → moved to MCP tools / TUI

`schedule list` / `add` / `update` / `delete` / `enable` / `disable` / `history` / `trigger` have **no CLI equivalent** in `agend-terminal`. Scheduling lives in two places now:

- **MCP tools** — `create_schedule`, `list_schedules`, `update_schedule`, `delete_schedule` (callable from inside any agent's tool surface).
- **TUI overlay** — `agend-terminal app` exposes a schedule pane.

**Migration**: scripts that called `agend schedule add` from cron/CI must invoke the daemon's MCP tool surface instead, or pre-seed schedules through `agend-terminal app`.

## fleet.yaml schema diff {#fleet-yaml-schema-diff}

The Rust schema lives at [`src/fleet.rs:7-183`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L7-L183) and is the source of truth for everything below. The Rust schema is **deliberately leaner** than the TS one — many per-instance knobs have moved to env vars, backend presets, or per-backend instruction files. Plan to rewrite, not just rename, when porting an existing `fleet.yaml`.

### High-friction change #1: `user_allowlist` is fail-closed by default

**Reference:** `agend-terminal` PR #216, schema at [`src/fleet.rs:50-60`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L50-L60), drop logic at [`src/channel/mod.rs:240-260`](https://github.com/suzuke/agend-terminal/blob/main/src/channel/mod.rs#L240-L260).

**Field**: `channel.user_allowlist: Option<Vec<i64>>` — a top-level field on `channel`, **not nested under `access`** (Rust has no `access` sub-key on `channel`).

**Three-state semantics:**

| YAML | Behaviour |
|---|---|
| key absent | **Legacy open mode** — accepts all group members. Daemon logs a deprecation warning at startup; this state is supported for backwards compatibility but flagged for removal. |
| `user_allowlist: []` | **Lockdown.** Reject all senders. Useful as a kill-switch without removing the rest of the channel config. |
| `user_allowlist: [123, 456]` | **Allowlist.** Only those Telegram numeric user IDs accepted. |

**Outbound failure mode (post-PR #216 fail-closed for outbound notify):**

If the daemon would have notified the channel but the recipient is not allowlisted, this line is emitted to `daemon.log` at **DEBUG** level (`tracing::debug!` at `src/channel/mod.rs:251-255`):

```
DEBUG  outbound notify dropped — channel not authorised (fail-closed; configure user_allowlist to opt in)
```

> [!IMPORTANT]
> The drop event is logged at `DEBUG`, **not** `WARN`. With the default `RUST_LOG=info` you will not see it — `grep` against `daemon.log` returns nothing and the operator's natural conclusion is "config OK," which is exactly the wrong inference. **When reproducing this failure mode, set `RUST_LOG=debug` (or `RUST_LOG=agend_terminal=debug`) before starting the daemon.** A separate `agend-terminal`-side change to raise this line to `WARN` is being tracked by dev-team; this guide reflects the current behaviour.

**Inbound failure mode:**

Each rejected inbound is dropped with a log naming the offending `user_id`. Same caveat: confirm log level on `agend-terminal` source before relying on a specific level for grep.

**Migration action**

```yaml
# fleet.yaml on agend-terminal
channel:
  type: telegram
  bot_token_env: BOT_TOKEN
  group_id: -1001234567890           # bare int, see High-friction #2
  user_allowlist:                    # top-level on channel; copy from channel.access.allowed_users on @suzuke/agend
    - 111111111                      # Telegram numeric user ID, bare int
    - 222222222
```

**Debugging checklist when the bot goes silent on Rust:**

1. `grep "outbound notify dropped" $AGEND_HOME/daemon.log` — confirms the gate fired.
2. Confirm `channel.user_allowlist` is set in `fleet.yaml` and your numeric user ID is in it (use [@userinfobot](https://t.me/userinfobot) on Telegram if unsure).
3. If you previously had `channel.access.allowed_users` on `@suzuke/agend` (the fully qualified path; `access` is nested under `channel` per `src/types.ts:57`), that path is **not read** by Rust — copy the entries to top-level `channel.user_allowlist` and use bare int form for IDs.
4. **TS pairing-mode users** (those who got their user IDs onto `channel.access.allowed_users` via `agend access pair` issuing pairing codes) must also be enumerated into `channel.user_allowlist` directly — `agend-terminal` has no pairing flow equivalent. If your `@suzuke/agend` install used `access.mode: "pairing"`, list every active user ID in the Rust allowlist explicitly.

> **Why fail-closed:** an empty/absent allowlist on a Telegram bot is a credential exposure waiting to happen — anyone who guesses or exfiltrates the bot token can DM the bot and trigger arbitrary backend tool use. Failing closed forces the operator to make an explicit access decision, which is both safer and more debuggable than silently exposing the bot.

### High-friction change #2: `group_id` is strict `i64` — **bare int form only**

**Reference:** [`src/fleet.rs:46`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L46) (field type) and [`src/fleet.rs:725-826`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L725-L826) (round-trip tests).

In `@suzuke/agend`, `channel.group_id` was typed as `number | string` and the YAML loader accepted either. **Canonical TS docs used the bare int form for Telegram supergroup IDs** — see `docs/configuration.md:23` (`group_id: -1001234567890`) and `tests/setup-wizard-config.test.ts:127` (`toBe(-1001234567890)`). The quoted-string form was reserved for **Discord guild IDs** (positive 18–19-digit snowflakes that exceed JavaScript's `Number.MAX_SAFE_INTEGER` of 2^53 − 1) — see `docs/features.md:302`, `docs/plugin-development.md:293`, `docs/plugin-adapter-architecture.md:28,298`. Quoting Discord IDs dodged JS `Number` precision loss; quoting Telegram IDs was never the canonical TS recommendation.

In `agend-terminal`, `channel.group_id` is typed as **`i64`** with strict serde deserialization. **Only the bare int form is accepted** — a quoted-string form (`group_id: "-1001234567890"`) **fails at startup** with a serde error like `"invalid type: string \"-1001234567890\", expected i64"`. The Rust YAML parser does not auto-coerce string ↔ int. `i64` covers both Telegram negative supergroup IDs (well within range) and Discord snowflakes (which fit in 2^63 − 1) with the same bare-int form.

Round-trip tests at [`src/fleet.rs:725-826`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L725-L826) lock the bare-int parsing contract for representative negative IDs (`-100123456`, `-100999`, `-3`, `-1`, `-2`). Quoted-string rejection is serde's default behaviour for `i64`-typed fields and is not separately regression-tested — a future serde version with a permissive coercion knob could change it, though the typed-field contract makes such drift unlikely.

**Migration action.** If your `fleet.yaml` quoted any `group_id` value (Discord users especially, where quoting was the standard TS workaround for the precision issue), un-quote it before the new daemon will load the config:

```yaml
# Required form on agend-terminal (Telegram and Discord both):
channel:
  group_id: -1001234567890            # bare int

# Will fail to load on agend-terminal:
channel:
  group_id: "-1001234567890"          # quoted — serde rejects with "expected i64"
```

**Other int-vs-string parity worth knowing:** `instances.<name>.topic_id` is also strictly `Option<i32>` on Rust (fleet.rs:160) — bare int only.

### Top-level keys

`@suzuke/agend` `FleetConfig` (`src/types.ts:218`) → `agend-terminal` `FleetConfig` (`src/fleet.rs:7-29`):

| TS key | Rust equivalent | Notes |
|---|---|---|
| `channel` | `channel: ChannelConfig` ✓ | Singular form. **Plus** Rust accepts plural `channels: HashMap<String, ChannelConfig>` for multi-channel routing — `normalize()` at startup collapses `channels` to `channel` if only one entry. |
| `project_roots` | **removed** | No fleet-level allowlist of project roots; use per-instance `working_directory`. |
| `defaults` | `defaults: InstanceDefaults` ✓ | Field set differs significantly — see instance table below. |
| `instances` | `instances: HashMap<String, InstanceConfig>` ✓ | Same role; field set leaner. |
| `teams` | `teams: HashMap<String, TeamConfig>` ✓ | Rust shape (`src/fleet.rs:175-183`): `{ members, orchestrator?, description? }`. The new `orchestrator: Option<String>` field names a member that acts as the routing target for team-addressed `delegate_task` and groups the team in the TUI's team-tab view. TS `TeamConfig` has only `{ members, description? }` — when porting, leave `orchestrator` unset to preserve TS-equivalent behaviour, or set it once you adopt the new routing convention. |
| `templates` | `templates: Option<HashMap<String, serde_yaml::Value>>` | **Parser-only on Rust today** — keys round-trip but template expansion is not implemented yet. Do not depend on TS template semantics. |
| `profiles` | **removed** | Per-instance fields are flat; reusable profiles will return as a separate concern if needed. |
| `health_port` | **removed** | Daemon does not expose a separate health port; use `agend-terminal doctor`. |
| `stt` | **removed** | Voice→cloud transcription not implemented; voice messages are not supported. |

### `instances.<name>` field diff

`@suzuke/agend` `InstanceConfig` (`src/types.ts:65-111`) → `agend-terminal` `InstanceConfig` (`src/fleet.rs:140-183`):

| TS field | Rust field (snake_case) | Migration action |
|---|---|---|
| `working_directory` | `working_directory: Option<String>` | ✓ same. Required in practice. |
| `display_name` | `display_name: Option<String>` | ✓ same. |
| `description` | `role: Option<String>` (with serde alias `description`) | **Rename or use alias.** Both `role: …` and `description: …` are accepted on Rust; canonical is `role`. |
| `tags` | **removed** | Drop the field. No replacement; Rust does not use tag-based routing. |
| `topic_id` | `topic_id: Option<i32>` | ✓ same; **bare int only** (see High-friction #2). |
| `general_topic` | **removed** | Drop the field. |
| `restart_policy` | **removed** | Drop the field. Restart logic is daemon-managed via fixed constants in `health.rs` (`CRASH_WINDOW=10min`, `BACKOFF_BASE=5s`, `BACKOFF_MAX=300s`, `DEFAULT_MAX_RETRIES=5`). Per-instance restart tuning is not exposed. |
| `context_guardian` | **removed** | Drop the field. Context-rotation tuning lives in backend presets / runtime defaults. |
| `log_level` | **removed** | Drop the field. Set globally via env var (`RUST_LOG=…`). |
| `backend` | `backend: Option<Backend>` | ✓ same. Backend identifier strings should match (claude / gemini / codex / opencode / kiro). |
| `tool_set` | **removed** | Drop the field. MCP tool ACL is now controlled by env vars `AGEND_MCP_TOOLS_ALLOW` / `AGEND_MCP_TOOLS_DENY` set when launching the daemon. |
| `lightweight` | **removed** | Drop the field. |
| `systemPrompt` | **removed** | Drop the field. Instructions are injected via per-backend `instructions_path` files (e.g. a workspace `CLAUDE.md`) — see the `agend-terminal` backend preset for paths. The TS `file:`-chain syntax has no Rust equivalent; concatenate manually if needed. |
| `skipPermissions` | **removed** | Drop the field. Permission flags are baked into each backend preset's `spawn_flags()`. |
| `model` | `model: Option<String>` | ✓ same. Passed as `--model` to the backend CLI. |
| `model_failover` | **removed** | Drop the field. No automatic failover on Rust today; restart with a different model manually if the primary is rate-limited. |
| `cost_guard` | **removed** | Drop the field. No equivalent yet on Rust. |
| `worktree_source` | `git_branch: Option<String>` (with serde alias `worktree_source`) | **Rename or use alias.** Rust canonical is `git_branch`; the TS spelling still loads via alias. |
| `workflow` | **removed** | Drop the field. |
| `startup_timeout_ms` | **removed** | Drop the field. Startup timing is governed by each backend preset's `ready_timeout_secs`. |
| `agent_mode` | **removed** | Drop the field. Communication mode (MCP vs HTTP) is implied by the backend preset; not user-tunable per instance. |

**Rust-only fields you may want to add** when porting:

| Rust field | Type | Purpose |
|---|---|---|
| `receive_fleet_updates` | `Option<bool>` | Default opt-in. Set `false` on instances that should not see fleet `<fleet-update>` injections. |
| `cols`, `rows` | `Option<u16>` | Override PTY size for the instance's terminal. |
| `env` | `HashMap<String, String>` | Per-instance env additions. Note: Rust filters credential-like keys per `agent.rs::SENSITIVE_ENV_KEYS` — secrets injected here may be redacted. |
| `command`, `args`, `ready_pattern` | low-level overrides | Used when the chosen backend is not a built-in preset (legacy / custom CLI). |

**snake_case caveat:** TS schema mixes `camelCase` (`systemPrompt`, `skipPermissions`) and `snake_case` (everything else). Rust is uniformly `snake_case`. The two TS camelCase fields above are removed on Rust anyway, so this only matters for `worktree_source` / `git_branch` (alias accepts both) and `description` / `role` (alias accepts both).

## Backend invocation diff {#backend-invocation-diff}

The biggest day-one surprise on migration is that the way each backend CLI is launched, fed instructions, and signalled is materially different between the two daemons. This section gives you the full diff so a fleet that worked under TS keeps working under Rust.

### Two invocation models

| Aspect | `@suzuke/agend` (TS) | `agend-terminal` (Rust) |
|---|---|---|
| Spawn surface | `tmux new-window <shell-string>` per backend, with backend-specific shell quoting in `src/backend/<name>.ts` | Direct PTY (`openpty` on Unix, ConPTY on Windows) per pane, command + args resolved from a static `BackendPreset` |
| Backend abstraction | One TypeScript class per backend implementing `CliBackend` (`buildCommand`, `writeConfig`, `getReadyPattern`, `getStartupDialogs`, …) | One enum variant + one `BackendPreset` struct in `src/backend.rs` |
| Renderer | None — pane is whatever tmux shows | Built-in vterm/Ratatui pane in the daemon's TUI; same byte stream is what the agent sees |
| Cross-platform target | macOS / Linux only (tmux dependency) | macOS / Linux / Windows (ConPTY), `which::which` honors `PATHEXT` so `claude.cmd` / `codex.ps1` resolve on Windows |
| New backend variants | Five fixed: `claude-code`, `opencode`, `gemini-cli`, `codex`, `kiro`, plus `mock` (E2E only) | Same five, plus `Backend::Shell` (generic `$SHELL`) and `Backend::Raw(path)` (any executable) — both with no preset wiring |

The TS daemon delegates almost everything to the per-backend class; the Rust daemon centralizes everything in one preset table that every spawn path reads from. Practically that means: in TS, behavior tweaks for a backend land in `src/backend/<name>.ts`; in Rust, they land as a field on `BackendPreset` and ripple to every call site automatically.

### Per-backend invocation matrix

The shape of each backend's command line is preserved. The wrapper around it changed.

| Backend | TS invocation summary | Rust invocation summary |
|---|---|---|
| **Claude Code** | `claude --settings <path> --mcp-config <path> --dangerously-skip-permissions [--resume <session-id>] [--model <m>] [--append-system-prompt-file <path>]` from `src/backend/claude-code.ts:17-45`. Pre-approves `ANTHROPIC_API_KEY` in `~/.claude.json` before spawn. | `claude --dangerously-skip-permissions [--continue]`, plus `--append-system-prompt-file` and `--mcp-config` injected via `Backend::spawn_flags` when those files exist (`src/backend.rs:411-426`). Resume strategy: `ResumeMode::ContinueInCwd { flag: "--continue" }`. |
| **OpenCode** | `opencode [--session <sid>] [--continue] [--model <m>]`. MCP wired via `opencode.json:mcp.<key>` written into the working directory; instructions delivered through the `opencode.json:instructions` array pointing at `<instance_dir>/fleet-instructions.md` (`src/backend/opencode.ts:14-73`). | `opencode [--continue]`. Resume: `ContinueInCwd { flag: "--continue" }`. **Behavior change:** instructions now land in the workspace `AGENTS.md` via marker-merge, **not** in a per-instance file referenced from `opencode.json`. See the instructions-injection sub-section below. |
| **Codex** | `codex resume --last [--dangerously-bypass-approvals-and-sandbox \| --full-auto] [-c model="<m>"]`. MCP registered via global `~/.codex/config.toml` (`codex mcp add <name>` shell calls). Trust pre-approved by appending `[projects."<workdir>"]` to `~/.codex/config.toml`. | `codex resume --last --dangerously-bypass-approvals-and-sandbox` on resume; `codex --dangerously-bypass-approvals-and-sandbox` (no `resume --last`) on fresh start (`fresh_args` field). Resume: `ResumeMode::NotSupported` (Codex's resume is positional, not a flag, so it lives in `args`). |
| **Gemini CLI** | `gemini --yolo [--resume latest] [--model <m>]`. MCP registered in `<workdir>/.gemini/settings.json:mcpServers.<key>`. Trust pre-approved via `~/.gemini/trustedFolders.json`. | `gemini --yolo`, with `ResumeMode::Fixed { args: &["--resume", "latest"] }` appending the resume flags. |
| **Kiro CLI** | `kiro-cli chat --trust-all-tools [--resume] [--model <m>] --require-mcp-startup`. MCP wired through a per-server **wrapper script** at `<instance_dir>/mcp-wrapper-<name>.sh` (mode `0o700`) that exports env vars before exec'ing the real MCP binary — works around Kiro ignoring the `env` block in `mcp.json`. | `kiro-cli chat --trust-all-tools [--resume]`. Resume: `ContinueInCwd { flag: "--resume" }`. The MCP wrapper-script workaround is gone in Rust because `mcp_config.rs` writes the env to disk in a form Kiro reads. |

### Resume strategy diff

TS keeps a session id per instance and re-attaches by id (`--resume <id>`, `--session <id>`) when one is on disk. Rust does not track session ids — it uses CLI-native "continue most recent in cwd" semantics, with one variant per backend:

- `ResumeMode::ContinueInCwd { flag }` — Claude (`--continue`), OpenCode (`--continue`), Kiro (`--resume`).
- `ResumeMode::Fixed { args: &[..] }` — Gemini (`--resume latest`).
- `ResumeMode::NotSupported` — Codex (resume is the `resume` subcommand, baked into `args`).

This works because Rust always spawns each agent in a unique working directory (auto-worktree for git repos), so "most recent session in cwd" maps 1:1 to the instance's own session.

There is one rough edge: when a Claude pane is opened but never used, `claude --continue` errors out ("No conversation found to continue"). The daemon would catch this via crash-respawn, but the failure briefly flashes into the pane before recovery. `Backend::has_resumable_session(working_dir)` (Claude only, in `src/backend.rs`) walks `~/.claude/projects/<encoded-cwd>/*.jsonl` to detect "metadata-only" sessions and downgrades `Resume` → `Fresh` up front so the user never sees the failure flash. Other backends return `true` optimistically and rely on crash-respawn.

### Instructions injection — `nativeInstructionsMechanism` mapping

Bug #55 (PR #56) introduced the three-value `nativeInstructionsMechanism` field on the TS `CliBackend` interface. The Rust daemon does not expose this name; the equivalent mechanism is encoded in three `BackendPreset` fields: `instructions_path`, `instructions_shared`, `inject_instructions_on_ready`. Mapping:

| Backend | TS `nativeInstructionsMechanism` (post-#55) | Rust equivalent | TS file location | Rust file location |
|---|---|---|---|---|
| `claude-code` | `append-flag` (`--append-system-prompt-file`) | `instructions_path = ".claude/agend.md"`, `shared = false`, `inject_on_ready = false`. Flag injected by `Backend::spawn_flags`. | `<instance_dir>/fleet-instructions.md` | `<workdir>/.claude/agend.md` (under `.claude/` but **not** `.claude/rules/` — explicit to avoid Claude double-loading) |
| `opencode` | `append-flag` (`opencode.json:instructions`) | `instructions_path = "AGENTS.md"`, `shared = true`, `inject_on_ready = false`. Marker-merge into the workspace `AGENTS.md`. | `<instance_dir>/fleet-instructions.md` (referenced from workspace `opencode.json`) | `<workdir>/AGENTS.md` (workspace project doc) |
| `gemini-cli` | `project-doc` (`GEMINI.md`) | `instructions_path = "GEMINI.md"`, `shared = true`, `inject_on_ready = false`. Marker-merge. | `<workdir>/GEMINI.md` | `<workdir>/GEMINI.md` |
| `codex` | `project-doc` (`AGENTS.md`) | `instructions_path = "AGENTS.md"`, `shared = true`, `inject_on_ready = false`. Marker-merge with the 32 KiB Codex limit unchanged. | `<workdir>/AGENTS.md` | `<workdir>/AGENTS.md` |
| `kiro` | `project-doc` (`.kiro/steering/agend-<instance>.md`) | `instructions_path = ".kiro/steering/agend.md"`, `shared = false`, `inject_on_ready = true`. Rust no longer relies on `.kiro/steering/*.md` auto-loading and instead **types the file's contents into the pane as the first user message** once Ready fires. | `<workdir>/.kiro/steering/agend-<instance>.md` (per-instance file) | `<workdir>/.kiro/steering/agend.md` (single file per workdir) **and** injected on Ready |
| `mock` | `none` (MCP `instructions` capability fallback) | n/a — no mock backend in Rust; use `Backend::Shell` for E2E tests. | n/a | n/a |

Three behavior changes worth flagging during migration:

1. **OpenCode now writes a workspace project doc (`AGENTS.md`).** TS kept fleet instructions in `<instance_dir>/fleet-instructions.md` so users never saw an artefact. Rust treats OpenCode the same as Codex. If your repos commit `AGENTS.md`, expect the marker block to appear in the diff; if your `.gitignore` excludes `AGENTS.md`, no behavior change.
2. **Kiro switched from per-instance to per-workdir file naming.** TS wrote `.kiro/steering/agend-<instance>.md`; Rust writes `.kiro/steering/agend.md`. If two Kiro instances share a working directory under TS, they each had their own file; under Rust they share one — and Rust normally avoids this collision by giving each instance a unique worktree.
3. **Kiro instructions are now typed in as a user message.** TS `src/backend/kiro.ts:81` wrote the file with a comment claiming auto-load; the Rust team's empirical investigation found `.kiro/steering/*.md` is an IDE-only feature that the standalone CLI does not read, so Rust has the daemon paste the file's contents into the pane on Ready (`inject_instructions_on_ready = true`). Operationally this means the instructions occupy chat history rather than a system prompt slot; long custom prompts will eat context tokens at startup. PR #55 already neutralized the duplicate-injection risk on the MCP side, so there is no double-cost here. (If the TS comment was correct after all and Kiro CLI does auto-load, the migration outcome is identical — instructions still reach the model — but the channel changes from passive auto-load to active first-message inject.)

The Bug #55 daemon-side gate (drop the five fleet-context env vars and set `AGEND_DISABLE_MCP_INSTRUCTIONS=1` whenever `nativeInstructionsMechanism !== 'none'`) lives in `src/daemon.ts:1022-1039` on the TS side. Rust does not duplicate this gate at the same layer; it gates earlier, by simply not constructing an `instructions` capability response when a backend's preset writes a file. The observable invariant — *the model never sees fleet context twice* — holds in both daemons.

### Signal and ESC byte semantics

The transport — does a key/byte make it from the daemon to the agent's PTY — is verified for the four backends below. The semantics — does the agent then *do* the right thing when it receives ESC or SIGINT — are tracked separately in `src/backend_harness.rs` as a per-backend capability matrix. Sprint 11 of the Rust project will run real-CLI verification; until then, the table below uses the **`pending`** marker as required by §3.5.8.

| Backend | PTY byte transport (ESC `0x1b`, Ctrl-C `0x03`) | `interrupt` MCP tool semantics (ESC stops LLM turn) | `tool_kill` MCP tool semantics (SIGINT to fg pgid) |
|---|---|---|---|
| `kiro-cli` | `True` (proven in `verify_byte_delivery`) | `pending` (Sprint 11) | `pending` (Sprint 11) |
| `codex` | `True` | `pending` | `pending` |
| `claude` | `False` — set by the explicit Claude branch in `record_transport_results` at `src/backend_harness.rs:71-74` (initial value for every backend is `Unverified` at line 56; Claude is downgraded to `False` because "LLM context not tied to PTY buffer (known gap)" — note text at line 50) | `pending` | `pending` |
| `gemini` | `True` | `pending` | `pending` |
| `opencode` | not yet in the harness matrix (`Backend::all()` returns it; the matrix init only seeds the four above) — `pending` | `pending` | `pending` |

What is concretely guaranteed today in Rust:

- **Process-tree termination.** `process::kill_process_tree(pid)` (`src/process.rs`) sends `SIGTERM` to the process group, sleeps 500 ms, then sends `SIGKILL` unconditionally. Windows falls back to `TerminateProcess`. This applies to instance shutdown, replace, and crash recovery — not to mid-turn interruption.
- **ESC byte injection.** The `interrupt` MCP tool (`src/mcp/handlers.rs:969-991`) writes `0x1b` to the target agent's PTY via the daemon API. Whether the model on the other end interprets ESC as "stop generation" is the `pending` cell above.
- **SIGINT to foreground process group.** The `tool_kill` MCP tool (`src/mcp/handlers.rs:994-1031`) walks `tcgetpgrp` to find the pane's foreground pgid and sends `SIGINT`. Unix only — on Windows the tool returns `{"error": "tool_kill is only supported on Unix (Linux/macOS)"}` rather than silently no-op'ing.

The TS daemon ships none of `interrupt`, `tool_kill`, `kill_process_tree`-style group kill, or a capability matrix at all. Cancellation in TS is whatever the backend's own quit command does (`/exit`, `/quit`, `exit`) plus the OS-level termination of the tmux pane.

### What this means for migration

- If you script invocations directly (e.g. spawn the binary yourself outside the daemon), only Codex changed shape (resume is now the subcommand it always was; the wrapper that passed `--resume <id>` is gone).
- If you commit `AGENTS.md` or `GEMINI.md` to the repo, expect a marker block to appear once you migrate. Adding `<!-- agend:<instance> -->` markers to your `.gitignore` glob is not necessary — the marker block is content, not a separate file.
- If you have Kiro-specific tooling that reads `.kiro/steering/agend-<instance>.md`, switch to `.kiro/steering/agend.md`.
- If you depended on the TS MCP `instructions` capability fallback for the mock backend, port your E2E tests to use `Backend::Shell` and inject instructions via the `task` MCP tool flow.

## MCP tool API diff {#mcp-tool-api-diff}

This is the single biggest migration topic per the Sprint 0 review and dev-lead's HIGH-FRICTION call. The diff is not a rename — Rust *splits* what TS treated as one undifferentiated communication surface into three coordination tracks, plus adds tools that have no TS counterpart.

### Three-track coordination model

```
                ┌───────────────── 1. work ─────────────────┐
                │       task       (work board: create / claim / in_progress / verified / done)
agent ──────────┤
                │  send_to_instance, broadcast, delegate_task, request_information, report_result
                ├──────── 2. comms (push/pull) ─────────────┤
                │   inbox, describe_message, describe_thread (pull side, Rust-only)
                │   set_waiting_on, clear_blocked_reason     (presence side, Rust-only)
                │
                └─────── 3. scope freeze ───────────────────┘
                          post_decision, list_decisions, update_decision
```

Why three tracks? In TS the agent's MCP toolbox treated all of "do work", "tell another agent", and "decide policy" as essentially the same thing — different message shapes routed through `outboundHandlers` in `src/outbound-handlers.ts`. The Rust daemon enforces a clearer layering for the same reason `git` separates the index, the working tree, and the object store: a tool whose job is to **freeze a scope decision** has different correctness invariants than one whose job is to **deliver one message** or **claim one task**, and conflating them made it impossible to reason about ordering or recovery (see `FLEET-DEV-PROTOCOL-v1.md` §1, §2 for the protocol-level argument).

The practical effect for an agent is:

- **Work board (`task`)** is the single source of truth for "is this work done". Status transitions `claimed → in_progress → verified → done` are rejected if you skip a state.
- **Comms** still uses `send_to_instance` / `broadcast` for push, but adds **pull** (`inbox`) and **presence** (`set_waiting_on`) so an agent can resume after a restart without losing pending mail.
- **Decisions (`post_decision`)** are the only mechanism that *binds future scope*. A reviewer who finds a scope violation cites a decision id; a violator cannot retroactively claim "we never decided that".

### Tools that exist in both daemons

These tools have the same name and shape across the two daemons; the diffs are in their input/output schemas and in the surrounding lifecycle. Skim the table for "schema diff", read the per-tool sub-sections only when you actually use that tool.

| Tool | TS schema location | Rust schema location | Schema diff |
|---|---|---|---|
| `reply` | `src/outbound-schemas.ts:ReplyArgs` | `src/mcp/tools.rs:channel_tools` | none |
| `react` | `ReactArgs` | `channel_tools` | none |
| `edit_message` | `EditMessageArgs` | `channel_tools` | none |
| `download_attachment` | `DownloadAttachmentArgs` | `channel_tools` | none |
| `send_to_instance` | `SendToInstanceArgs` | `comm_tools` | Rust adds optional `thread_id`, `parent_id` for thread tracking. Both accept `request_kind ∈ {query, task, report, update}`. |
| `delegate_task` | `DelegateTaskArgs` | `comm_tools` | Rust adds `task_id`, `thread_id`, `parent_id`, `force` + `force_reason` (replaces deprecated `interrupt` + `reason`), `second_reviewer` + `second_reviewer_reason` for protocol §3.5 dual-review. |
| `report_result` | `ReportResultArgs` | `comm_tools` | Rust adds `reviewed_head` (git SHA at review time, surfaced in metadata), `thread_id`, `parent_id`. |
| `request_information` | `RequestInformationArgs` | `comm_tools` | none |
| `broadcast` | `BroadcastArgs` | `comm_tools` | none. Both exclude `report` from `request_kind` — broadcasts can't carry a per-correlation report. |
| `list_instances` | `ListInstancesArgs` | `instance_tools` | TS supports `tags` filter (`src/outbound-schemas.ts:146-148`); Rust takes no parameters (`src/mcp/tools.rs` `inputSchema.properties: {}`). If you relied on tag-based listing, drop the filter on migration and post-filter the result client-side, or use a `team` (`create_team` / `update_team`) for routing. |
| `create_instance` | `CreateInstanceArgs` | `instance_tools` | Rust adds `team` + `count` (homogeneous teams), `backends` (heterogeneous teams), `layout` ∈ `{tab, split-right, split-below}`, `target_pane`, `task` (initial task injected after spawn). The TUI-aware fields (`layout`, `target_pane`) have no TS analogue. |
| `delete_instance` | `DeleteInstanceArgs` | `instance_tools` | none |
| `replace_instance` | `ReplaceInstanceArgs` | `instance_tools` | none |
| `start_instance` | `StartInstanceArgs` | `instance_tools` | none |
| `describe_instance` | `DescribeInstanceArgs` | `instance_tools` | Rust returns the additional fields `waiting_on`, `waiting_on_since`, last heartbeat, last_polled_at, dispatch tracking — used by `set_waiting_on` / `report_health` flows below. |
| `set_display_name` | `SetDisplayNameArgs` | `instance_tools` | none |
| `set_description` | `SetDescriptionArgs` | `instance_tools` | none |
| `post_decision` | `PostDecisionArgs` | `decision_tools` | none |
| `list_decisions` | `ListDecisionsArgs` | `decision_tools` | none |
| `update_decision` | `UpdateDecisionArgs` | `decision_tools` | none |
| `task` | `TaskBoardArgs` | `task_tools` | **Status enum extended.** TS: `open / claimed / done / blocked / cancelled`. Rust: `open / claimed / in_progress / blocked / verified / done / cancelled`. Adds `due_at`, `duration` for deadlines. The new `in_progress` and `verified` states encode protocol §10.3 three-state completion (`in_progress` → `verified` → `done`). |
| `create_team` | `CreateTeamArgs` | `team_tools` | Rust adds `orchestrator` (must be a member; receives team-level routing). |
| `update_team` | `UpdateTeamArgs` | `team_tools` | Rust adds `orchestrator` (re-elect orchestrator). |
| `list_teams` / `delete_team` | as above | `team_tools` | none |
| `create_schedule` | `CreateScheduleArgs` | `schedule_tools` | **Trigger split.** TS: cron expression only. Rust: either `cron` (recurring) **or** `run_at` (ISO 8601 one-shot) — mutually exclusive. One-shots auto-disable after firing. |
| `list_schedules` / `update_schedule` / `delete_schedule` | as above | `schedule_tools` | `update_schedule` accepts either trigger field; supplying either replaces the trigger kind. |
| `deploy_template` / `teardown_deployment` / `list_deployments` | `*Args` | `deploy_tools` | none |
| `checkout_repo` / `release_repo` | `*Args` | `repo_tools` | none |

### Tools added in Rust (no TS counterpart)

These are the eleven tools you will likely care about most when porting an existing `@suzuke/agend` agent prompt. They are listed by the track they sit in.

#### Comms — pull side

| Tool | Purpose | Why it matters for migration |
|---|---|---|
| `inbox` | Drain pending inbound messages addressed to this instance. Returns `{messages: [...]}` and emits `AgentPickedUp` events on Telegram-bound bindings (✅ reaction per pickup). | Under TS, every cross-instance message arrives directly into the pane via tmux; restarting an agent meant losing whatever was mid-flight. Under Rust the inbox persists, so an agent that crashed mid-task can recover its mail by calling `inbox` on resume. |
| `describe_message` | Look up an inbox message status by ID — returns `ReadAt` (with timestamp), `UnreadExpired`, or `NotFound`. Optional `instance` argument scopes the lookup. | Lets a sender confirm whether the recipient picked up a specific message before retrying. TS had no equivalent — you guessed from radio silence. |
| `describe_thread` | Get all messages in a conversation thread, ordered by timestamp. Optional `instance` argument scopes to a specific recipient inbox. | Lets you reconstruct a multi-hop coordination trace (impl → reviewer → impl …) after the fact. Pair with the `thread_id` / `parent_id` fields now present on `send_to_instance` / `delegate_task` / `report_result`. |

#### Comms — presence and process control

| Tool | Purpose | Why it matters for migration |
|---|---|---|
| `set_waiting_on` | Declare what this instance is currently blocked on (`condition` string). Empty string clears. Daemon decays stale entries automatically — see `set_waiting_on` handler at `src/mcp/handlers.rs:1033-1063`. | Replaces the TS pattern where agents wrote prose into messages ("I'm waiting on the reviewer"). Now machine-readable; orchestrators can `list_instances` and see who is stuck on what. |
| `clear_blocked_reason` | Force-clear a stale blocking reason without rewriting `waiting_on`. | Used by orchestrators when the blocking condition has been satisfied but the blocked instance hasn't yet noticed (e.g. the reviewer pushed a verdict but the implementer is still spinning). |
| `report_health` | Report own liveness / state to the daemon, used by the heartbeat path. | Replaces TS's implicit "MCP server still attached" liveness signal with an explicit, structured one. |
| `interrupt` | Send ESC byte (`0x1b`) to a target agent's PTY, cancelling current LLM turn. Optional `reason` injected as a follow-up prompt after ESC. Context is preserved; the agent accepts the next prompt. | TS had no way to interrupt a running LLM turn from outside — you had to wait for the timeout or kill the pane. The semantics for whether ESC actually stops generation per backend are `pending` per the §"Signal and ESC byte semantics" sub-section above. |
| `tool_kill` | Send `SIGINT` to a target agent's PTY foreground process group, cancelling an active **tool subprocess** while preserving the agent session. Unix only. Returns `{ok: true, pgid}` on success. | Use when an agent is stuck inside a long-running shell command (`cargo build`, `pytest …`) but you want to keep the agent's chat history. TS had no analogue — the only escape was killing the whole pane and starting fresh. |

#### TUI control

| Tool | Purpose | Why it matters for migration |
|---|---|---|
| `move_pane` | Move an instance's pane into a different tab in the daemon TUI. Splits an existing tab's focused pane (or creates a new tab). Preserves scrollback and PTY state. | TS has no TUI to move panes within. If your TS agents called `delete_instance` + `create_instance` to "move" an agent visually, switch to `move_pane` — it preserves session, scrollback, and worktree. |

#### CI watching

| Tool | Purpose | Why it matters for migration |
|---|---|---|
| `watch_ci` | Watch GitHub Actions CI for a repo+branch. When CI completes (success / failure / any terminal state), an event is auto-injected into the watching agent's inbox. Honors `GITHUB_TOKEN` for higher rate limits; falls back to unauthenticated polling (60 req/hr fleet-wide) with a `warning` field set. | TS agents polled `gh pr checks --watch` from the shell, which blocked the agent and racked up token consumption. Rust off-loads polling to the daemon and surfaces only the terminal state. |
| `unwatch_ci` | Stop watching CI for a repo. | n/a — paired with `watch_ci`. |

### Cross-instance comms — the deepest migration friction

This is the area dev-lead asked for the most depth on, so let me walk a single concrete migration through end-to-end.

**TS pattern (today):**
```
agent A: send_to_instance(target='B', message='please review PR #42', request_kind='task')
  ↓ TS daemon.routes via outboundHandlers['send_to_instance']
  ↓ Bug #57 cost-guard pre-check (drops if B is over budget)
  ↓ targetIpc.send({type: 'fleet_inbound', targetSession: 'B', content, meta: {...}})
  ↓ B's MCP server receives fleet_inbound and types it into B's pane prefixed by [from:A]
agent B (working): sees the message arrive in chat, decides whether to drop current task and respond.
agent B (offline): the message is gone — TS does not persist `fleet_inbound` past the pane buffer.
```

**Rust pattern (post-migration):**
```
agent A: send_to_instance(target='B', message='please review PR #42', request_kind='task',
                          thread_id='th-pr42', parent_id='m-…')
  ↓ Rust daemon routes via mcp/handlers.rs send_to_instance
  ↓ writes to B's inbox file under <home>/inbox/<B>.json (durable)
  ↓ if B is bound to a Telegram topic, the Telegram sink emits a notification UX event
agent B (working): the next [AGEND-MSG] system reminder includes the message header. B may call inbox to drain.
agent B (offline / restarting): the inbox file persists; on next start, B sees the pending message via inbox.
agent A: can later call describe_message(message_id=…) or describe_thread(thread_id='th-pr42') to confirm pickup.
```

What you must change in your prompts and runbooks when migrating:

1. **Stop assuming push delivery is enough.** Add `inbox` checks at agent startup if the agent has any chance of having queued mail. The Rust daemon already prepends `[AGEND-MSG]` system reminders for new mail, but explicit `inbox` calls are still needed to drain backlog and to claim messages via `AgentPickedUp` events.
2. **Adopt `thread_id` and `parent_id`.** The fleet protocol's coordination patterns (delegate → ack → report; review → finding → re-review) become trivially traceable when threads are linked. TS coordinates the same patterns via prose `correlation_id` strings; Rust still accepts `correlation_id` but adds the structured pair.
3. **Use `set_waiting_on` instead of prose.** "I'm blocked on the reviewer" in chat is unparsable; `set_waiting_on(condition='review from at-dev-4 on PR #63')` is queryable via `describe_instance` and listable across the fleet.
4. **Replace TS-era kill-and-restart patterns with `interrupt` and `tool_kill`.** If your TS prompts say "if the agent is stuck, replace it", switch to "if the agent is mid-LLM-turn, call `interrupt(target=…)`; if the agent is mid-tool-subprocess, call `tool_kill(target=…)`; replace only as a last resort."
5. **Migrate `request_kind: 'report'` flows to use `reviewed_head`.** When you call `report_result` from a reviewer, attach the git SHA at review time. The Rust merge gate (protocol §10.3 / §3 metadata fields) treats this as load-bearing for staleness detection.

### Tool-set profiles

TS exposes two profiles via `AGEND_TOOL_SET` (`src/channel/mcp-tools.ts:120-126`):
- `standard`: `reply, react, edit_message, send_to_instance, broadcast, list_instances, describe_instance, list_decisions, post_decision, task, set_display_name, set_description`
- `minimal`: `reply, send_to_instance, list_decisions, download_attachment`

Rust does not currently expose tool-set profiles in `src/mcp/tools.rs` — every spawned agent sees all 45 tools. **`pending`** verification: if Rust adds a profile mechanism in Sprint 11, agents that relied on TS `minimal` for token-cost reduction may need to re-tune. Until then, treat the Rust toolbox as `full` for prompt-engineering purposes.

## Migration steps {#migration-steps}

*(Phase C — covers: pre-flight checklist, `agend-terminal migrate` invocation if available, dual-run period, rollback, post-migration validation.)*

## Known incompatibilities and deferred parity {#known-incompatibilities}

*(Phase C — covers: features intentionally not ported, parity items deferred to a later Rust release, items still in design.)*
