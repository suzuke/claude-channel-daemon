import { EventEmitter } from "node:events";

export interface Choice {
  id: string;
  label: string;
}

export interface InstanceStatusData {
  name: string;
  status: "running" | "stopped" | "crashed" | "paused";
  contextPct: number | null;
  costCents: number;
}

export interface AlertData {
  type: "hang" | "cost_warn" | "cost_limit" | "schedule_deferred" | "rotation";
  instanceName: string;
  message: string;
  choices?: Choice[];
}

export interface ChannelAdapter extends EventEmitter {
  readonly type: string;
  readonly id: string;

  start(): Promise<void>;
  stop(): Promise<void>;

  sendText(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage>;
  sendFile(chatId: string, filePath: string, opts?: SendOpts): Promise<SentMessage>;
  editMessage(chatId: string, messageId: string, text: string): Promise<void>;
  react(chatId: string, messageId: string, emoji: string): Promise<void>;

  sendApproval(
    prompt: PermissionPrompt,
    callback: (decision: "approve" | "approve_always" | "deny") => void,
    signal?: AbortSignal,
    threadId?: string,
  ): Promise<ApprovalHandle>;

  downloadAttachment(fileId: string): Promise<string>;

  handlePairing(chatId: string, userId: string): Promise<string>;
  confirmPairing(code: string, callerUserId?: string): Promise<boolean>;

  readonly topology: "topics" | "channels" | "flat";

  setChatId(chatId: string): void;
  getChatId(): string | null;

  promptUser(chatId: string, text: string, choices: Choice[], opts?: SendOpts): Promise<string>;
  notifyAlert(chatId: string, alert: AlertData, opts?: SendOpts): Promise<SentMessage>;

  createTopic?(name: string): Promise<number | string>;
  deleteTopic?(topicId: number | string): Promise<void>;
  topicExists?(topicId: number | string): Promise<boolean>;
  closeForumTopic?(threadId: number | string): Promise<void>;
  reopenForumTopic?(threadId: number | string): Promise<void>;
  editForumTopic?(threadId: number | string, opts: { name?: string; iconCustomEmojiId?: string }): Promise<void>;
  getTopicIconStickers?(): Promise<{ customEmojiId: string; emoji: string }[]>;
}

export interface ApprovalHandle {
  cancel(): void;
}

export interface SendOpts {
  threadId?: string;
  replyTo?: string;
  format?: "text" | "html";
  chunkLimit?: number;
}

export interface SentMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
}

export interface OutboundMessage {
  text?: string;
  filePath?: string;
  threadId?: string;
  replyTo?: string;
  format?: "text" | "html";
}

export interface InboundMessage {
  source: string;
  adapterId: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  userId: string;
  username: string;
  text: string;
  timestamp: Date;
  attachments?: Attachment[];
  replyTo?: string;
  replyToText?: string;
}

export interface Attachment {
  kind: "photo" | "document" | "audio" | "voice" | "video" | "sticker";
  fileId: string;
  localPath?: string;
  mime?: string;
  size?: number;
  filename?: string;
  transcription?: string;
}

export interface PermissionPrompt {
  tool_name: string;
  description: string;
  input_preview?: string;
}

export interface ApprovalResponse {
  decision: "approve" | "approve_always" | "deny";
  respondedBy?: { channelType: string; userId: string };
  reason?: string;
}

export interface Target {
  adapterId?: string;
  chatId: string;
  threadId?: string;
}

export interface QueuedMessage {
  type: "content" | "status_update" | "status_clear";
  text?: string;
  filePath?: string;
  editMessageId?: string;
}
