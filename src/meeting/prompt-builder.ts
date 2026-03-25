import type { MeetingRole, RoundEntry } from "./types.js";

const ROLE_LABELS: Record<string, string> = { pro: "正方", con: "反方", arbiter: "仲裁" };

export function roleLabel(role: MeetingRole): string {
  return ROLE_LABELS[role] ?? role;
}

export function buildSystemPrompt(role: MeetingRole, topic: string): string {
  const label = roleLabel(role);
  switch (role) {
    case "pro":
      return `你是這場辯論的「${label}」。議題：「${topic}」。\n\n你必須站在【贊成/支持】的立場。無論你個人怎麼想，你的任務就是為這個提案辯護，找出所有支持它的理由。\n\n重要：你必須跟反方持相反立場。如果反方同意你，那代表你們其中一方搞錯立場了。你要積極反駁反方的論點。\n\n用 reply 工具回覆你的論述。`;
    case "con":
      return `你是這場辯論的「${label}」。議題：「${topic}」。\n\n你必須站在【反對/質疑】的立場。無論你個人怎麼想，你的任務就是反對這個提案，找出所有反對它的理由、風險和問題。\n\n重要：你必須跟正方持相反立場。如果正方支持這個提案，你就必須反對。不要附和正方，要挑戰和反駁他的論點。\n\n用 reply 工具回覆你的論述。`;
    case "arbiter":
      return `你是這場辯論的「${label}」。議題：「${topic}」。你的角色是客觀的仲裁者，分析正反雙方論點的優劣，指出各方的盲點和邏輯漏洞，並提出平衡的結論。\n\n用 reply 工具回覆你的分析。`;
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

export function buildCollabSystemPrompt(label: string, topic: string): string {
  return `你是協作任務的參與者「${label}」。任務：「${topic}」。你在獨立的 git branch 上工作。先討論分工，確認後開始開發。完成後用 reply 工具回報進度。`;
}

export function buildCollabSummaryPrompt(topic: string, allRounds: RoundEntry[]): string {
  const parts: string[] = [`請為以下協作任務產出一份工作摘要。`, `任務：${topic}`, ""];
  for (const entry of allRounds) {
    parts.push(`[${entry.speaker}] ${entry.content}`);
  }
  parts.push("\n請總結：1) 各參與者完成了什麼 2) 未完成的工作 3) 需要注意的衝突或問題。用 reply 工具回覆摘要。");
  return parts.join("\n");
}

export function buildAngleGenerationPrompt(topic: string, count: number): string {
  return `議題：「${topic}」\n\n請為這個議題建議 ${count} 個不同的分析角度。每個角度應該代表一個獨特的切入面向（例如：技術可行性、成本效益、使用者體驗、法規遵循等）。\n\n請用以下格式回覆，每行一個角度，不要編號：\n技術可行性\n成本效益\n...`;
}

export function buildDiscussionSystemPrompt(label: string, angle: string, topic: string): string {
  return `你是這場討論的參與者「${label}」。議題：「${topic}」。\n\n你的分析角度是「${angle}」。請從這個角度出發，提出你的專業分析。你不需要強制支持或反對，而是從你的角度深入分析這個議題的各個面向。\n\n用 reply 工具回覆。`;
}

export function buildIndependentAnalysisPrompt(topic: string, angle: string): string {
  return `請從「${angle}」的角度，獨立分析以下議題：\n\n「${topic}」\n\n這是獨立分析階段，你還沒看到其他人的觀點。請深入分析，提出你的發現、風險和建議。\n\n用 reply 工具回覆你的分析。`;
}

export function buildCrossDiscussionPrompt(topic: string, myAngle: string, allAnalyses: RoundEntry[]): string {
  const parts: string[] = [
    `議題：「${topic}」`,
    `你的角度：「${myAngle}」`,
    `\n以下是所有參與者的獨立分析：\n`,
  ];
  for (const entry of allAnalyses) {
    parts.push(`[${entry.speaker}] ${entry.content}\n`);
  }
  parts.push(`請從你的角度（${myAngle}）回應其他人的分析。你可以同意、補充、或挑戰他們的觀點。重點指出他們可能忽略的面向。\n\n用 reply 工具回覆。`);
  return parts.join("\n");
}

export function buildConsensusPrompt(topic: string, allRounds: RoundEntry[]): string {
  const parts: string[] = [
    `議題：「${topic}」`,
    `\n以下是完整的討論過程：\n`,
  ];
  let currentRound = -1;
  for (const entry of allRounds) {
    if (entry.round !== currentRound) {
      currentRound = entry.round;
      parts.push(currentRound === 0 ? "\n--- 獨立分析 ---" : `\n--- 交叉討論 Round ${currentRound} ---`);
    }
    parts.push(`[${entry.speaker}] ${entry.content}`);
  }
  parts.push(`\n請綜合所有角度的分析和討論，產出一份共識結論：\n1) 各角度的關鍵發現\n2) 共識點\n3) 仍有分歧的面向\n4) 綜合建議與下一步行動\n\n用 reply 工具回覆。`);
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
