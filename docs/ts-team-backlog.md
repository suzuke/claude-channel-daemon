# ts-team backlog

Tracking non-blocking gaps surfaced during deprecated-mode maintenance. Items here did not block the sprint they were found in. They are kept for future-sprint pickup, agend-terminal port, or eventual `wontfix` closure.

## Open

### B-001 — Session-routing edge case in cost-guard gate

- **Surface**: `src/outbound-handlers.ts.sendToInstance()` cost-guard pre-check
- **Surfaced by**: ts-reviewer, PR #57 review (Out-of-scope Observation 2)
- **Surfaced at**: 2026-04-27, Sprint 0
- **Priority**: low
- **Description**:
  `isLimited(targetName)` is called *before* session resolution at `src/outbound-handlers.ts:101-105`. When `targetName` is an external session name (resolved later via `ctx.sessionRegistry.get(targetName)` at line 115), `CostGuard` returns 0 for the unresolved name and the gate is bypassed — even when the *host* instance is over its daily limit.
- **Impact**: Cost-guard protection is incomplete on the session-routing path. Probably rare in practice (external user sessions are typically the destination, not over-budget targets), but the gate's protection is non-uniform.
- **Estimated fix**: ~5 LOC src + 1 test. Resolve to host instance name first, then check `isLimited` against the resolved name.
- **Disposition**: deferred. Decision boundary: if hit rate stays low through agend-terminal migration window → close as `wontfix-deprecated`. If a real incident lands → reopen and patch.
