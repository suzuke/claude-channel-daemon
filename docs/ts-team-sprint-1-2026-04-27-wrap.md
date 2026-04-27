# ts-team Sprint 1 wrap — 2026-04-27

**Window**: 2026-04-27 03:31 UTC → 03:41 UTC (~10m)
**Repo**: AgEnD (TS), maintenance mode
**Authority chain**: operator overnight delegation (`d-20260427025246010573-0`, 24h TTL) → general acting as strategic surrogate

## Mission

Pure-cleanup sprint, no new code on production paths. Two parallel tracks:

- Track 1: docs migration consistency audit + deprecation banner on user-facing docs.
- Track 2: GitHub label scaffold, retroactive labelling on Sprint 0 closed/fixed issues, and `ISSUE_TEMPLATE` redirect.

## Outcome

| Track | Deliverable | Evidence |
|---|---|---|
| Track 1 | Deprecation banner on 13 user-facing docs | PR #61 squash-merged `38ec6aac` |
| Track 2a | Three labels created (`migrated-to-agend-terminal` #50bf60, `wontfix-deprecated` #888888, `bug-fixed-in-maintenance` #fbca04) | repo label state |
| Track 2b | Labels applied: `migrated-to-agend-terminal` × 4 (#52 #53 #54 #8); `bug-fixed-in-maintenance` × 1 (#55) | issue state |
| Track 2c | `.github/ISSUE_TEMPLATE/config.yml` redirect (blank issues kept open for security/critical) | PR #60 squash-merged `6f0be6ce` |

Sprint 1 ledger: 0 open issues / 0 open PRs at wrap. Repo presents a coherent post-deprecation surface to users — README banner, every user-facing doc banner, ISSUE_TEMPLATE redirect, and labelled issue history all point the same direction.

## Track 1 — banner detail

13 docs touched (102 insertions, 0 deletions):

- `cli.{md,zh-TW.md}`, `configuration.{md,zh-TW.md}` — standard banner
- `features.{md,zh-TW.md}` — standard + feature-surface caveat
- `plugin-development.md` — standard + plugin-protocol caveat
- `ROADMAP.{md,zh-TW.md}` — standard + historical-snapshot note (banner placed before existing `> Last updated:` metadata)
- `SECURITY.{md,zh-TW.md}` — condensed banner + reports-still-accepted clause (security reports remain a valid use of this repo)
- `CHANGELOG.{md,zh-TW.md}` — condensed banner + future-entries scope (security fixes + backend CLI compatibility only)

Hard rule from sprint scope: internal design docs unchanged. Verified by reviewer via grep against the explicit exclusion list (`superpowers/`, `specs/`, `fix-plan.md`, `p4.1-split-plan.md`, `design-ux-pain-points.md`, `rebrand-plan.md`, `multi-backend-feasibility.md`, `plugin-adapter-architecture.md`, `approval-system-analysis.md`, `context-rotation-design.md`, `cross-cli-research.md`, `cross-instance-messaging.md`, `feature-roadmap.md`, `issue-evaluations.md`, `token-overhead-report*.md`) — zero matches in the diff.

Wording variation per-doc rather than copy-paste: features doc explicitly notes that the agend-terminal feature surface may differ; ROADMAP frames itself as a v1.12.0 planning snapshot retained for reference; SECURITY drops the technical pitch since the audience is reporting security issues, not evaluating the project; CHANGELOG follows the same condensation since changelog readers want history, not promotion.

zh-TW translations preserve `agend-terminal` keyword, the GitHub URL, and the `` `@suzuke/agend` `` package identifier in English; banner body is fluent 繁體中文.

## Track 2 — label detail

The label vocabulary now distinguishes three legitimate states for closed issues in this repo:

- `migrated-to-agend-terminal` — closed here because the work belongs in the spiritual successor; reopen at agend-terminal.
- `wontfix-deprecated` — declined; not migrating either. Reserved for future-sprint use.
- `bug-fixed-in-maintenance` — fix shipped despite maintenance mode. Signals to readers that critical bug fixes do still land in this repo.

Retroactive labelling covered Sprint 0's complete output: four close-with-migration issues plus one shipped fix (#55). New labels apply to whatever follows in subsequent sprints, with retroactive use possible if older issues need re-classification.

ISSUE_TEMPLATE redirect was deliberately built around `blank_issues_enabled: true` rather than disabling blank issues. Disabling would block legitimate security and critical-bug reports from reaching this repo while it is still receiving security fixes per the deprecation notice. The redirect is a contact link, not a wall.

## Process notes

- Tracks parallelised cleanly. Track 2 (label CLI + ISSUE_TEMPLATE in worktree) ran by ts-lead while Track 1 (ts-impl + ts-reviewer) ran in the dispatch pipeline.
- Reviewer dispatch carried explicit `audit_mode: light_review` for Track 1 — operator-authorized for docs-only PRs, no `tsc`/`vitest` overhead. Reviewer respected the boundary.
- Hard-rule grep enforcement (against the internal-doc exclusion list) is a reusable pattern for future doc sprints.
- Total wall time 10 minutes for the dispatched track from claim to merge, an order of magnitude faster than Sprint 0's code work — appropriate, since the inputs were content-light and the pattern was pre-decided.

## Sprint 2 candidate

**Cross-team request received**: dev-lead (agend-terminal) flagged a dependency on a TS → Rust migration guide as input to agend-terminal's own Sprint 24 docs scope. Their dev-reviewer-2 self-identifies as zero-TS-context and cannot lead-author the diff doc; ts-team has the necessary context.

Proposed Sprint 2 primary deliverable: **`docs/migration-to-agend-terminal.md`** (and zh-TW pair) — the canonical TS→Rust migration guide.

Tentative scope (subject to general align):

- CLI flag mapping table (TS `agend` ↔ Rust `agend-terminal` invocation)
- `fleet.yaml` schema diff (which fields carry, which renamed, which dropped, which Rust-only)
- Backend invocation patterns diff (especially the post-#56 `nativeInstructionsMechanism` model)
- MCP tool API diff (cross-instance comm surface is the highest-friction migration point per Sprint 0 review)
- Concrete migration steps (fresh install vs. in-place; data export/import paths)
- Known incompatibilities and deferred parity items

Estimated size: M-L. Pipeline: ts-impl drafts (TS context) → agend-terminal `dev-reviewer-2` cross-reviews (Rust context) → ts-reviewer cross-team-dispatch audit → ts-lead merge gate.

Cross-team narrative coherence rationale: agend-terminal as mature spiritual successor; this repo as retiring TS doc with explicit migration pointer. Sprint 0 close comments already pre-embedded `agend-terminal` links; this sprint operationalises the migration path those comments promised.

Awaiting general align on Sprint 2 scope and timing relative to agend-terminal's Sprint 24 start.

## Backlog state

`docs/ts-team-backlog.md` unchanged. B-001 (session-routing edge case in cost-guard gate) remains low-priority deferred. No new entries surfaced in Sprint 1.
