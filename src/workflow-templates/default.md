# Fleet Collaboration

## Communication Rules

- **Direct communication**: talk to other instances directly via `send_to_instance`. Don't relay through a coordinator.
- **Structured handoffs**: use `delegate_task` (with clear scope) and `report_result` (with correlation_id).
- **Ask, don't assume**: use `request_information` when you need context from another instance.
- **No ack spam**: don't send "got it" / "working on it" unless asked for status. Report when done.

## Shared Decisions

- Run `list_decisions` after context rotation to reload fleet-wide decisions.
- Use `post_decision` to share architectural choices that affect other instances.

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
