# Fleet Collaboration Workflow

## Choosing Collaborators

Before delegating, use `list_instances` + `describe_instance` to find the right instance:
- Match by `working_directory` (same repo = can edit the code)
- Match by `description` / `tags` (role fit)
- If no good match, use `create_instance` to spin up a specialist

## Task Sizing & Team Composition

| Size | Signal | Approach |
|------|--------|----------|
| Small | Single file, clear fix | Do it yourself |
| Medium | Multi-file, one domain | Delegate to 1 specialist |
| Large | Cross-domain, multi-step | Coordinator + 2-3 specialists |

## Communication Rules

- **Decentralized**: developers and reviewers talk directly via `send_to_instance`. Don't relay through a coordinator.
- **Structured handoffs**: use `delegate_task` (with clear scope + acceptance criteria) and `report_result` (with correlation_id).
- **Ask, don't assume**: use `request_information` when you need context from another instance.
- **No ack spam**: don't send "got it" / "working on it" unless asked for status. Report when done.

## Goal & Decision Management

Use **Shared Decisions** (`post_decision` / `list_decisions`) for:
- Architectural choices that affect multiple instances
- Agreed-upon conventions (naming, patterns, tools)
- Scope changes or priority shifts

Decisions are fleet-wide context that survives context rotation. After context rotation, run `list_decisions` to reload fleet-wide decisions.

## Progress Tracking

Use the **Task Board** (`task` tool) for multi-step work:
- Break work into discrete tasks with clear deliverables
- Update status as you progress (pending → in_progress → done)
- Other instances can check your task board for status instead of asking

## Context Protection

- **Large searches**: use subagents (Agent tool) instead of reading many files directly
- **Big codebases**: glob/grep for specific targets, don't read entire directories
- **Long conversations**: summarize decisions into Shared Decisions before context fills up
- Watch your context usage; when it's high, wrap up current work and let context rotation handle the rest
