# branch_instance — Fork Conversation to New Topic

## Status

Draft — 2026-03-28

## Goal

Let users fork an ongoing Claude conversation into a new Telegram topic while preserving full context. Both the original and forked conversations continue independently.

## Use Cases

**1. Exploration divergence**
User is discussing a feature design. Wants to explore two approaches in parallel — fork the conversation, try approach A in the original topic and approach B in the new one.

**2. Task delegation**
User is working on a complex task. Partway through, Claude identifies a subtask. User forks the conversation so the subtask runs in its own topic while the main task continues.

**3. Context preservation**
User has built up significant context (codebase understanding, decisions made, constraints discussed). Wants to start a related but different task without losing that context and without re-explaining everything.

## MCP Tool Interface

```typescript
{
  name: "branch_instance",
  description:
    "Fork the current conversation into a new Telegram topic. " +
    "The new instance starts with the full conversation history up to this point. " +
    "Both original and forked conversations continue independently.",
  inputSchema: {
    type: "object",
    properties: {
      topic_name: {
        type: "string",
        description: "Name for the new Telegram topic. Defaults to '<current-topic> (branch)'."
      },
      message: {
        type: "string",
        description: "Optional kickoff message to send to the forked instance. If omitted, the fork starts idle."
      }
    },
    required: []
  }
}
```

**Response (success):**
```json
{
  "success": true,
  "name": "feature-branch-t3120",
  "topic_id": 3120,
  "forked_from_session": "e890afd7-6be1-4997-9726-091148d67395"
}
```

**Response (error):**
```json
{
  "error": "Session ID not available — instance may still be starting up"
}
```

## Behavior

### Happy path

1. User (or Claude) calls `branch_instance({ topic_name: "approach-B" })`
2. CCD reads the current instance's `statusline.json` to get `session_id`
3. CCD creates a new Telegram topic named "approach-B"
4. CCD creates a new instance with `working_directory` same as source
5. The new Claude process launches with `--resume <session-id> --fork-session`
6. Claude Code creates a new session UUID, loads the full transcript from the source session, and starts fresh from that point
7. If `message` was provided, CCD sends it to the new instance as a channel message
8. Both instances run independently from this point

### Edge cases

| Scenario | Behavior |
|----------|----------|
| Source instance has no session_id yet (just started) | Return error: "Session ID not available" |
| Source instance is mid-rotation (context guardian ROTATING state) | Return error: "Instance is rotating — try again after rotation completes" |
| Topic creation fails (Telegram API error) | Return error with Telegram API message, no side effects |
| New instance fails to start | Rollback: delete topic, remove config entry |
| `--fork-session` not supported by Claude Code version | Startup will fail, caught by postLaunch timeout → rollback |
| Same session forked multiple times | Each fork gets its own UUID — no conflict |
| Source and fork share working_directory | OK — Claude Code handles concurrent access to the same project (separate .jsonl transcripts) |

### What the fork inherits

| Aspect | Inherited? |
|--------|-----------|
| Full conversation history | Yes (via --resume) |
| Context window usage | Yes (starts at same % as source at fork point) |
| Memory files (CLAUDE.md, memory/) | Yes (same working_directory) |
| Scheduled tasks | No (schedules belong to source instance) |
| Tool status display | No (fresh) |
| Cost tracking | Separate (new instance, own cost counter) |

### Limitations

- The fork starts with the source's context already partially used. If the source was at 60% context, the fork also starts at ~60%.
- Cannot fork to a different working_directory (would break the --resume transcript references).
- Fork is one-way — you cannot merge conversations back together.

## Implementation Plan

### Files to change

| File | Change |
|------|--------|
| `src/backend/types.ts` | Add `forkFromSession?: string` to `CliBackendConfig` |
| `src/backend/claude-code.ts` | `buildCommand()`: if `forkFromSession`, add `--resume <id> --fork-session` instead of normal `--resume` |
| `src/channel/mcp-server.ts` | Add `branch_instance` tool definition |
| `src/daemon.ts` | Add `branch_instance` to `CROSS_INSTANCE_TOOLS` set |
| `src/fleet-manager.ts` | Add `case "branch_instance"` handler |
| `src/backend/claude-code.ts` | Add `mcp__ccd-channel__branch_instance` to permission allow list |

### Step-by-step

**Step 1: Backend config (types.ts + claude-code.ts)**

Add `forkFromSession` to `CliBackendConfig`:
```typescript
export interface CliBackendConfig {
  // ...existing fields...
  forkFromSession?: string;  // session UUID to fork from
}
```

Update `buildCommand()` in `claude-code.ts`:
```typescript
// Replace the existing --resume logic:
if (config.forkFromSession) {
  cmd += ` --resume ${config.forkFromSession} --fork-session`;
} else {
  const sessionIdFile = join(this.instanceDir, "session-id");
  if (existsSync(sessionIdFile)) {
    const sid = readFileSync(sessionIdFile, "utf-8").trim();
    if (sid && /^[a-zA-Z0-9_-]+$/.test(sid)) cmd += ` --resume ${sid}`;
  }
}
```

**Step 2: MCP tool definition (mcp-server.ts)**

Add `branch_instance` to the tools list and to `SLOW_TOOLS`.

**Step 3: Daemon routing (daemon.ts)**

Add `"branch_instance"` to the `CROSS_INSTANCE_TOOLS` set (line ~585).

**Step 4: Fleet manager handler (fleet-manager.ts)**

```typescript
case "branch_instance": {
  const topicName = (args.topic_name as string) || `${instanceName} (branch)`;
  const kickoffMessage = args.message as string | undefined;

  // 1. Read source session ID from statusline.json
  const statusFile = join(this.getInstanceDir(instanceName), "statusline.json");
  let sourceSessionId: string;
  try {
    const data = JSON.parse(readFileSync(statusFile, "utf-8"));
    sourceSessionId = data.session_id;
    if (!sourceSessionId) throw new Error("no session_id");
  } catch {
    respond(null, "Session ID not available — instance may still be starting up");
    break;
  }

  // 2. Get source working directory
  const sourceConfig = this.fleetConfig?.instances[instanceName];
  if (!sourceConfig) {
    respond(null, `Source instance ${instanceName} not found in config`);
    break;
  }

  // 3. Create topic + instance (reuse create_instance logic, but with forkFromSession)
  let createdTopicId: number | undefined;
  let newInstanceName: string | undefined;
  try {
    createdTopicId = await this.createForumTopic(topicName);
    newInstanceName = `${sanitizeInstanceName(topicName)}-t${createdTopicId}`;

    const instanceConfig = {
      ...this.fleetConfig!.defaults,
      working_directory: sourceConfig.working_directory,
      topic_id: createdTopicId,
      forkFromSession: sourceSessionId,  // key addition
    } as InstanceConfig;

    this.fleetConfig!.instances[newInstanceName] = instanceConfig;
    this.routingTable.set(createdTopicId, { kind: "instance", name: newInstanceName });
    this.saveFleetConfig();

    await this.startInstance(newInstanceName, instanceConfig, true);
    await this.connectIpcToInstance(newInstanceName);

    // 4. Send kickoff message if provided
    if (kickoffMessage) {
      const ipc = this.instanceIpcClients.get(newInstanceName);
      if (ipc) {
        ipc.send({
          type: "fleet_inbound",
          content: kickoffMessage,
          meta: { chat_id: String(this.fleetConfig?.channel?.group_id ?? ""), thread_id: String(createdTopicId), user: "branch", ts: new Date().toISOString() },
        });
      }
    }

    respond({ success: true, name: newInstanceName, topic_id: createdTopicId, forked_from_session: sourceSessionId });
  } catch (err) {
    // Rollback (same pattern as create_instance)
    if (newInstanceName && this.daemons.has(newInstanceName)) await this.stopInstance(newInstanceName).catch(() => {});
    if (newInstanceName && this.fleetConfig?.instances[newInstanceName]) {
      delete this.fleetConfig.instances[newInstanceName];
      if (createdTopicId) this.routingTable.delete(createdTopicId);
      this.saveFleetConfig();
    }
    if (createdTopicId) await this.deleteForumTopic(createdTopicId);
    respond(null, `Failed to branch: ${(err as Error).message}`);
  }
  break;
}
```

**Step 5: Pass forkFromSession through daemon → backend**

In `daemon.ts`, the `buildBackendConfig()` method needs to check if the instance config has `forkFromSession` and pass it through. This only applies on the first spawn — after the forked instance starts, subsequent respawns should use the fork's own session-id.

```typescript
private buildBackendConfig(): CliBackendConfig {
  // ...existing code...
  return {
    // ...existing fields...
    forkFromSession: this.forkFromSession,  // set once, cleared after first spawn
  };
}
```

In `spawnClaudeWindow()`, after first successful spawn with fork, clear the flag:
```typescript
if (this.forkFromSession) {
  this.forkFromSession = undefined; // only fork on first spawn
}
```

**Step 6: Permission allow list**

Add `"mcp__ccd-channel__branch_instance"` to the allow list in `claude-code.ts`.

### Testing

1. **Basic fork**: In a topic with active conversation, call `branch_instance({ topic_name: "test-branch" })` → verify new topic appears → verify new instance has full conversation history
2. **Fork with message**: `branch_instance({ topic_name: "subtask", message: "Continue working on the CSS layout" })` → verify message appears in new topic
3. **Multiple forks**: Fork the same conversation twice → verify both forks are independent
4. **Fork during rotation**: Try to fork while context guardian is in ROTATING state → verify error message
5. **Rollback**: Simulate topic creation success but instance start failure → verify topic is deleted and config is clean
6. **Context preservation**: Ask Claude in the fork "what were we discussing?" → verify it has full context

### Risks

1. **`--fork-session` flag availability** — need to verify this flag exists in the installed Claude Code version. If not, the instance will fail to start and rollback will trigger.

2. **Context usage** — the fork inherits the source's context usage. A fork from a 70% context session only has 30% remaining. Consider warning the user if source context > 50%.

3. **forkFromSession persistence** — if `forkFromSession` is stored in fleet.yaml and the daemon restarts, it would try to fork again on next spawn. Solution: only use it for the initial spawn, then clear it. Don't persist to fleet.yaml.

4. **Same working_directory** — multiple instances sharing the same working_directory is fine for Claude Code (separate transcript files), but could cause issues if both try to modify the same files simultaneously. This is a user responsibility, not a CCD issue.
