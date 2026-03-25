import type { InboundMessage } from "../channel/types.js";

export type MeetingRole = "pro" | "con" | "arbiter" | (string & {});
export type MeetingMode = "debate" | "collab" | "discussion";
export type MeetingState = "booting" | "running" | "paused" | "summarizing" | "ended";

export interface MeetingConfig {
  meetingId: string;
  topic: string;
  mode: MeetingMode;
  maxRounds: number;
  repo?: string;
  angles?: string[];  // discussion mode: analysis angles for each participant
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

export interface ActiveParticipant {
  label: string;
  role: MeetingRole;
  instanceName: string;
}

export interface RoundEntry {
  round: number;
  speaker: string;
  role: MeetingRole;
  content: string;
}

export type RouteTarget =
  | { kind: "instance"; name: string }
  | { kind: "meeting"; orchestrator: unknown }; // Typed as unknown to avoid circular import; cast to MeetingOrchestrator in fleet-manager
