# Plugin Development Guide

Build channel adapter plugins for AgEnD. This guide uses the Discord adapter (`@suzuke/agend-plugin-discord`) as a reference implementation.

## Plugin Architecture

AgEnD's plugin system lets you add new channel adapters (Slack, Matrix, LINE, etc.) without modifying the core codebase. Plugins are standard npm packages that export a factory function.

```
fleet.yaml: channel.type: "slack"
    ↓
factory.ts tries import():
    1. @suzuke/agend-plugin-slack   (scoped official)
    2. agend-plugin-slack           (community)
    3. agend-adapter-slack          (legacy)
    4. slack                        (bare name)
    ↓
Plugin default export: createAdapter(config, opts) → ChannelAdapter
```

## Quick Start

### 1. Scaffold the Package

```bash
mkdir agend-plugin-myapp && cd agend-plugin-myapp
npm init -y
npm install -D typescript
```

**package.json:**

```json
{
  "name": "agend-plugin-myapp",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "peerDependencies": {
    "@suzuke/agend": ">=1.14.0"
  },
  "dependencies": {
    "myapp-sdk": "^1.0.0"
  }
}
```

Key points:
- `peerDependencies` on `@suzuke/agend` — don't bundle AgEnD itself
- `"type": "module"` — AgEnD uses ESM
- Your channel SDK goes in `dependencies`

**tsconfig.json:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

### 2. Implement the Adapter

**src/index.ts** — Plugin entry point:

```typescript
import type { ChannelAdapter } from "@suzuke/agend/channel";
import type { ChannelConfig } from "@suzuke/agend/types";
import { MyAppAdapter } from "./myapp-adapter.js";

interface AdapterOpts {
  id: string;
  botToken: string;
  accessManager: unknown;
  inboxDir: string;
}

export default function createAdapter(
  config: ChannelConfig,
  opts: AdapterOpts,
): ChannelAdapter {
  return new MyAppAdapter({
    ...opts,
    // Map config fields to your adapter's constructor
    serverId: config.group_id != null ? String(config.group_id) : "",
  });
}

export { MyAppAdapter } from "./myapp-adapter.js";
```

**src/myapp-adapter.ts** — The adapter class:

```typescript
import { EventEmitter } from "node:events";
import type {
  ChannelAdapter,
  ApprovalHandle,
  SendOpts,
  SentMessage,
  PermissionPrompt,
  Choice,
  AlertData,
} from "@suzuke/agend/channel";
import type { AccessManager } from "@suzuke/agend/channel/access-manager";
import { MessageQueue } from "@suzuke/agend/channel/message-queue";

export class MyAppAdapter extends EventEmitter implements ChannelAdapter {
  readonly type = "myapp";
  readonly id: string;
  readonly topology = "channels"; // or "topics" or "flat"

  private accessManager: AccessManager;
  // ... your SDK client

  constructor(opts: { id: string; botToken: string; accessManager: AccessManager; inboxDir: string; serverId: string }) {
    super();
    this.id = opts.id;
    this.accessManager = opts.accessManager;
    // Initialize your SDK client here
  }

  async start(): Promise<void> {
    // Connect to your service, start listening for messages
    // When a message arrives:
    //   this.emit("message", { source: "myapp", adapterId: this.id, chatId, threadId, messageId, userId, username, text, timestamp });
  }

  async stop(): Promise<void> {
    // Disconnect gracefully
  }

  // ... implement all required ChannelAdapter methods
}
```

### 3. The ChannelAdapter Interface

Every adapter must implement these methods:

| Method | Purpose |
|--------|---------|
| `start()` | Connect and begin receiving messages |
| `stop()` | Disconnect gracefully |
| `sendText(chatId, text, opts?)` | Send a text message |
| `sendFile(chatId, filePath, opts?)` | Send a file attachment |
| `editMessage(chatId, messageId, text)` | Edit a previously sent message |
| `react(chatId, messageId, emoji)` | Add emoji reaction |
| `sendApproval(prompt, callback, signal?, threadId?)` | Send permission request with approve/deny buttons |
| `downloadAttachment(fileId)` | Download a file to local path |
| `handlePairing(chatId, userId)` | Handle pairing flow |
| `confirmPairing(code)` | Confirm pairing code |
| `setChatId(chatId)` | Set the default chat ID |
| `getChatId()` | Get the current chat ID |
| `promptUser(chatId, text, choices, opts?)` | Send a choice prompt |
| `notifyAlert(chatId, alert, opts?)` | Send an alert notification |

**Optional methods** (for adapters supporting topics/channels):

| Method | Purpose |
|--------|---------|
| `createTopic?(name)` | Create a new topic/channel |
| `deleteTopic?(topicId)` | Delete a topic/channel |
| `topicExists?(topicId)` | Check if topic/channel exists |
| `closeForumTopic?(threadId)` | Close a forum topic |
| `reopenForumTopic?(threadId)` | Reopen a forum topic |
| `editForumTopic?(threadId, opts)` | Edit topic name/icon |
| `getTopicIconStickers?()` | Get available topic icons |

**Properties:**

| Property | Type | Purpose |
|----------|------|---------|
| `type` | `string` | Adapter identifier (e.g., `"myapp"`) |
| `id` | `string` | Instance ID |
| `topology` | `"topics" \| "channels" \| "flat"` | How the adapter organizes conversations |

**Events to emit:**

| Event | When | Data |
|-------|------|------|
| `message` | User sends a message | `InboundMessage` object |
| `callback_query` | User clicks an inline button | Query data |
| `topic_closed` | Topic/channel is archived | Topic ID |

### 4. Topology

The `topology` property tells AgEnD how your platform organizes conversations:

- **`"topics"`** — Telegram-style: one group chat with forum topics per instance
- **`"channels"`** — Discord-style: one server with text channels per instance
- **`"flat"`** — Simple: one conversation per instance, no threading

### 5. Message Flow

```
User sends message on your platform
    ↓
Your adapter receives it (SDK callback)
    ↓
Check access: this.accessManager.isAllowed(userId)
    ↓
Emit: this.emit("message", { source, chatId, threadId, messageId, userId, username, text, timestamp })
    ↓
AgEnD routes to the correct instance
    ↓
Agent processes and calls reply tool
    ↓
AgEnD calls your adapter.sendText(chatId, text, { threadId })
    ↓
Your adapter sends the response on your platform
```

## Available Imports from AgEnD

Your plugin can import these from the main package:

```typescript
// Types
import type { ChannelAdapter, SendOpts, SentMessage, ... } from "@suzuke/agend/channel";
import type { ChannelConfig } from "@suzuke/agend/types";

// Utilities
import type { AccessManager } from "@suzuke/agend/channel/access-manager";
import { MessageQueue } from "@suzuke/agend/channel/message-queue";
```

**MessageQueue** handles rate limiting and message ordering. Wrap your send/edit operations:

```typescript
this.queue = new MessageQueue({ send, edit, sendFile });
// Then use this.queue.send() instead of direct API calls
```

## Plugin Loading

AgEnD's `factory.ts` resolves plugins in this order:

1. `@suzuke/agend-plugin-{type}` — Scoped official plugins
2. `agend-plugin-{type}` — Community plugins
3. `agend-adapter-{type}` — Legacy naming convention
4. `{type}` — Bare package name

For each candidate, it tries:
1. `import(name)` — Local `node_modules`
2. Global npm fallback — `npm root -g` + absolute path import

The `default` export can be either:
- A **factory function**: `(config, opts) => ChannelAdapter`
- An **object** with `createAdapter`: `{ createAdapter(config, opts) => ChannelAdapter }`

## Publishing

```bash
npm run build
npm publish --access public
```

Users install and configure:

```bash
npm install -g agend-plugin-myapp
```

```yaml
# fleet.yaml
channel:
  type: myapp
  bot_token_env: MYAPP_BOT_TOKEN
  group_id: "server-id"
  access:
    mode: locked
    allowed_users:
      - "user-id"
```

```bash
# .env
MYAPP_BOT_TOKEN=your-token-here
```

## Reference: Discord Plugin

See [`plugins/agend-plugin-discord/`](../plugins/agend-plugin-discord/) for a complete, production adapter implementation covering all required methods.

Key files:
- `src/index.ts` — Factory function (default export)
- `src/discord-adapter.ts` — Full ChannelAdapter implementation (~470 lines)
- `package.json` — peerDependencies + discord.js dependency
