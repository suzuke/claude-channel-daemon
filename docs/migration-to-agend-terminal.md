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

If the daemon would have notified the channel but the recipient is not allowlisted, you'll see this line in `daemon.log`:

```
WARN  outbound notify dropped — channel not authorised (fail-closed; configure user_allowlist to opt in)
```

(Source: `src/channel/mod.rs:254`.)

**Inbound failure mode:**

Each rejected inbound is dropped with a `WARN` log naming the offending `user_id`.

**Migration action**

```yaml
# fleet.yaml on agend-terminal
channel:
  type: telegram
  bot_token_env: BOT_TOKEN
  group_id: -1001234567890           # bare int, see High-friction #2
  user_allowlist:                    # top-level on channel; copy from access.allowed_users on @suzuke/agend
    - 111111111                      # Telegram numeric user ID, bare int
    - 222222222
```

**Debugging checklist when the bot goes silent on Rust:**

1. `grep "outbound notify dropped" $AGEND_HOME/daemon.log` — confirms the gate fired.
2. Confirm `channel.user_allowlist` is set in `fleet.yaml` and your numeric user ID is in it (use [@userinfobot](https://t.me/userinfobot) on Telegram if unsure).
3. If you previously had `access.allowed_users` on `@suzuke/agend`, that path is **not read** by Rust — copy the entries to top-level `channel.user_allowlist` and use bare int form for IDs.

> **Why fail-closed:** an empty/absent allowlist on a Telegram bot is a credential exposure waiting to happen — anyone who guesses or exfiltrates the bot token can DM the bot and trigger arbitrary backend tool use. Failing closed forces the operator to make an explicit access decision, which is both safer and more debuggable than silently exposing the bot.

### High-friction change #2: `group_id` is strict `i64` — **bare int form only**

**Reference:** [`src/fleet.rs:46`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L46) (field type) and [`src/fleet.rs:725-826`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L725-L826) (round-trip tests covering `-100123456`, `-100999`, `-3`, `-1`, `-2`).

In `@suzuke/agend`, `channel.group_id` is typed as `number | string` and the YAML loader accepts either. Operator guidance has been "always quote large negative IDs as strings" because some code paths mishandled the negative-prefix supergroup IDs as numbers (precision/sign edge cases).

In `agend-terminal`, `channel.group_id` is typed as **`i64`** with strict serde deserialization. **Only the bare int form is accepted** — a quoted-string form (`group_id: "-1001234567890"`) **fails at startup** with a serde error like `"invalid type: string \"-1001234567890\", expected i64"`. The Rust YAML parser does not auto-coerce string ↔ int.

The TS string-handling bug does not apply on Rust (i64 covers the full negative supergroup range natively, with round-trip tests committed at fleet.rs:725-826).

**This reverses the TS migration guidance.** If you have been quoting `group_id` on `@suzuke/agend` (the recommended workaround), you must **un-quote** it before the new daemon will load your `fleet.yaml`.

```yaml
# Required form on agend-terminal:
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
| `teams` | `teams: HashMap<String, TeamConfig>` ✓ | Same shape (`{ members, description? }`). |
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

*(Phase B — covers: `--mcp-config` vs Rust equivalent, `--append-system-prompt-file` flow, per-backend env-var injection, MCP server respawn semantics, fleet-instructions delivery channel — see also `docs/fleet-instructions-injection.md` on the TS side for the post-#55 model.)*

## MCP tool API diff {#mcp-tool-api-diff}

*(Phase B — covers: full inventory of MCP tools (~20 in TS full set), name renames, argument shape changes, return-value diffs, broadcast `cost_limited` field carry-over, deferred or removed tools.)*

## Migration steps {#migration-steps}

*(Phase C — covers: pre-flight checklist, `agend-terminal migrate` invocation if available, dual-run period, rollback, post-migration validation.)*

## Known incompatibilities and deferred parity {#known-incompatibilities}

*(Phase C — covers: features intentionally not ported, parity items deferred to a later Rust release, items still in design.)*
