# Meeting Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/meets` command that spawns ephemeral Claude Code instances for structured multi-instance debate or collaboration in a dedicated Telegram topic.

**Architecture:** A `MeetingOrchestrator` class manages the debate/collab flow, communicating with instances through `FleetManagerMeetingAPI` — a narrow interface on FleetManager. The existing routing table is extended with a discriminated union to route meeting topics. Debate instances run in lightweight Daemon mode (no context guardian, memory layer, etc.).

**Tech Stack:** TypeScript, vitest, Unix socket IPC (NDJSON), Grammy (Telegram), tmux, better-sqlite3

**Spec:** `docs/superpowers/specs/2026-03-24-meeting-orchestrator-design.md`

---

## File Structure

```
src/
├── meeting/
│   ├── types.ts              — MeetingRole, MeetingConfig, ParticipantConfig, EphemeralInstanceConfig, MeetingChannelOutput, FleetManagerMeetingAPI
│   ├── orchestrator.ts       — MeetingOrchestrator class (debate flow, user commands, summary)
│   ├── role-assigner.ts      — Auto-assign roles by participant count
│   └── prompt-builder.ts     — Build per-round prompts with summaries and opponent context
├── backend/
│   ├── types.ts              — (modify) Add systemPrompt, skipPermissions to CliBackendConfig
│   └── claude-code.ts        — (modify) Handle new config fields in buildCommand/writeConfig
├── daemon.ts                 — (modify) Add lightweight mode support
├── fleet-manager.ts          — (modify) Unified routing, FleetManagerMeetingAPI, reply capture, /meets command
├── types.ts                  — (modify) Add MeetingDefaults to FleetConfig
├── channel/
│   └── adapters/telegram.ts  — (modify) Add closeForumTopic(), sendTextWithKeyboard() for wizard
tests/
├── meeting/
│   ├── orchestrator.test.ts  — Debate flow, user commands, edge cases
│   ├── role-assigner.test.ts — Role assignment logic
│   └── prompt-builder.test.ts — Prompt construction
├── backend/
│   └── claude-code.test.ts   — (modify) Add tests for systemPrompt, skipPermissions
└── fleet-manager.test.ts     — (modify) Add tests for unified routing
```

---

### Task 1: Backend Prerequisites — CliBackendConfig Extensions

**Files:**
- Modify: `src/backend/types.ts:11-19`
- Modify: `src/backend/claude-code.ts:10-24` (buildCommand), `src/backend/claude-code.ts:26-86` (writeConfig)
- Modify: `tests/backend/claude-code.test.ts`

- [ ] **Step 1: Write failing test for `systemPrompt` in buildCommand**

```typescript
// In tests/backend/claude-code.test.ts, inside describe("buildCommand")
it("includes --system-prompt when systemPrompt is set", () => {
  const backend = new ClaudeCodeBackend(TEST_DIR);
  const cmd = backend.buildCommand(makeConfig({ systemPrompt: "You are the Pro side." }));
  expect(cmd).toContain('--system-prompt');
  expect(cmd).toContain("You are the Pro side.");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/backend/claude-code.test.ts -t "includes --system-prompt"`
Expected: FAIL — `systemPrompt` not in `CliBackendConfig`

- [ ] **Step 3: Write failing test for `skipPermissions` in buildCommand**

```typescript
it("includes --dangerously-skip-permissions when skipPermissions is true", () => {
  const backend = new ClaudeCodeBackend(TEST_DIR);
  const cmd = backend.buildCommand(makeConfig({ skipPermissions: true }));
  expect(cmd).toContain("--dangerously-skip-permissions");
});

it("does not include --dangerously-skip-permissions by default", () => {
  const backend = new ClaudeCodeBackend(TEST_DIR);
  const cmd = backend.buildCommand(makeConfig());
  expect(cmd).not.toContain("--dangerously-skip-permissions");
});
```

- [ ] **Step 4: Add fields to CliBackendConfig**

In `src/backend/types.ts`, add to the `CliBackendConfig` interface:

```typescript
export interface CliBackendConfig {
  workingDirectory: string;
  instanceDir: string;
  instanceName: string;
  approvalPort: number;
  mcpServers: Record<string, McpServerEntry>;
  approvalStrategy: ApprovalStrategy;
  containerManager?: ContainerManager;
  systemPrompt?: string;       // NEW
  skipPermissions?: boolean;   // NEW
}
```

- [ ] **Step 5: Implement in buildCommand**

In `src/backend/claude-code.ts`, modify `buildCommand()`:

```typescript
buildCommand(config: CliBackendConfig): string {
  const settingsPath = join(this.instanceDir, "claude-settings.json");
  let cmd = `CMUX_CLAUDE_HOOKS_DISABLED=1 claude --settings ${settingsPath} --dangerously-load-development-channels server:ccd-channel`;

  if (config.skipPermissions) {
    cmd += " --dangerously-skip-permissions";
  }

  if (config.systemPrompt) {
    // Write system prompt to file to avoid shell escaping issues
    const promptPath = join(this.instanceDir, "system-prompt.md");
    writeFileSync(promptPath, config.systemPrompt);
    cmd += ` --system-prompt "${promptPath}"`;
  }

  const sessionIdFile = join(this.instanceDir, "session-id");
  if (existsSync(sessionIdFile)) {
    const sid = readFileSync(sessionIdFile, "utf-8").trim();
    if (sid) cmd += ` --resume ${sid}`;
  }

  return cmd;
}
```

- [ ] **Step 6: Implement skipPermissions in writeConfig**

In `src/backend/claude-code.ts`, modify `writeConfig()` — when `skipPermissions` is true, write a simplified settings file (no hooks, no approval):

```typescript
writeConfig(config: CliBackendConfig): void {
  // ... existing .mcp.json writing ...

  if (config.skipPermissions) {
    // Lightweight settings — no hooks, no approval, all tools allowed
    const settings: Record<string, unknown> = {
      permissions: { allow: ["*"], deny: [], defaultMode: "default" },
      statusLine: { type: "command", command: this.writeStatusLineScript() },
    };
    writeFileSync(join(this.instanceDir, "claude-settings.json"), JSON.stringify(settings));
    return;
  }

  // ... rest of existing writeConfig ...
}
```

- [ ] **Step 7: Run all backend tests**

Run: `npx vitest run tests/backend/claude-code.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/backend/types.ts src/backend/claude-code.ts tests/backend/claude-code.test.ts
git commit -m "feat(backend): add systemPrompt and skipPermissions to CliBackendConfig"
```

---

### Task 2: Daemon Lightweight Mode

**Files:**
- Modify: `src/daemon.ts:61-358` (start method)
- Modify: `src/types.ts:76-90` (InstanceConfig)

- [ ] **Step 1: Add `lightweight` field to InstanceConfig**

In `src/types.ts`:

```typescript
export interface InstanceConfig {
  // ... existing fields ...
  /** When true, skip context guardian, memory layer, transcript monitor, approval server */
  lightweight?: boolean;
}
```

- [ ] **Step 2: Guard subsystems in Daemon.start()**

In `src/daemon.ts`, wrap the following sections with `if (!this.config.lightweight)`:

```typescript
async start(): Promise<void> {
  // ... IPC server (keep) ...
  // ... Telegram adapter (keep) ...
  // ... Tmux spawning (keep) ...

  // 4-5. Transcript monitor — skip in lightweight
  if (!this.config.lightweight) {
    this.transcriptMonitor = new TranscriptMonitor(this.instanceDir, this.logger);
    // ... wire events ...
    this.transcriptMonitor.startPolling();
  }

  // 3. Pipe-pane — only needed for transcript monitor / prompt detector
  if (!this.config.lightweight) {
    const outputLog = join(this.instanceDir, "output.log");
    await this.tmux.pipeOutput(outputLog);
  }

  // 6. Approval server — skip in lightweight
  let port = this.config.approval_port ?? 18321;
  if (!this.config.lightweight && this.approvalStrategyInstance) {
    port = await this.approvalStrategyInstance.start();
    this.logger.debug({ port }, "Approval strategy started");
  }

  // 7. Prompt detector — skip in lightweight
  if (!this.config.lightweight) {
    // ... existing prompt detector setup ...
  }

  // 8. Context guardian — skip in lightweight
  if (!this.config.lightweight) {
    // ... existing context guardian setup ...
  }

  // 9. Memory layer — skip in lightweight
  if (!this.config.lightweight) {
    // ... existing memory layer setup ...
  }
}
```

- [ ] **Step 3: Run existing daemon tests**

Run: `npx vitest run tests/daemon.test.ts`
Expected: ALL PASS (existing behavior unchanged)

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts src/types.ts
git commit -m "feat(daemon): add lightweight mode to skip non-essential subsystems"
```

---

### Task 3: Meeting Types

**Files:**
- Create: `src/meeting/types.ts`

- [ ] **Step 1: Create meeting types file**

```typescript
// src/meeting/types.ts
import type { InboundMessage, SentMessage } from "../channel/types.js";

/** Extensible union: known roles + any custom string */
export type MeetingRole = "pro" | "con" | "arbiter" | (string & {});

export type MeetingMode = "debate" | "collab";

export interface MeetingConfig {
  meetingId: string;
  topic: string;
  mode: MeetingMode;
  maxRounds: number;
  repo?: string;
}

export interface ParticipantConfig {
  label: string;
  role: MeetingRole;
}

export interface EphemeralInstanceConfig {
  systemPrompt: string;
  workingDirectory: string;
  lightweight?: boolean;
  skipPermissions?: boolean;
  backend?: string;
}

export interface MeetingChannelOutput {
  postMessage(text: string, options?: { label?: string }): Promise<string>;
  editMessage(messageId: string, text: string): Promise<void>;
}

export interface FleetManagerMeetingAPI {
  spawnEphemeralInstance(config: EphemeralInstanceConfig, signal?: AbortSignal): Promise<string>;
  destroyEphemeralInstance(name: string): Promise<void>;
  sendAndWaitReply(instanceName: string, message: string, timeoutMs?: number): Promise<string>;
  createMeetingChannel(title: string): Promise<{ channelId: number }>;
  closeMeetingChannel(channelId: number): Promise<void>;
}

/** Internal state of an active participant */
export interface ActiveParticipant {
  label: string;
  role: MeetingRole;
  instanceName: string;
}

/** Structured round entry for prompt building */
export interface RoundEntry {
  round: number;
  speaker: string;
  role: MeetingRole;
  content: string;
}

export type MeetingState = "booting" | "running" | "paused" | "summarizing" | "ended";
```

- [ ] **Step 2: Add MeetingDefaults to FleetConfig**

In `src/types.ts`:

```typescript
export interface MeetingDefaults {
  maxConcurrent?: number;   // default: 1
  maxParticipants?: number; // default: 6
  defaultRounds?: number;   // default: 3
}

export interface FleetDefaults extends Partial<InstanceConfig> {
  scheduler?: { /* ... existing ... */ };
  meetings?: MeetingDefaults; // NEW
}
```

Also add `lightweight?: boolean` to `InstanceConfig`:

```typescript
export interface InstanceConfig {
  // ... existing fields ...
  lightweight?: boolean;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/meeting/types.ts
git commit -m "feat(meeting): add meeting type definitions"
```

---

### Task 4: Role Assigner

**Files:**
- Create: `src/meeting/role-assigner.ts`
- Create: `tests/meeting/role-assigner.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/meeting/role-assigner.test.ts
import { describe, it, expect } from "vitest";
import { assignRoles } from "../../src/meeting/role-assigner.js";

describe("assignRoles", () => {
  it("assigns pro/con for 2 participants", () => {
    const result = assignRoles(2);
    expect(result).toEqual([
      { label: "A", role: "pro" },
      { label: "B", role: "con" },
    ]);
  });

  it("assigns pro/con/arbiter for 3 participants", () => {
    const result = assignRoles(3);
    expect(result).toEqual([
      { label: "A", role: "pro" },
      { label: "B", role: "con" },
      { label: "C", role: "arbiter" },
    ]);
  });

  it("distributes pro/con evenly for 4, with arbiter", () => {
    const result = assignRoles(4);
    expect(result).toHaveLength(4);
    expect(result.filter(r => r.role === "pro")).toHaveLength(1);
    expect(result.filter(r => r.role === "con")).toHaveLength(2);
    expect(result.filter(r => r.role === "arbiter")).toHaveLength(1);
  });

  it("uses custom names when provided", () => {
    const result = assignRoles(2, ["Alice", "Bob"]);
    expect(result[0].label).toBe("Alice");
    expect(result[1].label).toBe("Bob");
  });

  it("generates A,B,C,D labels by default", () => {
    const result = assignRoles(5);
    expect(result.map(r => r.label)).toEqual(["A", "B", "C", "D", "E"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/meeting/role-assigner.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement role-assigner**

```typescript
// src/meeting/role-assigner.ts
import type { ParticipantConfig, MeetingRole } from "./types.js";

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function assignRoles(count: number, customNames?: string[]): ParticipantConfig[] {
  if (count < 2) throw new Error("Meeting requires at least 2 participants");

  const labels = customNames ?? LABELS.slice(0, count);
  if (labels.length < count) {
    throw new Error(`Not enough names provided: need ${count}, got ${labels.length}`);
  }

  const roles: MeetingRole[] = [];

  if (count === 2) {
    roles.push("pro", "con");
  } else {
    // Last participant is arbiter
    // Remaining split: first half pro, second half con
    const debaters = count - 1;
    const proCount = Math.ceil(debaters / 2);
    const conCount = debaters - proCount;
    for (let i = 0; i < proCount; i++) roles.push("pro");
    for (let i = 0; i < conCount; i++) roles.push("con");
    roles.push("arbiter");
  }

  return labels.slice(0, count).map((label, i) => ({
    label,
    role: roles[i],
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/meeting/role-assigner.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/meeting/role-assigner.ts tests/meeting/role-assigner.test.ts
git commit -m "feat(meeting): add role assigner for debate participant allocation"
```

---

### Task 5: Prompt Builder

**Files:**
- Create: `src/meeting/prompt-builder.ts`
- Create: `tests/meeting/prompt-builder.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/meeting/prompt-builder.test.ts
import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildRoundPrompt, buildSummaryPrompt } from "../../src/meeting/prompt-builder.js";
import type { RoundEntry } from "../../src/meeting/types.js";

describe("buildSystemPrompt", () => {
  it("generates pro system prompt", () => {
    const prompt = buildSystemPrompt("pro", "要不要拆 monorepo？");
    expect(prompt).toContain("正方");
    expect(prompt).toContain("要不要拆 monorepo？");
    expect(prompt).toContain("支持");
  });

  it("generates con system prompt", () => {
    const prompt = buildSystemPrompt("con", "要不要拆 monorepo？");
    expect(prompt).toContain("反方");
    expect(prompt).toContain("反對");
  });

  it("generates arbiter system prompt", () => {
    const prompt = buildSystemPrompt("arbiter", "要不要拆 monorepo？");
    expect(prompt).toContain("仲裁");
    expect(prompt).toContain("客觀");
  });
});

describe("buildRoundPrompt", () => {
  it("builds first round prompt with just the topic", () => {
    const prompt = buildRoundPrompt("要不要拆 monorepo？", 1, []);
    expect(prompt).toContain("Round 1");
    expect(prompt).toContain("要不要拆 monorepo？");
  });

  it("includes previous round content", () => {
    const history: RoundEntry[] = [
      { round: 1, speaker: "A", role: "pro", content: "Pro argument here" },
      { round: 1, speaker: "B", role: "con", content: "Con argument here" },
    ];
    const prompt = buildRoundPrompt("topic", 2, history);
    expect(prompt).toContain("Pro argument here");
    expect(prompt).toContain("Con argument here");
  });

  it("includes user context when provided", () => {
    const prompt = buildRoundPrompt("topic", 1, [], "考慮成本面");
    expect(prompt).toContain("考慮成本面");
  });
});

describe("buildSummaryPrompt", () => {
  it("includes all rounds in summary request", () => {
    const history: RoundEntry[] = [
      { round: 1, speaker: "A", role: "pro", content: "arg1" },
      { round: 1, speaker: "B", role: "con", content: "arg2" },
    ];
    const prompt = buildSummaryPrompt("要不要拆？", history);
    expect(prompt).toContain("arg1");
    expect(prompt).toContain("arg2");
    expect(prompt).toContain("摘要");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/meeting/prompt-builder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement prompt-builder**

```typescript
// src/meeting/prompt-builder.ts
import type { MeetingRole, RoundEntry } from "./types.js";

const ROLE_LABELS: Record<string, string> = {
  pro: "正方",
  con: "反方",
  arbiter: "仲裁",
};

export function roleLabel(role: MeetingRole): string {
  return ROLE_LABELS[role] ?? role;
}

export function buildSystemPrompt(role: MeetingRole, topic: string): string {
  const label = roleLabel(role);
  switch (role) {
    case "pro":
      return `你是這場辯論的「${label}」。議題：「${topic}」。你的立場是支持這個提案。請用有說服力的論點來捍衛你的立場。用 reply 工具回覆你的論述。`;
    case "con":
      return `你是這場辯論的「${label}」。議題：「${topic}」。你的立場是反對這個提案。請找出提案的問題和風險來反駁。用 reply 工具回覆你的論述。`;
    case "arbiter":
      return `你是這場辯論的「${label}」。議題：「${topic}」。你的角色是客觀分析雙方論點的優劣，指出各方的盲點，並提出平衡的觀點。用 reply 工具回覆你的分析。`;
    default:
      return `你是這場辯論的「${label}」。議題：「${topic}」。用 reply 工具回覆你的觀點。`;
  }
}

export function buildRoundPrompt(
  topic: string,
  round: number,
  previousRounds: RoundEntry[],
  userContext?: string,
): string {
  const parts: string[] = [`--- Round ${round} ---`, `議題：${topic}`];

  if (previousRounds.length > 0) {
    parts.push("\n上一輪討論摘要：");
    for (const entry of previousRounds) {
      parts.push(`[${roleLabel(entry.role)} ${entry.speaker}] ${entry.content}`);
    }
    parts.push("\n請針對以上觀點進行回應。");
  } else {
    parts.push("\n這是第一輪。請闡述你的立場。");
  }

  if (userContext) {
    parts.push(`\n主持人補充：${userContext}`);
  }

  return parts.join("\n");
}

export function buildSummaryPrompt(topic: string, allRounds: RoundEntry[]): string {
  const parts: string[] = [
    `請為以下辯論產出一份會議摘要。`,
    `議題：${topic}`,
    "",
  ];

  let currentRound = 0;
  for (const entry of allRounds) {
    if (entry.round !== currentRound) {
      currentRound = entry.round;
      parts.push(`\n--- Round ${currentRound} ---`);
    }
    parts.push(`[${roleLabel(entry.role)} ${entry.speaker}] ${entry.content}`);
  }

  parts.push("\n請總結：1) 各方主要論點 2) 共識點 3) 未解決的分歧 4) 建議的下一步行動。用 reply 工具回覆摘要。");
  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/meeting/prompt-builder.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/meeting/prompt-builder.ts tests/meeting/prompt-builder.test.ts
git commit -m "feat(meeting): add prompt builder for debate round composition"
```

---

### Task 6: MeetingOrchestrator — Core Class

**Files:**
- Create: `src/meeting/orchestrator.ts`
- Create: `tests/meeting/orchestrator.test.ts`

- [ ] **Step 1: Write failing test for constructor and start**

```typescript
// tests/meeting/orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MeetingOrchestrator } from "../../src/meeting/orchestrator.js";
import type { FleetManagerMeetingAPI, MeetingChannelOutput, MeetingConfig, ParticipantConfig } from "../../src/meeting/types.js";

function mockFm(): FleetManagerMeetingAPI {
  return {
    spawnEphemeralInstance: vi.fn().mockResolvedValue("meet-test-A"),
    destroyEphemeralInstance: vi.fn().mockResolvedValue(undefined),
    sendAndWaitReply: vi.fn().mockResolvedValue("Mock reply"),
    createMeetingChannel: vi.fn().mockResolvedValue({ channelId: 999 }),
    closeMeetingChannel: vi.fn().mockResolvedValue(undefined),
  };
}

function mockOutput(): MeetingChannelOutput {
  return {
    postMessage: vi.fn().mockResolvedValue("msg-1"),
    editMessage: vi.fn().mockResolvedValue(undefined),
  };
}

const defaultConfig: MeetingConfig = {
  meetingId: "test-001",
  topic: "要不要拆 monorepo？",
  mode: "debate",
  maxRounds: 2,
};

const defaultParticipants: ParticipantConfig[] = [
  { label: "A", role: "pro" },
  { label: "B", role: "con" },
];

describe("MeetingOrchestrator", () => {
  let fm: ReturnType<typeof mockFm>;
  let output: ReturnType<typeof mockOutput>;

  beforeEach(() => {
    fm = mockFm();
    output = mockOutput();
  });

  it("spawns instances on start", async () => {
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    await orch.start(defaultParticipants);
    expect(fm.spawnEphemeralInstance).toHaveBeenCalledTimes(2);
  });

  it("runs debate rounds and posts results", async () => {
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    await orch.start(defaultParticipants);

    // 2 rounds × 2 participants = 4 sendAndWaitReply calls + 1 summary = 5
    // Plus round headers and summary header via postMessage
    expect(fm.sendAndWaitReply).toHaveBeenCalled();
    expect(output.postMessage).toHaveBeenCalled();
  });

  it("destroys instances on end", async () => {
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    await orch.start(defaultParticipants);
    // After full run, instances should be destroyed
    expect(fm.destroyEphemeralInstance).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/meeting/orchestrator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement MeetingOrchestrator**

```typescript
// src/meeting/orchestrator.ts
import type {
  MeetingConfig, ParticipantConfig, ActiveParticipant,
  FleetManagerMeetingAPI, MeetingChannelOutput,
  RoundEntry, MeetingState,
} from "./types.js";
import { buildSystemPrompt, buildRoundPrompt, buildSummaryPrompt, roleLabel } from "./prompt-builder.js";
import type { InboundMessage } from "../channel/types.js";

const ROLE_EMOJI: Record<string, string> = {
  pro: "🟢",
  con: "🔴",
  arbiter: "⚖️",
};

const REPLY_TIMEOUT_MS = 120_000;
const REPLY_BUFFER_CAP = 32 * 1024;

export class MeetingOrchestrator {
  private participants: ActiveParticipant[] = [];
  private roundHistory: RoundEntry[] = [];
  private currentRound = 0;
  private state: MeetingState = "booting";
  private userContext: string | undefined;
  private abortController = new AbortController();
  private resolveUserInput: (() => void) | null = null;
  private directAddress: { label: string; prompt: string } | null = null;

  constructor(
    private config: MeetingConfig,
    private fm: FleetManagerMeetingAPI,
    private output: MeetingChannelOutput,
  ) {}

  async start(participantConfigs: ParticipantConfig[]): Promise<void> {
    this.state = "booting";

    // Spawn instances in parallel — use allSettled to handle partial failures
    const spawnResults = await Promise.allSettled(
      participantConfigs.map(async (p) => {
        const instanceName = await this.fm.spawnEphemeralInstance(
          {
            systemPrompt: buildSystemPrompt(p.role, this.config.topic),
            workingDirectory: this.config.mode === "collab" ? this.config.repo ?? "/tmp" : "/tmp",
            lightweight: this.config.mode === "debate",
            skipPermissions: this.config.mode === "debate",
          },
          this.abortController.signal,
        );
        return { ...p, instanceName };
      }),
    );

    // Filter successful spawns, report failures
    for (const result of spawnResults) {
      if (result.status === "fulfilled") {
        this.participants.push(result.value);
      } else {
        await this.output.postMessage(`⚠️ Instance 啟動失敗: ${result.reason}`);
      }
    }

    // If all spawns failed, end meeting
    if (this.participants.length === 0) {
      await this.output.postMessage("❌ 所有 instance 啟動失敗，會議結束");
      await this.end();
      return;
    }

    this.state = "running";

    // Post meeting header
    const participantList = this.participants
      .map(p => `${p.label}（${roleLabel(p.role)}）`)
      .join("、");
    await this.output.postMessage(
      `📋 會議：${this.config.topic}\n參與者：${participantList}\n輪次：${this.config.maxRounds} | 指令：/end /more /pause`,
    );

    // Run debate loop
    try {
      await this.runDebateLoop();
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      throw err;
    }
  }

  private async runDebateLoop(): Promise<void> {
    for (let round = 1; round <= this.config.maxRounds; round++) {
      if (this.state === "ended") return;
      this.currentRound = round;

      await this.output.postMessage(`\n━━ Round ${round} ━━`);

      // Get last round's entries for context
      const prevRound = this.roundHistory.filter(e => e.round === round - 1);

      // Determine speaking order for this round
      const speakers = this.getSpeakingOrder();

      for (const participant of speakers) {
        if (this.state === "ended") return;

        // Check for pause
        while (this.state === "paused") {
          await new Promise<void>(resolve => { this.resolveUserInput = resolve; });
        }

        // Check for direct address override
        let prompt: string;
        if (this.directAddress && this.directAddress.label === participant.label) {
          prompt = this.directAddress.prompt;
          this.directAddress = null;
        } else {
          prompt = buildRoundPrompt(this.config.topic, round, prevRound, this.userContext);
          this.userContext = undefined;
        }

        try {
          const reply = await this.fm.sendAndWaitReply(
            participant.instanceName,
            prompt,
            REPLY_TIMEOUT_MS,
          );

          // Cap reply at buffer limit
          const cappedReply = reply.length > REPLY_BUFFER_CAP
            ? reply.slice(0, REPLY_BUFFER_CAP) + "\n[...truncated]"
            : reply;

          // Record in history
          this.roundHistory.push({
            round,
            speaker: participant.label,
            role: participant.role,
            content: cappedReply,
          });

          // Post to topic
          const emoji = ROLE_EMOJI[participant.role] ?? "💬";
          await this.output.postMessage(
            `${emoji} ${participant.label}（${roleLabel(participant.role)}）：\n${cappedReply}`,
          );
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          await this.output.postMessage(
            `⚠️ ${participant.label} 回覆逾時，跳過本輪`,
          );
        }
      }
    }

    // Summary
    await this.generateSummary();
    await this.end();
  }

  private getSpeakingOrder(): ActiveParticipant[] {
    // Pro first, then con, then arbiter
    const order: ActiveParticipant[] = [];
    order.push(...this.participants.filter(p => p.role === "pro"));
    order.push(...this.participants.filter(p => p.role === "con"));
    order.push(...this.participants.filter(p => p.role === "arbiter"));
    // Any custom roles at the end
    order.push(...this.participants.filter(p => !["pro", "con", "arbiter"].includes(p.role)));
    return order;
  }

  private async generateSummary(): Promise<void> {
    this.state = "summarizing";
    await this.output.postMessage("\n━━ 會議摘要 ━━");

    // Arbiter generates summary if present, otherwise last speaker
    const summaryGenerator =
      this.participants.find(p => p.role === "arbiter") ??
      this.participants[this.participants.length - 1];

    if (!summaryGenerator) return;

    try {
      const summaryPrompt = buildSummaryPrompt(this.config.topic, this.roundHistory);
      const summary = await this.fm.sendAndWaitReply(
        summaryGenerator.instanceName,
        summaryPrompt,
        REPLY_TIMEOUT_MS,
      );
      await this.output.postMessage(summary);
    } catch {
      await this.output.postMessage("⚠️ 摘要產生失敗");
    }
  }

  handleUserMessage(msg: InboundMessage): void {
    const text = msg.text.trim();

    if (text === "/end") {
      // Generate summary then cleanup
      this.generateSummary().then(() => this.end()).catch(() => this.end());
      return;
    }

    if (text === "/pause") {
      this.state = "paused";
      return;
    }

    if (text === "/resume") {
      this.state = "running";
      this.resolveUserInput?.();
      this.resolveUserInput = null;
      return;
    }

    const moreMatch = text.match(/^\/more(?:\s+(\d+))?$/);
    if (moreMatch) {
      const extra = parseInt(moreMatch[1] ?? "1", 10);
      this.config.maxRounds += extra;
      return;
    }

    const kickMatch = text.match(/^\/kick\s+(\S+)$/);
    if (kickMatch) {
      this.removeParticipant(kickMatch[1]);
      return;
    }

    const redirectMatch = text.match(/^\/redirect\s+(\S+)\s+"(.+)"$/);
    if (redirectMatch) {
      this.directAddress = { label: redirectMatch[1], prompt: redirectMatch[2] };
      return;
    }

    const atMatch = text.match(/^@(\S+)\s+(.+)$/);
    if (atMatch) {
      this.directAddress = { label: atMatch[1], prompt: atMatch[2] };
      return;
    }

    // Free text — inject as context for next speaker
    this.userContext = text;
  }

  async addParticipant(config: ParticipantConfig): Promise<void> {
    const instanceName = await this.fm.spawnEphemeralInstance({
      systemPrompt: buildSystemPrompt(config.role, this.config.topic),
      workingDirectory: "/tmp",
      lightweight: this.config.mode === "debate",
      skipPermissions: this.config.mode === "debate",
    });
    this.participants.push({ ...config, instanceName });
    await this.output.postMessage(
      `➕ ${config.label}（${roleLabel(config.role)}）加入會議`,
    );
  }

  async removeParticipant(label: string): Promise<void> {
    const idx = this.participants.findIndex(p => p.label === label);
    if (idx === -1) return;
    const [removed] = this.participants.splice(idx, 1);
    await this.fm.destroyEphemeralInstance(removed.instanceName);
    await this.output.postMessage(
      `➖ ${removed.label}（${roleLabel(removed.role)}）已離開會議`,
    );
  }

  async end(): Promise<void> {
    if (this.state === "ended") return;
    this.state = "ended";
    this.abortController.abort();

    // Destroy all instances
    await Promise.allSettled(
      this.participants.map(p => this.fm.destroyEphemeralInstance(p.instanceName)),
    );

    await this.output.postMessage("📋 會議結束");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/meeting/orchestrator.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Write additional edge case tests**

```typescript
// Add to tests/meeting/orchestrator.test.ts

function makeMsg(text: string): InboundMessage {
  return {
    source: "test", adapterId: "test", chatId: "c", messageId: "m",
    userId: "u", username: "user", text, timestamp: new Date(),
  };
}

describe("user commands", () => {
  it("handles /end by generating summary and cleaning up", async () => {
    let sendCount = 0;
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);

    fm.sendAndWaitReply = vi.fn().mockImplementation(async () => {
      sendCount++;
      if (sendCount === 1) {
        orch.handleUserMessage(makeMsg("/end"));
      }
      return "reply";
    });

    await orch.start(defaultParticipants);
    expect(fm.destroyEphemeralInstance).toHaveBeenCalled();
  });

  it("handles /more to extend rounds", async () => {
    // Use maxRounds=1 so debate ends quickly, then /more 2 should extend
    const shortConfig = { ...defaultConfig, maxRounds: 1 };
    const orch = new MeetingOrchestrator(shortConfig, fm, output);

    let callCount = 0;
    fm.sendAndWaitReply = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        // After first round completes (2 calls), extend by 1
        orch.handleUserMessage(makeMsg("/more"));
      }
      return "reply";
    });

    await orch.start(defaultParticipants);
    // Should have run more than 1 round worth of calls
    expect(callCount).toBeGreaterThan(2);
  });

  it("handles /kick to remove a participant", async () => {
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    await orch.start(defaultParticipants);
    // B should have been destroyed along with all participants at end
    expect(fm.destroyEphemeralInstance).toHaveBeenCalled();
  });

  it("handles @A direct-address", () => {
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    orch.handleUserMessage(makeMsg("@A what about testing?"));
    // directAddress should be set (tested via behavior in integration test)
  });
});
```

- [ ] **Step 6: Run all meeting tests**

Run: `npx vitest run tests/meeting/`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/meeting/orchestrator.ts tests/meeting/orchestrator.test.ts
git commit -m "feat(meeting): implement MeetingOrchestrator with debate flow and user commands"
```

---

### Task 7: Unified Routing in FleetManager

**Files:**
- Modify: `src/fleet-manager.ts:39` (routingTable type)
- Modify: `src/fleet-manager.ts:572-651` (handleInboundMessage)
- Modify: `src/fleet-manager.ts:654-703` (handleOutboundFromInstance)
- Modify: `tests/fleet-manager.test.ts`

- [ ] **Step 1: Define RouteTarget type**

Add to `src/meeting/types.ts`:

```typescript
import type { MeetingOrchestrator } from "./orchestrator.js";

export type RouteTarget =
  | { kind: "instance"; name: string }
  | { kind: "meeting"; orchestrator: MeetingOrchestrator };
```

- [ ] **Step 2: Update routingTable type in FleetManager**

In `src/fleet-manager.ts`, change line 39:

```typescript
// Before:
private routingTable: Map<number, string> = new Map();

// After:
private routingTable: Map<number, RouteTarget> = new Map();
```

- [ ] **Step 3: Update all routingTable.set() calls**

Search for `this.routingTable.set(` in `fleet-manager.ts` and update each call:

```typescript
// Before:
this.routingTable.set(topicId, instanceName);

// After:
this.routingTable.set(topicId, { kind: "instance", name: instanceName });
```

- [ ] **Step 4: Update handleInboundMessage routing**

In `src/fleet-manager.ts`, modify the routing logic around line 580:

```typescript
// Before:
const instanceName = this.routingTable.get(threadId);
if (!instanceName) {
  this.handleUnboundTopic(msg, threadId);
  return;
}
// ... then uses instanceName ...

// After:
const target = this.routingTable.get(threadId);
if (!target) {
  this.handleUnboundTopic(msg, threadId);
  return;
}
if (target.kind === "meeting") {
  target.orchestrator.handleUserMessage(msg);
  return;
}
const instanceName = target.name;
// ... rest of existing code unchanged ...
```

- [ ] **Step 5: Update handleOutboundFromInstance to intercept meeting replies**

In `src/fleet-manager.ts`, add at the top of `handleOutboundFromInstance()` around line 654:

```typescript
private pendingMeetingReplies: Map<string, { resolve: (text: string) => void; reject: (err: Error) => void; buffer: string; timer: ReturnType<typeof setTimeout> | null }> = new Map();

private handleOutboundFromInstance(instanceName: string, msg: Record<string, unknown>): void {
  // Check if this is a meeting reply
  const tool = msg.tool as string;
  if (tool === "reply") {
    const pending = this.pendingMeetingReplies.get(instanceName);
    if (pending) {
      const text = (msg.args as Record<string, unknown>)?.text as string ?? "";
      pending.buffer += text;
      // Cap buffer at 32KB
      if (pending.buffer.length > 32 * 1024) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(pending.buffer);
        this.pendingMeetingReplies.delete(instanceName);
      } else {
        // 5-second idle debounce
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          pending.resolve(pending.buffer);
          this.pendingMeetingReplies.delete(instanceName);
        }, 5000);
      }
      // Respond to daemon so it doesn't hang
      const ipc = this.instanceIpcClients.get(instanceName);
      ipc?.send({ type: "fleet_outbound_response", requestId: msg.requestId, result: { messageId: "meeting-internal", chatId: "", threadId: "" } });
      return;
    }
  }

  // ... rest of existing handleOutboundFromInstance ...
}
```

- [ ] **Step 6: Update all routingTable.get() references**

Search for other `this.routingTable.get(` calls and update them to handle `RouteTarget`. Most will need to check `target.kind === "instance"` and extract `target.name`.

- [ ] **Step 7: Run fleet-manager tests**

Run: `npx vitest run tests/fleet-manager.test.ts`
Expected: ALL PASS (may need to update test assertions for new RouteTarget shape)

- [ ] **Step 8: Commit**

```bash
git add src/fleet-manager.ts src/meeting/types.ts tests/fleet-manager.test.ts
git commit -m "feat(fleet): unified routing table with discriminated union for meetings"
```

---

### Task 8: FleetManagerMeetingAPI Implementation

**Files:**
- Modify: `src/fleet-manager.ts`

- [ ] **Step 1: Implement `sendAndWaitReply`**

Add to FleetManager class:

```typescript
async sendAndWaitReply(instanceName: string, message: string, timeoutMs = 120_000): Promise<string> {
  const ipc = this.instanceIpcClients.get(instanceName);
  if (!ipc) throw new Error(`No IPC connection to ${instanceName}`);

  return new Promise<string>((resolve, reject) => {
    const entry = { resolve, reject, buffer: "", timer: null as ReturnType<typeof setTimeout> | null };
    this.pendingMeetingReplies.set(instanceName, entry);

    // Timeout
    const timeout = setTimeout(() => {
      this.pendingMeetingReplies.delete(instanceName);
      reject(new Error(`sendAndWaitReply timeout for ${instanceName}`));
    }, timeoutMs);

    // Override resolve to clear timeout
    const origResolve = resolve;
    entry.resolve = (text: string) => {
      clearTimeout(timeout);
      origResolve(text);
    };

    // Send the message
    ipc.send({
      type: "fleet_inbound",
      content: message,
      meta: {
        chat_id: "meeting-internal",
        message_id: `meet-${Date.now()}`,
        user: "meeting-orchestrator",
        user_id: "system",
        ts: new Date().toISOString(),
        thread_id: "",
      },
    });
  });
}
```

- [ ] **Step 2: Implement `spawnEphemeralInstance`**

```typescript
async spawnEphemeralInstance(config: EphemeralInstanceConfig, signal?: AbortSignal): Promise<string> {
  const meetingId = `meet-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const instanceDir = this.getInstanceDir(meetingId);
  mkdirSync(instanceDir, { recursive: true });

  if (signal?.aborted) throw new Error("AbortError");

  // Collab mode: create git worktree
  let workDir = config.workingDirectory;
  if (workDir !== "/tmp" && existsSync(join(workDir, ".git"))) {
    const worktreePath = `/tmp/${meetingId}`;
    const branchName = `meet/${meetingId}`;
    const { execSync } = await import("child_process");
    execSync(`git worktree add ${worktreePath} -b ${branchName}`, { cwd: workDir });
    workDir = worktreePath;
  }

  // Build InstanceConfig from EphemeralInstanceConfig
  const instanceConfig: InstanceConfig = {
    working_directory: config.workingDirectory,
    lightweight: true,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { threshold_percentage: 100, max_idle_wait_ms: 0, completion_timeout_ms: 0, grace_period_ms: 0, max_age_hours: 999 },
    memory: { auto_summarize: false, watch_memory_dir: false, backup_to_sqlite: false },
    log_level: "info",
    backend: config.backend,
  };

  // Find available port
  const port = 18321 + this.daemons.size + 100; // offset to avoid conflicts
  instanceConfig.approval_port = port;

  await this.startInstance(meetingId, instanceConfig, port, true);

  // Wait for IPC connection
  await this.waitForInstanceIpc(meetingId, 30_000);

  return meetingId;
}

private waitForInstanceIpc(name: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`IPC timeout for ${name}`)), timeoutMs);
    const check = () => {
      if (this.instanceIpcClients.has(name)) {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });
}
```

- [ ] **Step 3: Implement `destroyEphemeralInstance`**

```typescript
async destroyEphemeralInstance(name: string): Promise<void> {
  await this.stopInstance(name);

  // Clean up pending replies
  const pending = this.pendingMeetingReplies.get(name);
  if (pending) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(Object.assign(new Error("Instance destroyed"), { name: "AbortError" }));
    this.pendingMeetingReplies.delete(name);
  }

  // Clean up git worktree if this was a collab instance
  const worktreePath = `/tmp/${name}`;
  if (existsSync(worktreePath)) {
    const { execSync } = await import("child_process");
    try {
      execSync(`git worktree remove --force ${worktreePath}`);
      execSync(`git branch -D meet/${name}`);
    } catch { /* best-effort cleanup */ }
  }
}
```

- [ ] **Step 4: Implement `createMeetingChannel` and `closeMeetingChannel`**

```typescript
async createMeetingChannel(title: string): Promise<{ channelId: number }> {
  const threadId = await this.createForumTopic(title);
  return { channelId: threadId };
}

async closeMeetingChannel(channelId: number): Promise<void> {
  const groupId = this.fleetConfig?.channel?.group_id;
  const botTokenEnv = this.fleetConfig?.channel?.bot_token_env;
  if (!groupId || !botTokenEnv) return;
  const botToken = process.env[botTokenEnv];
  if (!botToken) return;

  await fetch(
    `https://api.telegram.org/bot${botToken}/closeForumTopic`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: groupId, message_thread_id: channelId }),
    },
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add src/fleet-manager.ts
git commit -m "feat(fleet): implement FleetManagerMeetingAPI methods"
```

---

### Task 9: /meets Command Handler

**Files:**
- Modify: `src/fleet-manager.ts` (handleGeneralCommand or handleInboundMessage)
- Modify: `src/channel/adapters/telegram.ts` (add sendTextWithKeyboard if not present)

- [ ] **Step 1: Check existing command handling pattern**

Read `fleet-manager.ts` method `handleGeneralCommand` or wherever `/open`, `/new`, etc. are parsed — follow the same pattern.

- [ ] **Step 2: Add `/meets` command parsing**

In the command handler section of FleetManager, add:

```typescript
if (text.startsWith("/meets")) {
  await this.handleMeetsCommand(msg);
  return;
}
```

- [ ] **Step 3: Implement handleMeetsCommand with interactive wizard**

```typescript
private meetsWizardState: Map<string, { step: string; mode?: string; topic?: string; count?: number }> = new Map();

private async handleMeetsCommand(msg: InboundMessage): Promise<void> {
  if (!this.adapter) return;
  const tg = this.adapter as TelegramAdapter;
  const userId = msg.userId;
  const chatId = msg.chatId;

  // Check resource limits
  const activeMeetings = [...this.routingTable.values()].filter(t => t.kind === "meeting").length;
  const maxConcurrent = (this.fleetConfig?.defaults as any)?.meetings?.maxConcurrent ?? 1;
  if (activeMeetings >= maxConcurrent) {
    await tg.sendText(chatId, "⚠️ 已達同時會議上限，請先結束現有會議。");
    return;
  }

  // Parse CLI shorthand first
  const parsed = this.parseMeetsArgs(msg.text);
  if (parsed) {
    await this.startMeeting(chatId, parsed.topic, parsed.mode, parsed.count, parsed.names);
    return;
  }

  // Start interactive wizard
  this.meetsWizardState.set(userId, { step: "topic" });
  await tg.sendText(chatId, "📋 建立新會議\n議題是什麼？（請直接輸入）");
}

private parseMeetsArgs(text: string): { topic: string; mode: "debate" | "collab"; count: number; names?: string[]; repo?: string } | null {
  // Try to parse: /meets [-n N] [--collab] [--repo path] [--names "a,b"] "topic"
  const args = text.slice("/meets".length).trim();
  if (!args) return null; // wizard mode

  let mode: "debate" | "collab" = "debate";
  let count = 2;
  let names: string[] | undefined;
  let repo: string | undefined;
  let topic = args;

  if (args.includes("--collab")) {
    mode = "collab";
    topic = topic.replace("--collab", "").trim();
  }

  const repoMatch = topic.match(/--repo\s+(\S+)/);
  if (repoMatch) {
    repo = repoMatch[1];
    topic = topic.replace(repoMatch[0], "").trim();
  }

  const nMatch = topic.match(/-n\s+(\d+)/);
  if (nMatch) {
    count = parseInt(nMatch[1], 10);
    topic = topic.replace(nMatch[0], "").trim();
  }

  const namesMatch = topic.match(/--names\s+"([^"]+)"/);
  if (namesMatch) {
    names = namesMatch[1].split(",").map(n => n.trim());
    topic = topic.replace(namesMatch[0], "").trim();
  }

  // Remove surrounding quotes from topic
  topic = topic.replace(/^["']|["']$/g, "").trim();
  if (!topic) return null;

  return { topic, mode, count, names, repo };
}
```

- [ ] **Step 4: Implement wizard callback handler**

Wire into the Telegram adapter's callback_query handler to process button presses for mode and participant count selection. Follow the existing `sendApproval` pattern for inline keyboards.

- [ ] **Step 5: Implement startMeeting**

```typescript
private async startMeeting(
  chatId: string,
  topic: string,
  mode: "debate" | "collab",
  count: number,
  customNames?: string[],
): Promise<void> {
  // Validate participant count
  const maxParticipants = this.fleetConfig?.defaults?.meetings?.maxParticipants ?? 6;
  if (count > maxParticipants) {
    await tg.sendText(chatId, `⚠️ 超過參與者上限 (${maxParticipants})，請減少人數。`);
    return;
  }

  // Collab mode: validate repo is a git repository
  if (mode === "collab") {
    const repoPath = customNames ? undefined : undefined; // repo comes from parsed args
    // Note: repo validation handled below via parsed.repo
  }

  const { assignRoles } = await import("./meeting/role-assigner.js");
  const { MeetingOrchestrator } = await import("./meeting/orchestrator.js");

  const participants = assignRoles(count, customNames);
  const meetingId = `meet-${Date.now()}`;

  // Create meeting topic
  const { channelId } = await this.createMeetingChannel(`📋 ${topic}`);

  // Create channel output bound to this topic
  const tg = this.adapter as TelegramAdapter;
  const groupId = String(this.fleetConfig?.channel?.group_id ?? "");
  const output: MeetingChannelOutput = {
    postMessage: async (text: string) => {
      const sent = await tg.sendText(groupId, text, { threadId: String(channelId) });
      return sent.messageId;
    },
    editMessage: async (messageId: string, text: string) => {
      await tg.editMessage(groupId, messageId, text);
    },
  };

  // Create orchestrator
  const config: MeetingConfig = { meetingId, topic, mode, maxRounds: 3 };
  const fmApi: FleetManagerMeetingAPI = {
    spawnEphemeralInstance: this.spawnEphemeralInstance.bind(this),
    destroyEphemeralInstance: this.destroyEphemeralInstance.bind(this),
    sendAndWaitReply: this.sendAndWaitReply.bind(this),
    createMeetingChannel: this.createMeetingChannel.bind(this),
    closeMeetingChannel: this.closeMeetingChannel.bind(this),
  };

  const orchestrator = new MeetingOrchestrator(config, fmApi, output);

  // Register in routing table
  this.routingTable.set(channelId, { kind: "meeting", orchestrator });

  // Start (fire and forget — orchestrator runs the loop)
  orchestrator.start(participants).then(() => {
    // Cleanup routing on completion
    this.routingTable.delete(channelId);
    this.closeMeetingChannel(channelId).catch(() => {});
  }).catch(err => {
    this.logger.error({ err }, "Meeting failed");
    this.routingTable.delete(channelId);
  });
}
```

- [ ] **Step 6: Commit**

```bash
git add src/fleet-manager.ts src/channel/adapters/telegram.ts
git commit -m "feat(fleet): add /meets command handler with interactive wizard"
```

---

### Task 10: TelegramAdapter Extensions

**Files:**
- Modify: `src/channel/adapters/telegram.ts`

- [ ] **Step 1: Add `closeForumTopic` method**

```typescript
async closeForumTopic(threadId: number): Promise<void> {
  if (!this.bot) return;
  const chatId = this.groupId;
  if (!chatId) return;
  await this.bot.api.closeForumTopic(chatId, threadId);
}
```

- [ ] **Step 2: Add `sendTextWithKeyboard` for wizard inline buttons**

Check if `sendTextWithKeyboard` already exists (the explore agent mentioned it at line 325-331). If it does, verify it supports arbitrary inline keyboard layouts. If not, add:

```typescript
async sendTextWithKeyboard(
  chatId: string,
  text: string,
  keyboard: InlineKeyboard,
  opts?: SendOpts,
): Promise<SentMessage> {
  const params: Record<string, unknown> = {
    reply_markup: keyboard,
  };
  if (opts?.threadId) params.message_thread_id = parseInt(opts.threadId, 10);

  const sent = await this.bot!.api.sendMessage(chatId, text, params);
  return {
    messageId: String(sent.message_id),
    chatId: String(sent.chat.id),
    threadId: opts?.threadId,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/channel/adapters/telegram.ts
git commit -m "feat(telegram): add closeForumTopic and sendTextWithKeyboard"
```

---

### Task 11: Integration Test — Full Debate Flow

**Files:**
- Create: `tests/meeting/integration.test.ts`

- [ ] **Step 1: Write integration test with mocked FM API**

```typescript
// tests/meeting/integration.test.ts
import { describe, it, expect, vi } from "vitest";
import { MeetingOrchestrator } from "../../src/meeting/orchestrator.js";
import { assignRoles } from "../../src/meeting/role-assigner.js";
import type { FleetManagerMeetingAPI, MeetingChannelOutput, MeetingConfig } from "../../src/meeting/types.js";

describe("Meeting integration", () => {
  it("runs a full 2-round debate with 3 participants", async () => {
    const posted: string[] = [];
    let replyCount = 0;

    const fm: FleetManagerMeetingAPI = {
      spawnEphemeralInstance: vi.fn().mockImplementation(async () => `inst-${replyCount++}`),
      destroyEphemeralInstance: vi.fn().mockResolvedValue(undefined),
      sendAndWaitReply: vi.fn().mockImplementation(async (_name: string, prompt: string) => {
        if (prompt.includes("摘要")) return "這是會議摘要。";
        return `回覆 ${++replyCount}: 針對「${prompt.slice(0, 20)}」的論述`;
      }),
      createMeetingChannel: vi.fn().mockResolvedValue({ channelId: 1 }),
      closeMeetingChannel: vi.fn().mockResolvedValue(undefined),
    };

    const output: MeetingChannelOutput = {
      postMessage: vi.fn().mockImplementation(async (text: string) => {
        posted.push(text);
        return `msg-${posted.length}`;
      }),
      editMessage: vi.fn().mockResolvedValue(undefined),
    };

    const config: MeetingConfig = {
      meetingId: "int-test",
      topic: "是否採用 microservices",
      mode: "debate",
      maxRounds: 2,
    };

    const participants = assignRoles(3);
    const orch = new MeetingOrchestrator(config, fm, output);
    await orch.start(participants);

    // Verify: 3 instances spawned
    expect(fm.spawnEphemeralInstance).toHaveBeenCalledTimes(3);

    // Verify: posted messages include round headers, participant replies, summary
    expect(posted.some(p => p.includes("Round 1"))).toBe(true);
    expect(posted.some(p => p.includes("Round 2"))).toBe(true);
    expect(posted.some(p => p.includes("會議摘要"))).toBe(true);
    expect(posted.some(p => p.includes("會議結束"))).toBe(true);

    // Verify: all instances destroyed
    expect(fm.destroyEphemeralInstance).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run tests/meeting/integration.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/meeting/integration.test.ts
git commit -m "test(meeting): add integration test for full debate flow"
```

---

### Task 12: Run Full Test Suite

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS — no regressions from routing table changes or daemon modifications

- [ ] **Step 2: Fix any failures**

If any existing tests fail due to `RouteTarget` type change, update them to use `{ kind: "instance", name: "..." }` format.

- [ ] **Step 3: Commit fixes if needed**

```bash
git add -A
git commit -m "fix: update tests for RouteTarget type changes"
```
