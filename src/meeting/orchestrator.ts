import type {
  MeetingConfig, ParticipantConfig, ActiveParticipant,
  FleetManagerMeetingAPI, MeetingChannelOutput,
  RoundEntry, MeetingState,
} from "./types.js";
import { buildSystemPrompt, buildRoundPrompt, buildSummaryPrompt, buildCollabSystemPrompt, buildCollabSummaryPrompt, buildDiscussionSystemPrompt, buildIndependentAnalysisPrompt, buildCrossDiscussionPrompt, buildConsensusPrompt, roleLabel } from "./prompt-builder.js";
import type { InboundMessage } from "../channel/types.js";

const ROLE_EMOJI: Record<string, string> = { pro: "🟢", con: "🔴", arbiter: "⚖️" };
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

  /** Cancellation signal — the single source of truth for "should we stop?" */
  private get cancelled(): boolean { return this.abortController.signal.aborted; }

  constructor(
    private config: MeetingConfig,
    private fm: FleetManagerMeetingAPI,
    private output: MeetingChannelOutput,
  ) {}

  async start(participantConfigs: ParticipantConfig[]): Promise<void> {
    this.state = "booting";

    // Spawn instances sequentially to avoid port/IPC race conditions
    for (let i = 0; i < participantConfigs.length; i++) {
      const p = participantConfigs[i];
      try {
        const systemPrompt = this.config.mode === "collab"
          ? buildCollabSystemPrompt(p.label, this.config.topic)
          : this.config.mode === "discussion"
          ? buildDiscussionSystemPrompt(p.label, this.config.angles?.[i] ?? "general", this.config.topic)
          : buildSystemPrompt(p.role, this.config.topic);
        const instanceName = await this.fm.spawnEphemeralInstance(
          {
            systemPrompt,
            workingDirectory: this.config.mode === "collab" ? this.config.repo ?? "/tmp" : "/tmp",
            lightweight: this.config.mode === "debate" || this.config.mode === "discussion",
            skipPermissions: this.config.mode === "debate" || this.config.mode === "discussion",
          },
          this.abortController.signal,
        );
        this.participants.push({ ...p, instanceName });
      } catch (err) {
        await this.output.postMessage(`⚠️ Instance 啟動失敗: ${err}`);
      }
    }

    if (this.participants.length === 0) {
      await this.output.postMessage("❌ 所有 instance 啟動失敗，會議結束");
      await this.end();
      return;
    }

    this.state = "running";

    const participantList = this.config.mode === "discussion"
      ? this.participants.map((p, i) => `${p.label}（${this.config.angles?.[i] ?? "general"}）`).join("、")
      : this.participants.map(p => `${p.label}（${roleLabel(p.role)}）`).join("、");
    const modeLabel = this.config.mode === "discussion" ? "討論" : this.config.mode === "collab" ? "協作" : "辯論";
    await this.output.postMessage(
      `📋 ${modeLabel}：${this.config.topic}\n參與者：${participantList}\n輪次：${this.config.maxRounds} | 指令：/end /more /pause`,
    );

    try {
      if (this.config.mode === "collab") {
        await this.runCollabFlow();
      } else if (this.config.mode === "discussion") {
        await this.runDiscussionFlow();
      } else {
        await this.runDebateLoop();
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      throw err;
    }
  }

  private async runCollabFlow(): Promise<void> {
    // Phase 1: Discussion — each participant proposes their work plan
    await this.output.postMessage("\n━━ 討論分工 ━━");

    for (const participant of this.participants) {
      if (this.cancelled) return;

      while (this.state === "paused") {
        await new Promise<void>(resolve => { this.resolveUserInput = resolve; });
      }
      if (this.cancelled) return;

      try {
        const prompt = `任務：${this.config.topic}\n\n團隊成員：${this.participants.map(p => p.label).join("、")}\n你是 ${participant.label}。請提出你的分工建議，說明你打算負責哪個部分。用 reply 工具回覆。`;
        const reply = await this.fm.sendAndWaitReply(participant.instanceName, prompt, REPLY_TIMEOUT_MS);

        const cappedReply = reply.length > REPLY_BUFFER_CAP
          ? reply.slice(0, REPLY_BUFFER_CAP) + "\n[...truncated]"
          : reply;

        this.roundHistory.push({
          round: 0, speaker: participant.label, role: participant.role, content: cappedReply,
        });

        await this.output.postMessage(`💬 ${participant.label}：\n${cappedReply}`);
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        await this.output.postMessage(`⚠️ ${participant.label} 回覆逾時`);
      }
    }

    // Phase 2: Development — tell each participant to start working
    await this.output.postMessage("\n━━ 開始開發 ━━");

    // Collect all plans for context
    const allPlans = this.roundHistory
      .filter(e => e.round === 0)
      .map(e => `[${e.speaker}] ${e.content}`)
      .join("\n\n");

    // Send development instruction to all participants in parallel
    const devPromises = this.participants.map(async (participant) => {
      if (this.cancelled) return;
      try {
        const prompt = `以下是所有人的分工計劃：\n\n${allPlans}\n\n請開始你負責的部分。完成後用 reply 工具回報你做了什麼（包含修改了哪些檔案、實作了什麼功能）。`;
        const reply = await this.fm.sendAndWaitReply(participant.instanceName, prompt, 300_000); // 5 min timeout for dev work

        const cappedReply = reply.length > REPLY_BUFFER_CAP
          ? reply.slice(0, REPLY_BUFFER_CAP) + "\n[...truncated]"
          : reply;

        this.roundHistory.push({
          round: 1, speaker: participant.label, role: participant.role, content: cappedReply,
        });

        await this.output.postMessage(`✅ ${participant.label} 完成：\n${cappedReply}`);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        await this.output.postMessage(`⚠️ ${participant.label} 開發逾時或失敗`);
      }
    });

    await Promise.allSettled(devPromises);

    if (this.cancelled) return;

    await this.generateSummary();
    await this.cleanup();
  }

  private async runDiscussionFlow(): Promise<void> {
    const angles = this.config.angles ?? this.participants.map((_, i) => `角度 ${i + 1}`);

    // Phase 1: Independent analysis (parallel)
    await this.output.postMessage("\n━━ 獨立分析 ━━");

    const analysisPromises = this.participants.map(async (participant, i) => {
      if (this.cancelled) return;
      try {
        const prompt = buildIndependentAnalysisPrompt(this.config.topic, angles[i]);
        const reply = await this.fm.sendAndWaitReply(participant.instanceName, prompt, REPLY_TIMEOUT_MS);
        const cappedReply = reply.length > REPLY_BUFFER_CAP ? reply.slice(0, REPLY_BUFFER_CAP) + "\n[...truncated]" : reply;
        this.roundHistory.push({ round: 0, speaker: participant.label, role: angles[i], content: cappedReply });
        await this.output.postMessage(`💬 ${participant.label}（${angles[i]}）：\n${cappedReply}`);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        await this.output.postMessage(`⚠️ ${participant.label} 分析逾時`);
      }
    });
    await Promise.allSettled(analysisPromises);

    if (this.cancelled) return;

    // Phase 2: Cross discussion (sequential rounds)
    const independentAnalyses = this.roundHistory.filter(e => e.round === 0);

    for (let round = 1; round <= this.config.maxRounds; round++) {
      if (this.cancelled) return;
      this.currentRound = round;

      await this.output.postMessage(`\n━━ 交叉討論 Round ${round} ━━`);

      for (let i = 0; i < this.participants.length; i++) {
        const participant = this.participants[i];
        if (this.cancelled) return;

        while (this.state === "paused") {
          await new Promise<void>(resolve => { this.resolveUserInput = resolve; });
        }
        if (this.cancelled) return;

        try {
          const prevRoundEntries = round === 1 ? independentAnalyses : this.roundHistory.filter(e => e.round === round - 1);
          const prompt = buildCrossDiscussionPrompt(this.config.topic, angles[i], prevRoundEntries);
          const reply = await this.fm.sendAndWaitReply(participant.instanceName, prompt, REPLY_TIMEOUT_MS);
          const cappedReply = reply.length > REPLY_BUFFER_CAP ? reply.slice(0, REPLY_BUFFER_CAP) + "\n[...truncated]" : reply;
          this.roundHistory.push({ round, speaker: participant.label, role: angles[i], content: cappedReply });
          await this.output.postMessage(`💬 ${participant.label}（${angles[i]}）：\n${cappedReply}`);
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          await this.output.postMessage(`⚠️ ${participant.label} 回覆逾時`);
        }
      }
    }

    // Phase 3: Consensus
    await this.output.postMessage("\n━━ 收斂結論 ━━");
    const lastParticipant = this.participants[this.participants.length - 1];
    if (lastParticipant) {
      try {
        const prompt = buildConsensusPrompt(this.config.topic, this.roundHistory);
        const reply = await this.fm.sendAndWaitReply(lastParticipant.instanceName, prompt, REPLY_TIMEOUT_MS);
        await this.output.postMessage(reply);
      } catch {
        await this.output.postMessage("⚠️ 結論產生失敗");
      }
    }

    await this.cleanup();
  }

  private async runDebateLoop(): Promise<void> {
    for (let round = 1; round <= this.config.maxRounds; round++) {
      if (this.cancelled) return;
      this.currentRound = round;

      await this.output.postMessage(`\n━━ Round ${round} ━━`);

      const prevRound = this.roundHistory.filter(e => e.round === round - 1);
      const speakers = this.getSpeakingOrder();

      for (const participant of speakers) {
        if (this.cancelled) return;

        while (this.state === "paused") {
          await new Promise<void>(resolve => { this.resolveUserInput = resolve; });
        }
        if (this.cancelled) return;

        let prompt: string;
        if (this.directAddress && this.directAddress.label === participant.label) {
          prompt = this.directAddress.prompt;
          this.directAddress = null;
        } else if (this.directAddress) {
          continue;
        } else {
          prompt = buildRoundPrompt(this.config.topic, round, prevRound, this.userContext);
          this.userContext = undefined;
        }

        try {
          const reply = await this.fm.sendAndWaitReply(
            participant.instanceName, prompt, REPLY_TIMEOUT_MS,
          );

          const cappedReply = reply.length > REPLY_BUFFER_CAP
            ? reply.slice(0, REPLY_BUFFER_CAP) + "\n[...truncated]"
            : reply;

          this.roundHistory.push({
            round, speaker: participant.label, role: participant.role, content: cappedReply,
          });

          const emoji = ROLE_EMOJI[participant.role] ?? "💬";
          await this.output.postMessage(
            `${emoji} ${participant.label}（${roleLabel(participant.role)}）：\n${cappedReply}`,
          );
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          await this.output.postMessage(`⚠️ ${participant.label} 回覆逾時，跳過本輪`);
        }
      }
    }

    await this.generateSummary();
    await this.cleanup();
  }

  private getSpeakingOrder(): ActiveParticipant[] {
    const order: ActiveParticipant[] = [];
    order.push(...this.participants.filter(p => p.role === "pro"));
    order.push(...this.participants.filter(p => p.role === "con"));
    order.push(...this.participants.filter(p => p.role === "arbiter"));
    order.push(...this.participants.filter(p => !["pro", "con", "arbiter"].includes(p.role)));
    return order;
  }

  private async generateSummary(): Promise<void> {
    if (this.cancelled) return;
    this.state = "summarizing";
    await this.output.postMessage("\n━━ 會議摘要 ━━");

    const summaryGenerator =
      this.participants.find(p => p.role === "arbiter") ??
      this.participants[this.participants.length - 1];

    if (!summaryGenerator) return;

    try {
      const summaryPrompt = this.config.mode === "collab"
        ? buildCollabSummaryPrompt(this.config.topic, this.roundHistory)
        : buildSummaryPrompt(this.config.topic, this.roundHistory);
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
      this.state = "ended";
      this.abortController.abort();
      this.generateSummary().then(() => this.cleanup()).catch(() => this.cleanup());
      return;
    }

    if (text === "/pause") { this.state = "paused"; return; }

    if (text === "/resume") {
      this.state = "running";
      this.resolveUserInput?.();
      this.resolveUserInput = null;
      return;
    }

    const moreMatch = text.match(/^\/more(?:\s+(\d+))?$/);
    if (moreMatch) {
      this.config.maxRounds += parseInt(moreMatch[1] ?? "1", 10);
      return;
    }

    const kickMatch = text.match(/^\/kick\s+(\S+)$/);
    if (kickMatch) { this.removeParticipant(kickMatch[1]); return; }

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
    await this.output.postMessage(`➕ ${config.label}（${roleLabel(config.role)}）加入會議`);
  }

  async removeParticipant(label: string): Promise<void> {
    const idx = this.participants.findIndex(p => p.label === label);
    if (idx === -1) return;
    const [removed] = this.participants.splice(idx, 1);
    await this.fm.destroyEphemeralInstance(removed.instanceName);
    await this.output.postMessage(`➖ ${removed.label}（${roleLabel(removed.role)}）已離開會議`);
  }

  async end(): Promise<void> {
    if (this.state !== "ended") {
      await this.generateSummary();
    }
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    this.state = "ended";
    this.abortController.abort();
    await Promise.allSettled(
      this.participants.map(p => this.fm.destroyEphemeralInstance(p.instanceName)),
    );
    await this.output.postMessage("📋 會議結束");
  }

  getState(): MeetingState { return this.state; }
}
