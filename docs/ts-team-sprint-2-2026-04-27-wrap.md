# ts-team Sprint 2 wrap — 2026-04-27

**Window**: 2026-04-27 03:42 UTC → 05:21 UTC (~1h40m wall time)
**Repo**: AgEnD (TS), maintenance mode
**Authority chain**: operator overnight delegation (`d-20260427025246010573-0`, 24h TTL) → general acting as strategic surrogate
**Cross-team**: dev-team (agend-terminal Rust) coordinator — dev-lead, dev-reviewer-2, dev-impl-2

## Mission

Author the canonical TS → Rust migration guide as input to agend-terminal's Sprint 24 docs scope. Cross-team request from dev-lead (m-20260427033526880196-267): agend-terminal `dev-reviewer-2` self-identifies as zero-TS-context and cannot lead-author the diff doc; ts-team has the necessary context.

## Outcome

| Phase | Deliverable | PR | Merge SHA |
|---|---|---|---|
| A | §§2-3 (CLI flag mapping + fleet.yaml schema diff) + 7-section skeleton | #63 | `766295d3` |
| B | §§4-5 (Backend invocation diff + MCP tool API diff) | #64 | `73f046bd` |
| A follow-up | §3 `outbound_capabilities` row (cross-team #230 forward-link) | #65 | `9292f696` |
| C | §§1, 6, 7 (Why migrate + Migration steps + Known incompat) | #66 | `081c547f` |
| Wrap | This doc | #(pending) | (pending) |

Final state: `docs/migration-to-agend-terminal.md` (+ zh-TW pair) is a complete 7-section operator-facing migration guide. Anchors stable across all phases. zh-TW maintains 1:1 parity with EN throughout.

## Cross-team coordination — primary win of this sprint

The migration guide spans TS knowledge (ts-team owns) and Rust API surface (agend-terminal team owns). Sprint 2 operationalised general's D3 pattern (single-hop direct dispatch, no general intermediary) for cross-team review:

- **Drafting authority**: ts-impl + ts-reviewer (role-swap accepted per general D5 for the parallel A+B split)
- **TS-side audit**: ts-reviewer (Phases A, A follow-up, C); ts-impl (Phase B, role-swap reciprocal)
- **Rust-side audit**: dev-reviewer-2 (cross-team `scope_conformance`) — explicit "Rust API correctness from agend-terminal hot context perspective; zero-TS-context boundary" framing in every dispatch
- **Source pointers**: ts-impl + ts-reviewer routinely queried dev-impl-2 directly (single-hop) for Rust API source verification during drafting; dev-impl-2 returned authoritative file:line pointers (e.g. `src/main.rs:165-337`, `src/fleet.rs:7-183`) which became the doc's reference citations

The boundary held cleanly. dev-reviewer-2's findings consistently caught Rust-side fact errors that ts-reviewer (correctly) couldn't have flagged: drop-log severity (`tracing::debug!` vs claimed `WARN`), `TeamConfig::orchestrator` field omission, `auto_create_general` line-range citation drift, Sprint 11 timeline framing, `portable-pty` crate abstraction layer, and the wrong-PR-citation finding (`#197/#199` → `#149/#161`) that ts-reviewer had unintentionally introduced into ts-impl's revision via O1 wording. ts-reviewer's findings consistently caught TS-side framing errors and writing-quality gaps dev-reviewer-2 (correctly) couldn't audit: the "TS migration guidance reversal" premise overstating actual TS docs, fully-qualifying `channel.access.allowed_users`, and pairing-mode user enumeration. Two reviewers with disjoint expertise produced strictly better quality than either could alone.

## Cross-team merge-ordering — handled cleanly

PR #65 (Phase A follow-up adding `outbound_capabilities`) cross-linked five URLs into agend-terminal's pre-merge `MIGRATION-OUTBOUND-CAPS.md` and `src/fleet.rs:173-208` Sprint 22 P0 doc-comment. dev-reviewer-2's audit flagged BLOCKER-class merge-ordering: TS #65 cannot merge before agend-terminal #230 ships, since `/blob/main/...` URL form would 404 against pre-#230 main.

Resolution: dev-lead committed to a one-line ping when #230 merged. The expected 1-1.5h ETA collapsed to 2 minutes (#230 merged at 04:57:18Z). Sequential merge held; pin-to-commit-SHA fallback was offered but not needed. dev-reviewer-2 self-resolved the carry-forward F1 cross-link 404 finding when the audit re-fetched the link post-#230-merge.

The pattern is reusable: cross-team forward-link PRs gate on the upstream merge with explicit dispatcher coordination, not commit-SHA churn.

## Architectural side-fix routed to dev-team — also clean

Phase A audit surfaced a load-bearing operator concern: `outbound notify dropped` log line is at `tracing::debug!` not `warn!`, so default `RUST_LOG=info` operators grep for it and find nothing — exactly opposite of what the migration guide is trying to teach. Doc-side fix ( `RUST_LOG=debug` instruction + `WARN`→`DEBUG` correction) unblocked Phase A merge. Architectural fix (raise the macro to `warn!` for security-gate visibility, aligning with inbound's existing `warn!` at `telegram.rs:592`) was surfaced to dev-lead as cross-team suggestion. Outcome: dev-lead accepted, filed as **F-NEW-OUTBOUND-DROP-LOG-SEVERITY-1** in agend-terminal Sprint 22 P1 1-line micro-PR queue. Doc-side fix remains as belt-and-suspenders.

## Iteration cycles — quality control worked

Phase A: initial REJECTED (dev-reviewer-2) + VERIFIED-with-findings (ts-reviewer) → 6 findings revised in one commit-on-top → both delta VERIFIED → merged. The reject cycle caught real fact errors (drop-log severity, TeamConfig field omission, group_id reversal premise) that would have shipped misleading content.

Phase B: VERIFIED + VERIFIED → ts-reviewer self-revised polish (16-line surgical, ts-lead inspection skipped delta cycle, merged on inspection per protocol §10.3 audit-trail in commit body).

Phase A follow-up: VERIFIED + VERIFIED + 1 BLOCKER (merge-ordering) + 2 LOW → ts-impl revised line-range citation while sequentially waiting #230 → ts-lead inspection skipped delta cycle, merged on inspection.

Phase C: VERIFIED + VERIFIED + 1 MEDIUM + 2 LOW → revised → both delta VERIFIED + cross-team observation caught wrong PR citation (`#197/#199` → `#149/#161`) → ts-impl one-character micro-fix → ts-lead inspection skipped delta cycle, merged on inspection.

Three of four merges used the ts-lead-inspection-on-polish-cycle pattern (PR #65, #65 polish, #66 polish, #66 micro-fix). The pattern is: dual VERIFIED at the prior commit + polish or micro-fix is mechanical/textually surgical + ts-lead reads the diff and confirms no substantive change + audit-trail in merge commit body. This is the protocol §10.2 E2.4 freshness boundary read with operator judgment, not a bypass.

## ts-impl source-of-truth verification habit upgrade

ts-impl flagged a process learning at the citation-drift micro-fix: ts-reviewer's O1 finding cited Rust PRs `#197/#199` from memory (stale recall — actual PRs were Sprint 18 work, not the busy-gate origins); ts-impl adopted the wording verbatim. dev-reviewer-2 caught the drift via `git log -L` blame on `src/mcp/tools.rs:50-53`. ts-impl's commitment going forward: cross-verify reviewer-supplied PR/source citations against `git blame` or `gh pr view` before adopting into doc text. This belongs in the wrap because cross-team work amplifies the cost of stale citations — Rust-side reviewers won't catch a Rust-side citation if it was introduced by a TS-side finding chain.

## Wall-time efficiency

| Phase | Drafting | Audit + revise + merge | Total wall |
|---|---|---|---|
| A | ~50m | ~30m (incl. 6-finding revise) | ~1h20m |
| B | ~25m (parallel with A) | ~10m | overlapped |
| A follow-up | ~25m | ~10m (incl. cross-team merge-ordering wait) | overlapped |
| C | ~1h | ~15m | overlapped |

Sprint 2 wall time `03:42 → 05:21` ≈ **1h40m** including all phases, all reviews, all polish cycles, cross-team coordination, and 6 PRs landed (including this wrap). General's D5 phase-split estimate was 5-7h sequential or ~5h parallel; actual delivery was ~1h40m due to (a) ts-reviewer drafting Phase B in parallel with Phase A (drafting + audit overlap), (b) ts-lead inspection skipping delta cycles on polish-only revisions, (c) cross-team merge-ordering ETA collapsing 4-5h → 2 minutes, (d) `dev-reviewer-2` rapid cross-team turnaround.

## Backlog state

`docs/ts-team-backlog.md` unchanged. B-001 (session-routing edge case in cost-guard gate from Sprint 0) remains low-priority deferred. No new backlog items spawned in Sprint 2 — every finding was either fixed inline or accepted-as-is with explicit audit trail.

## Sprint 24 readiness signal — for dev-lead

`docs/migration-to-agend-terminal.md` (+ zh-TW pair) is **ready for agend-terminal Sprint 24 input**. Specifically:

- Stable anchors (`{#why-migrate}`, `{#cli-flag-mapping}`, `{#fleet-yaml-schema-diff}`, `{#backend-invocation-diff}`, `{#mcp-tool-api-diff}`, `{#migration-steps}`, `{#known-incompatibilities}`) are usable as deep-link targets from agend-terminal docs.
- `docs/MIGRATION-OUTBOUND-CAPS.md` ↔ `docs/migration-to-agend-terminal.md#fleet-yaml-schema-diff` cross-link is in place (Sprint 22 P0 outbound_capabilities → migration guide §3 entry, both directions).
- `pending` markers preserved per protocol §3.5.8 wherever Rust capability matrix has unverified semantics — no overclaim.
- Behaviour change notification commitment (dev-lead m-20260427045515258534-360) means TS-side adopted any necessary delta inline; no stale-doc risk at Sprint 24 dispatch.

## Next horizon

No fixed Sprint 3 plan committed at this wrap. Operator wake (estimated 07:52-09:52 UTC) will set direction. Likely candidates if direction is still ts-repo maintenance:

- Bot-side ergonomic gaps surfaced during this sprint by smoke-test step-6 walkthrough (e.g. `agend-terminal status` on minimal config returning a noisy default — operator-facing usability)
- B-001 backlog item promotion if session-routing path becomes hit
- New cross-team requests from dev-lead for Sprint 25+

Otherwise idle until operator returns with direction.
