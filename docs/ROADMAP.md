# AgEnD Roadmap

> Last updated: 2026-04-03 (v1.9.1)
> Produced by multi-agent consensus: Claude Code, Codex, Gemini CLI, OpenCode

## Completed (v1.0–v1.3)

- [x] Multi-backend support (Claude Code, Codex, Gemini CLI, OpenCode)
- [x] Multi-channel support (Telegram, Discord)
- [x] Fleet orchestration (persistent project instances)
- [x] Cross-instance delegation (send_to_instance, delegate_task, report_result)
- [x] Cron scheduling (SQLite-backed, survives restarts)
- [x] Cost guard with daily limits
- [x] Context rotation (auto-refresh stale sessions)
- [x] `/sysinfo` fleet diagnostics
- [x] `safeHandler` async error boundaries
- [x] FleetManager modularization (RoutingEngine, InstanceLifecycle, TopicArchiver, StatuslineWatcher, OutboundHandlers)
- [x] IPC socket hardening (umask TOCTOU fix)
- [x] Platform-agnostic core (all Telegram/Discord specifics in adapters)

## Completed (v1.4–v1.8)

- [x] Shared Decisions — SQLite-backed cross-instance knowledge sharing (fleet/project scope)
- [x] Task Board — task tracking with dependencies, priority, claim/done lifecycle
- [x] Activity Visualization — Activity Log (SQLite) + Web UI (Mermaid, Network Graph, Agent Board, Replay)
- [x] Tool Profiles — full/standard/minimal MCP tool sets to reduce token overhead
- [x] Broadcast tool — fleet-wide or tag-filtered messaging
- [x] Tags — instance tagging for filtered broadcast/list_instances
- [x] Display names — agents choose their own identity via set_display_name MCP tool
- [x] checkout_repo — cross-repo access for agents working on other projects
- [x] Backend error pattern detection — PTY monitoring with per-backend error patterns, auto-notify + failover
- [x] Model failover — auto-switch to backup model on rate limits (statusline + PTY detection)
- [x] Gemini system prompt injection via `GEMINI_SYSTEM_MD` env var
- [x] launchd (macOS) + systemd (Linux) service support with `agend install/start/stop/restart`
- [x] System prompt UX — `file:` prefix, `system-prompt.md` convention, role via `description` field
- [x] Hot reload — `SIGHUP` triggers full config reconcile (add/remove/restart instances)
- [x] `agend update` — self-update via npm with optional daemon restart
- [x] Backend doctor/trust — `agend backend doctor` diagnostics, `agend backend trust` for Gemini
- [x] Complete zh-TW documentation (features, CLI, configuration, roadmap, security, changelog)
- [x] fleet.yaml configuration reference (EN + zh-TW)
- [x] Hang detection with Telegram restart buttons
- [x] Daily cost summary reports
- [x] Webhook notifications (Slack, custom endpoints)
- [x] Health endpoint for external monitoring
- [x] Context-bound reply/react/edit_message — no chat_id/thread_id in tool calls; daemon fills from active context
- [x] Teams — named instance groups with `create_team`/`list_teams`/`update_team`/`delete_team`; `broadcast(team:)` support
- [x] Auto-create `working_directory` — omit from fleet.yaml to use `~/.agend/workspaces/<name>`
- [x] `create_instance` directory optional — auto-workspace on omit
- [x] Cross-instance notification improvements — reduced noise, `sender → receiver: summary` format, General Topic filter

---

## Next Up: Mirror Topics & Observability

**Goal:** Make cross-instance communication visible without changing agent behavior.

### Mirror topics
- Observe cross-instance communication in a dedicated topic
- Zero-change to agent behavior — daemon-level hook on send_to_instance

---

## Phase 1: Observability & Dashboard

**Goal:** Make fleet operations visible without leaving the browser.

### 1.1 REST API expansion
Extend the existing health server into a full fleet API:
- `GET /api/fleet` — getSysInfo() JSON
- `GET /api/instances/:name` — instance details, logs, cost
- `GET /api/events` — EventLog query (cost snapshots, rotations, hangs)
- `GET /api/cost/timeline` — cost trend data for charting
- `POST /api/instances/:name/restart` — trigger restart

**Effort:** ~200 lines. Data already exists in EventLog (SQLite) and getSysInfo().

### ~~1.2 Cost analytics dashboard (MVP)~~ → Partially done
- [x] Activity Log with cost tracking (SQLite)
- [x] Web UI with Agent Board, Network Graph, Replay
- [ ] Cost trend chart per instance (Chart.js)
- [ ] Real-time updates via SSE or WebSocket

### ~~1.3 Task timeline & error viewer~~ → Partially done
- [x] Activity Log covers task dispatch/completion
- [x] Backend error detection with event logging
- [ ] Schedule execution history viewer

---

## Phase 2: Engineering Workflow Integration

**Goal:** Make AgEnD part of real engineering workflows, not just a chat tool.

### 2.1 GitHub / GitLab integration
- Trigger agent tasks from issues, PRs, or webhooks
- Report results back as PR comments or issue updates
- Scheduled repo maintenance (nightly triage, dependency updates)

### 2.2 CI/CD hooks
- Fleet as Code — manage instance config via git
- Deploy/update instances via PR merge
- Pre-commit hooks for agent-assisted review

### ~~2.3 Conversation history & persistence~~ → Partially done
- [x] Activity Log captures all cross-instance messages
- [x] Context rotation v3 snapshots carry-over key context
- [ ] Full inbound/outbound message logging
- [ ] Searchable conversation history

---

## Phase 3: Plugin & Extension System

**Goal:** Let the community extend AgEnD without forking.

### 3.1 Plugin architecture
- Scan `~/.agend/plugins/` for npm packages
- Dynamic `import()` for backend, channel, and tool plugins
- Standard interfaces already exist: `CliBackend`, `ChannelAdapter`, `outboundHandlers` Map

### 3.2 Custom tool plugins
- Register additional MCP tools via plugins
- Tool Profiles already support custom sets — extend to plugin-provided tools

### 3.3 Policy & permissions
- Per-instance environment/sandbox controls
- Human approval flows for high-risk actions
- Team role-based access control

---

## Phase 4: Ecosystem Expansion

**Goal:** Broaden reach across channels, backends, and use cases.

### 4.1 More channels
- **Slack** (~300-400 lines via Bolt SDK) — enterprise adoption
- **Web Chat** (WebSocket server) — self-hosted control panel
- ChannelAdapter abstraction is proven; new adapters don't touch core code

### 4.2 More backends
- **Aider** (~50-80 lines) — most popular open-source coding agent
- **Kiro** (AWS) — when CLI mode stabilizes
- **Custom CLI** — document how to implement CliBackend for any tool

### 4.3 Smart backend routing
- Auto-select backend by task type (quick fix → fast model, architecture → strong model)
- Compare cost/latency/success rate across backends
- Routing recommendations based on historical performance

---

## Phase 5: Advanced Operations (Long-term)

### 5.1 Agent swarm coordination
- Automatic task decomposition and delegation
- Agent-to-agent recruitment (code agent → security scan agent → review agent)
- Parallel execution with result aggregation

### ~~5.2 Fleet-wide knowledge hub~~ → Partially done
- [x] Shared Decisions (architecture decisions, conventions, preferences)
- [x] Task Board for cross-instance work tracking
- [ ] RAG-based retrieval from project documentation
- [ ] Learning from past task outcomes

### ~~5.3 Self-healing fleet~~ → Partially done
- [x] Auto-restart with model failover on rate limits
- [x] PTY error detection with auto-notify
- [x] Crash loop detection with respawn pause
- [ ] Rate limit prediction and preemptive backend switching
- [ ] Anomaly detection on cost/latency patterns

### 5.4 Control Plane / Data Plane separation
- Data Plane (local): daemon runs near code and secrets
- Control Plane (optional cloud): cross-machine discovery, global scheduling, unified monitoring

---

## AgEnD-RS (Experimental)

**Goal:** Rust rewrite for performance, single-binary distribution, native terminal multiplexing.

- Fork of [Zellij](https://github.com/zellij-org/zellij) terminal multiplexer
- Feature-flagged modules (`#[cfg(feature = "agend")]`) — minimal Zellij changes (~25 lines)
- Modules: config, fleet, monitor, mcp (24 tools), telegram, routing, daemon, db, ipc, backend, lifecycle
- Status: Phase 7 complete (core modules), Phase 8 in progress (end-to-end integration)

---

## Explicitly Deferred

| Direction | Reason |
|-----------|--------|
| Agent marketplace | Ecosystem not mature enough; needs plugin system first |
| Multi-machine distributed fleet | Architecture change too large; focus on single-machine excellence first |
| LINE channel | Complex API, limited global market |
| Native desktop app | High dev cost; web UI covers the need |
| Cost analytics deep dive | Accuracy concerns; defer until statusline data is verified |

---

## Product Positioning

> **AgEnD is not another coding agent. It's the operations layer that makes coding agents work as a team.**

- Backend-agnostic: works with any coding CLI
- Channel-native: Telegram/Discord as human-in-the-loop control plane
- Persistent instances: one instance per project/repo, not throwaway chat threads
- Fleet coordination: delegate, schedule, monitor, and control across projects and backends
