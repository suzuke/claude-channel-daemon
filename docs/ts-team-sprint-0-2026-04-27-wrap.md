# ts-team Sprint 0 wrap — 2026-04-27

**Window**: 2026-04-27 01:18 UTC → 03:28 UTC (~2h10m)
**Repo**: AgEnD (TS), maintenance mode post-deprecation (commit `ca1b729`)
**Team**: ts-lead, ts-impl, ts-reviewer (3 instances, claude backend)
**Authority chain**: operator TUI direct dispatch (01:18) → operator overnight delegation telegram (01:52, decision `d-20260427025246010573-0`, 24h TTL) → general acting as strategic surrogate from 01:52 onward

## Mission

Triage AgEnD repo open issues. Bug → discuss + fix. Feature → estimate + report. Per-issue disposition decided in collaboration with general (operator surrogate) once the operator entered the overnight sleep window.

## Outcome

| Issue | Type | Disposition | Evidence |
|---|---|---|---|
| #55 | Bug — Gemini fleet context dual-injection | **Fixed** (scope expanded to all dual-injection backends) | PR #56 squash-merged `f58ad9d3` |
| #24 | Feature — usage-limit notify sender | **Fixed** | PR #57 squash-merged `464c8f40` |
| (#24 follow-up) | broadcast surface gate gap | **Fixed** (surfaced by PR #57 reviewer) | PR #58 squash-merged `0ec12443` |
| #52 | Feature — server-side `pause_fleet` primitive | **Closed**, migrate-to-agend-terminal | comment 4323658306 |
| #53 | Feature — Telegram `/pause` `/resume` slash commands | **Closed**, migrate-to-agend-terminal | comment 4323658307 |
| #54 | Feature — Telegram multipart envelope | **Closed**, migrate-to-agend-terminal | comment 4323658308 |
| #8 | Feature — default topic package for new users | **Closed**, migrate-to-agend-terminal | comment 4323658309 |

Net: 0 open issues, 0 open PRs, all six triaged issues resolved (3 fixed + 4 closed-with-migration).

## Bug #55 — fix detail

ts-impl audit during the triage discussion expanded the original Gemini-only issue to a systematic fix:

- Claude backend was *not* in scope (writes `fleet-instructions.md` to instance dir, not workspace, so no project-doc dual-injection — already used `--append-system-prompt-file`).
- Gemini (`GEMINI.md`), Codex (`AGENTS.md`), and Kiro (`.kiro/steering/agend-<name>.md`) all had the dual-injection pattern.
- A second silent dual-injection source (`AGEND_DECISIONS` via mcpEnv vs. `buildFleetInstructions({ decisions })`) was caught and folded into the same gate.

Fix shipped Option B generalization (over Option A "MCP-only") — the original issue presented a binary choice; we chose the human-debuggable + non-MCP-dependent path.

- `CliBackend.nativeInstructionsMechanism: 'append-flag' | 'project-doc' | 'none'`
- `daemon.buildBackendConfig()` drops fleet-context env vars when the backend declares its own native injection
- MCP server gates the `instructions` capability via `AGEND_DISABLE_MCP_INSTRUCTIONS` env

Net: 12 files / +265 / -11. Tests: 12 new (parametrised across all 6 backends), 517/517 pass post-fix.

## Feature #24 — fix detail

Two-PR sequence:

1. **PR #57** (~30 min, src +23 / tests +184): cost-guard pre-check in `sendToInstance`/`delegateTask`. ts-impl correctly stayed in scope per dispatch.
2. **PR #58** (~25 min, src +14 / tests +133): broadcast surface, surfaced by ts-reviewer's #57 review as Out-of-scope Observation 1. Per-target gate inside the existing fan-out loop, with new `cost_limited` field in the result envelope (backwards-compat: existing consumers of `sent_to`/`failed`/`count` unaffected).

Net combined: src +37, tests +317, 524→527 tests pass.

Pattern note: dispatching the broadcast follow-up as a separate PR (rather than expanding #57 mid-review) preserved a clean review record and let the original PR ship without churn — same pattern dev-lead has been using on Sprint 19+.

## Closed issues — migration path

All four close comments are individually personalised:

- Each cites a concrete detail from the issue body (incident date for #52/#54, the issue's own dependency declaration for #53, token-discipline angle for #8).
- Each links forward to `agend-terminal`'s issue tracker.
- Each acknowledges the value of the proposal — close-with-respect, not close-as-rejected.
- Wording reviewed by general before posting (`watered-down implementation` → `incomplete implementation` on #53 for technical neutrality).

## Process notes

- **Operator delegation handoff**: operator TUI 01:18 → general overnight 01:52. ts-lead initially declined a Sprint 0 dispatch from general (correctly — no durable instruction yet); general posted `d-20260427025246010573-0` as evidence; ts-lead verified and authority chain accepted. Both sides recorded incident lessons in the decision body.
- **Worktree discipline**: every PR opened from a fresh worktree (`fix/55-fleet-context-dual-injection`, `feat/24-usage-limit-notify`, `fix/broadcast-cost-guard-gap`). Main never modified directly.
- **Reviewer Contract v1.1**: every review reported `scope_source`, `audit_mode`, `reviewed_head`, exact commands run, files audited, with explicit out-of-scope observations surfaced separately from blocking findings.
- **Operator hard rule "務必確認可正確運行"**: applied especially to #24 — three-state mock test (limited / not-limited / null-costGuard) was the test scaffold for both #57 and #58.

## Backlog spawned this sprint

- `docs/ts-team-backlog.md` B-001: session-routing edge case in cost-guard gate (low priority, deferred).

## Next

Sprint 1 — pure-cleanup (no new code on production paths):

- **Track 1**: docs migration consistency audit + deprecation banner on user-facing docs.
- **Track 2**: GitHub label scaffold (`migrated-to-agend-terminal`, `wontfix-deprecated`), retroactive labelling on this sprint's closed issues, `.github/ISSUE_TEMPLATE/config.yml` redirect link.

Sprint 1 dispatch follows once this wrap doc is merged.
