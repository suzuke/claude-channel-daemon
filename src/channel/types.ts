import { EventEmitter } from "node:events";

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
    prompt: string,
    callback: (decision: "approve" | "always_allow" | "deny") => void,
    signal?: AbortSignal,
    threadId?: string,
  ): Promise<ApprovalHandle>;

  downloadAttachment(fileId: string): Promise<string>;

  handlePairing(chatId: string, userId: string): Promise<string>;
  confirmPairing(code: string): Promise<boolean>;
}

export interface ApprovalHandle {
  cancel(): void;
}

export interface SendOpts {
  threadId?: string;
  replyTo?: string;
  format?: "text" | "markdown";
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
  format?: "text" | "markdown";
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

export interface ApprovalResponse {
  decision: "approve" | "always_allow" | "deny";
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
