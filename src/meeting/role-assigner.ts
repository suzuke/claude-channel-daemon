import type { ParticipantConfig, MeetingRole } from "./types.js";

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function assignRoles(count: number, customNames?: string[]): ParticipantConfig[] {
  if (count < 2) throw new Error("Meeting requires at least 2 participants");

  const labels = customNames ?? LABELS.slice(0, count);
  if (labels.length < count) {
    throw new Error(`Not enough names: need ${count}, got ${labels.length}`);
  }

  const roles: MeetingRole[] = [];
  if (count === 2) {
    roles.push("pro", "con");
  } else {
    const debaters = count - 1;
    const proCount = Math.floor(debaters / 2);
    const conCount = debaters - proCount;
    for (let i = 0; i < proCount; i++) roles.push("pro");
    for (let i = 0; i < conCount; i++) roles.push("con");
    roles.push("arbiter");
  }

  return labels.slice(0, count).map((label, i) => ({ label, role: roles[i] }));
}
