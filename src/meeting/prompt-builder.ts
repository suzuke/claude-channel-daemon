import type { MeetingRole, RoundEntry } from "./types.js";

const ROLE_LABELS: Record<string, string> = { pro: "正方", con: "反方", arbiter: "仲裁" };

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

export function buildRoundPrompt(topic: string, round: number, previousRounds: RoundEntry[], userContext?: string): string {
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
  const parts: string[] = [`請為以下辯論產出一份會議摘要。`, `議題：${topic}`, ""];
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
