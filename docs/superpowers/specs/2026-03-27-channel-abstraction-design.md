# Channel Abstraction Design

**Date:** 2026-03-27
**Status:** Approved
**Context:** Enable CCD to support multiple messaging platforms (Discord, Slack, etc.) beyond Telegram.
**Reviewed by:** ccplugin instance (design direction confirmed)

## Strategy

Clean up the abstraction layer first, then add Discord as the first non-Telegram channel. The design must preserve Telegram's full feature set while enabling graceful degradation on less capable platforms.

## Core Principle

**Upper layer expresses intent, adapter decides presentation.** No capability flags, no `if (adapter.supports.X)` branches in business logic.

## ChannelAdapter Interface

Replace the current interface with intent-oriented high-level methods:

```typescript
interface Choice {
  id: string;
  label: string;
}

interface InstanceStatusData {
  name: string;
  status: "running" | "stopped" | "crashed" | "paused";
  contextPct: number | null;
  costCents: number;
}

interface AlertData {
  type: "hang" | "cost_warn" | "cost_limit" | "schedule_deferred" | "rotation";
  instanceName: string;
  message: string;
  choices?: Choice[];  // e.g. "Force restart" / "Keep waiting"
}

interface ChannelAdapter extends EventEmitter {
  readonly type: string;
  readonly id: string;
  readonly topology: "topics" | "channels" | "flat";

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<void>;

  // Core messaging
  send(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage>;
  sendFile(chatId: string, filePath: string, opts?: SendOpts): Promise<SentMessage>;
  editMessage(chatId: string, messageId: string, text: string): Promise<void>;
  react(chatId: string, messageId: string, emoji: string): Promise<void>;
  downloadAttachment(fileId: string): Promise<string>;

  // Intent-oriented high-level methods
  promptUser(chatId: string, text: string, choices: Choice[], opts?: SendOpts): Promise<string>;
  reportStatus(chatId: string, instances: InstanceStatusData[]): Promise<SentMessage>;
  notifyAlert(chatId: string, alert: AlertData, opts?: SendOpts): Promise<SentMessage>;
  sendProgress(chatId: string, ref: SentMessage, text: string): Promise<void>;

  // Permission approval
  sendApproval(prompt: PermissionPrompt, callback: (decision: "approve" | "deny") => void, signal?: AbortSignal, threadId?: string): Promise<void>;

  // Topology-dependent (optional — only for 'topics' topology)
  createTopic?(name: string): Promise<number>;
  deleteTopic?(topicId: number): Promise<void>;
}
```

### Degradation Strategy

Each adapter handles degradation internally — the upper layer never branches on capabilities:

- **`promptUser`**: Telegram → inline keyboard + callback query. Discord → button components. Fallback → numbered text list + wait for reply match.
- **`reportStatus`**: Each adapter formats optimally for its platform.
- **`notifyAlert`**: Telegram → inline keyboard for choices. Fallback → text with instructions.
- **`sendProgress`**: Telegram → edit message in place. Fallback → send new message.
- **`react`**: Platforms without reactions → no-op (silent).

Only `UnsupportedOperationError` for truly impossible operations (e.g., webhook adapter can't receive replies for `promptUser`). Upper layer catches this at a single point.

### Topology

The only adapter property the upper layer inspects for architectural decisions:

```
topology === "topics"   → One group + N forum topics (Telegram current mode)
topology === "channels" → N independent channels (Discord: one text channel per instance)
topology === "flat"     → Pure DM, no topic routing (future: webhook, CLI)
```

Fleet manager reads `topology` once at startup to decide routing strategy. After that, all messaging goes through `send(chatId, text, { threadId })` uniformly.

## Adapter Factory

```typescript
// src/channel/factory.ts
function createAdapter(config: ChannelConfig, opts: AdapterOpts): ChannelAdapter {
  switch (config.type) {
    case "telegram": return new TelegramAdapter(opts);
    case "discord":  return new DiscordAdapter(opts);
    default: throw new Error(`Unknown channel type: ${config.type}`);
  }
}
```

`ChannelConfig.type` changes from `"telegram"` (literal) to `string` to allow new types.

## Refactoring: Remove Telegram Coupling

Current direct TelegramAdapter references in business logic:

| Location | Current | After |
|----------|---------|-------|
| `fleet-manager.ts` — `sendTextWithKeyboard` | Cast to TelegramAdapter | Use `promptUser` or `notifyAlert` |
| `fleet-manager.ts` — `getBot()` for topic probing | Cast to TelegramAdapter | Use optional `createTopic`/`deleteTopic` |
| `fleet-manager.ts` — `setLastChatId/getLastChatId` | Cast to TelegramAdapter | Move to adapter internal state |
| `fleet-manager.ts` — `closeForumTopic` | Cast to TelegramAdapter | Use optional `deleteTopic` |
| `daemon.ts` — direct TelegramAdapter instantiation | `new TelegramAdapter(...)` | Use `createAdapter(config, opts)` |
| `topic-commands.ts` — `sendTextWithKeyboard` | Cast to TelegramAdapter | Use `promptUser` |

After refactoring, fleet-manager.ts, daemon.ts, and topic-commands.ts should have **zero imports** from `channel/adapters/telegram.ts`.

## Configuration

```yaml
channel:
  type: telegram          # or "discord"
  mode: topic             # topic or dm
  bot_token_env: CCD_BOT_TOKEN
  group_id: -100xxxxxxxxxx
  access:
    mode: locked
    allowed_users:
      - 123456789
```

For Discord:
```yaml
channel:
  type: discord
  mode: topic             # maps to forum channels
  bot_token_env: CCD_DISCORD_TOKEN
  guild_id: "123456789"
  access:
    mode: locked
    allowed_users:
      - "discord_user_id"
```

## Implementation Phases

### Phase A: Abstract (no new channels)
1. Add intent-oriented methods to ChannelAdapter interface
2. Implement them in TelegramAdapter
3. Add adapter factory
4. Refactor fleet-manager, daemon, topic-commands to remove all TelegramAdapter casts
5. Change `ChannelConfig.type` from literal `"telegram"` to `string`
6. Verify all existing tests pass — no behavior change

### Phase B: Discord adapter
1. Create DiscordAdapter implementing ChannelAdapter
2. Map Discord concepts: guild → group, forum channel → topic, thread → reply
3. Add Discord-specific config parsing
4. Integration testing with Discord bot

## Non-goals

- Slack adapter (future — after Discord validates the abstraction)
- Matrix adapter (future)
- Multi-channel per fleet (one fleet = one channel type)
- Channel bridging (forwarding between Telegram and Discord)
