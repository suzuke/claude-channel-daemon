import { EventEmitter } from "node:events";
import { createReadStream, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { Bot, GrammyError, InputFile } from "grammy";
import type { Context, InlineKeyboard as InlineKeyboardType } from "grammy";
import { InlineKeyboard } from "grammy";
import type { ChannelAdapter, ApprovalHandle, SendOpts, SentMessage, PermissionPrompt } from "../types.js";
import type { AccessManager } from "../access-manager.js";
import { MessageQueue } from "../message-queue.js";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

export interface TelegramAdapterOptions {
  id: string;
  botToken: string;
  accessManager: AccessManager;
  inboxDir: string;
}

export class TelegramAdapter extends EventEmitter implements ChannelAdapter {
  readonly type = "telegram";
  readonly id: string;

  private bot: Bot;
  private accessManager: AccessManager;
  private inboxDir: string;
  private queue: MessageQueue;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: TelegramAdapterOptions) {
    super();
    this.id = opts.id;
    this.accessManager = opts.accessManager;
    this.inboxDir = opts.inboxDir;

    mkdirSync(this.inboxDir, { recursive: true });

    this.bot = new Bot(opts.botToken);

    // Build MessageQueue backed by this bot
    this.queue = new MessageQueue({
      send: async (chatId, threadId, text) => {
        const msg = await this.bot.api.sendMessage(Number(chatId), text, {
          message_thread_id: threadId != null ? Number(threadId) : undefined,
        });
        return { messageId: String(msg.message_id) };
      },
      edit: async (chatId, messageId, text) => {
        await this.bot.api.editMessageText(Number(chatId), Number(messageId), text);
      },
      sendFile: async (chatId, threadId, filePath) => {
        const ext = extname(filePath).toLowerCase();
        const filename = basename(filePath);
        if (IMAGE_EXTENSIONS.has(ext)) {
          const msg = await this.bot.api.sendPhoto(
            Number(chatId),
            new InputFile(createReadStream(filePath), filename),
            { message_thread_id: threadId != null ? Number(threadId) : undefined },
          );
          return { messageId: String(msg.message_id) };
        } else {
          const msg = await this.bot.api.sendDocument(
            Number(chatId),
            new InputFile(createReadStream(filePath), filename),
            { message_thread_id: threadId != null ? Number(threadId) : undefined },
          );
          return { messageId: String(msg.message_id) };
        }
      },
    });

    this._registerHandlers();
  }

  private _registerHandlers(): void {
    this.bot.on("message", async (ctx: Context) => {
      const msg = ctx.message;
      if (!msg) return;

      const userId = msg.from?.id;
      if (userId == null) return;

      // Access control
      if (!this.accessManager.isAllowed(userId)) {
        // In pairing mode, allow /pair commands through
        if (msg.text?.startsWith("/pair")) {
          await this._handlePairCommand(ctx);
        }
        return;
      }

      const chatId = String(msg.chat.id);
      const threadId = msg.message_thread_id != null
        ? String(msg.message_thread_id)
        : undefined;
      const messageId = String(msg.message_id);
      const username = msg.from?.username ?? msg.from?.first_name ?? String(userId);
      const text = msg.text ?? msg.caption ?? "";

      // Collect attachments
      const attachments = this._extractAttachments(msg);

      this.emit("message", {
        source: "telegram",
        adapterId: this.id,
        chatId,
        threadId,
        messageId,
        userId: String(userId),
        username,
        text,
        timestamp: new Date(msg.date * 1000),
        attachments: attachments.length > 0 ? attachments : undefined,
        replyTo: msg.reply_to_message?.message_id != null
          ? String(msg.reply_to_message.message_id)
          : undefined,
      });
    });

    // Handle callback queries from approval inline keyboards and directory browser
    this.bot.on("callback_query:data", async (ctx: Context) => {
      if (!ctx.callbackQuery?.data) return;
      await ctx.answerCallbackQuery();
      this.emit("callback_query", {
        callbackData: ctx.callbackQuery.data,
        chatId: String(ctx.callbackQuery.message?.chat.id ?? ""),
        threadId: ctx.callbackQuery.message?.message_thread_id != null
          ? String(ctx.callbackQuery.message.message_thread_id)
          : undefined,
        messageId: String(ctx.callbackQuery.message?.message_id ?? ""),
      });
    });

    // Handle topic closed/deleted events (for auto-unbind)
    this.bot.on("message:forum_topic_closed", (ctx: Context) => {
      const chatId = String(ctx.message?.chat.id ?? "");
      const threadId = ctx.message?.message_thread_id != null
        ? String(ctx.message.message_thread_id)
        : undefined;
      if (threadId) {
        this.emit("topic_closed", { chatId, threadId });
      }
    });
  }

  private _extractAttachments(msg: NonNullable<Context["message"]>): Array<{
    kind: "photo" | "document" | "audio" | "voice" | "video" | "sticker";
    fileId: string;
    mime?: string;
    size?: number;
    filename?: string;
  }> {
    const result = [];

    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      result.push({ kind: "photo" as const, fileId: largest.file_id, size: largest.file_size });
    }
    if (msg.document) {
      result.push({
        kind: "document" as const,
        fileId: msg.document.file_id,
        mime: msg.document.mime_type,
        size: msg.document.file_size,
        filename: msg.document.file_name,
      });
    }
    if (msg.audio) {
      result.push({
        kind: "audio" as const,
        fileId: msg.audio.file_id,
        mime: msg.audio.mime_type,
        size: msg.audio.file_size,
      });
    }
    if (msg.voice) {
      result.push({
        kind: "voice" as const,
        fileId: msg.voice.file_id,
        mime: msg.voice.mime_type,
        size: msg.voice.file_size,
      });
    }
    if (msg.video) {
      result.push({
        kind: "video" as const,
        fileId: msg.video.file_id,
        mime: msg.video.mime_type,
        size: msg.video.file_size,
      });
    }
    if (msg.sticker) {
      result.push({ kind: "sticker" as const, fileId: msg.sticker.file_id });
    }

    return result;
  }

  private async _handlePairCommand(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg || !msg.from) return;
    const userId = String(msg.from.id);
    const chatId = String(msg.chat.id);
    try {
      const code = await this.handlePairing(chatId, userId);
      await ctx.reply(`Your pairing code is: \`${code}\`\nShare it with the daemon owner to get access.`, {
        parse_mode: "Markdown",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Pairing failed: ${message}`);
    }
  }

  // ── ChannelAdapter lifecycle ──────────────────────────────────────────────

  /** Expose bot for fleet manager operations (topic existence checks etc.) */
  getBot(): Bot { return this.bot; }

  async start(): Promise<void> {
    this.queue.start();
    this._pruneInbox();
    this.cleanupTimer = setInterval(() => this._pruneInbox(), 60 * 60 * 1000);

    // Grammy's default error handler calls bot.stop() on any throw — override
    // to keep polling alive on handler errors
    this.bot.catch((err) => {
      this.emit("handler_error", err.error);
    });

    // 409 Conflict = another getUpdates consumer is active (official plugin zombie,
    // or second Claude Code instance). Retry with backoff until the slot frees up.
    // Pattern from official telegram plugin.
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.bot.start({
            drop_pending_updates: attempt === 1,
            onStart: (info) => {
              this.emit("started", info.username);
            },
          });
          return; // bot.stop() was called — clean exit
        } catch (err) {
          if (err instanceof GrammyError && err.error_code === 409) {
            const delay = Math.min(1000 * attempt, 15000);
            this.emit("polling_conflict", { attempt, delay });
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          if (err instanceof Error && err.message === "Aborted delay") return;
          this.emit("error", err);
          return;
        }
      }
    })();
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.queue.stop();
    await this.bot.stop();
  }

  /** Delete inbox files older than 1 hour */
  private _pruneInbox(): void {
    const maxAge = 60 * 60 * 1000;
    const now = Date.now();
    try {
      for (const name of readdirSync(this.inboxDir)) {
        const filePath = join(this.inboxDir, name);
        try {
          const mtime = statSync(filePath).mtimeMs;
          if (now - mtime > maxAge) unlinkSync(filePath);
        } catch { /* ignore per-file errors */ }
      }
    } catch { /* ignore if dir doesn't exist */ }
  }

  // ── Text / file sending ───────────────────────────────────────────────────

  async sendText(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage> {
    return new Promise<SentMessage>((resolve, reject) => {
      // We enqueue and immediately capture the first sent messageId via a one-shot sender
      // For simplicity we use the bot API directly for the first chunk resolution,
      // and delegate subsequent chunks to the queue.
      const threadId = opts?.threadId;
      const chunkLimit = opts?.chunkLimit ?? 4096;

      // Split text manually when caller needs the SentMessage back
      const chunks: string[] = [];
      let offset = 0;
      while (offset < text.length) {
        chunks.push(text.slice(offset, offset + chunkLimit));
        offset += chunkLimit;
      }

      if (chunks.length === 0) {
        reject(new Error("Empty text"));
        return;
      }

      // Send first chunk directly to get the messageId; enqueue the rest
      this.bot.api
        .sendMessage(Number(chatId), chunks[0], {
          message_thread_id: threadId != null ? Number(threadId) : undefined,
        })
        .then((msg) => {
          const result: SentMessage = {
            messageId: String(msg.message_id),
            chatId,
            threadId,
          };
          // Enqueue remaining chunks via the queue
          for (let i = 1; i < chunks.length; i++) {
            this.queue.enqueue(chatId, threadId, { type: "content", text: chunks[i] });
          }
          resolve(result);
        })
        .catch(reject);
    });
  }

  /** Send text with inline keyboard (for directory browser etc.) */
  async sendTextWithKeyboard(chatId: string, text: string, keyboard: InlineKeyboardType, threadId?: string): Promise<SentMessage> {
    const msg = await this.bot.api.sendMessage(Number(chatId), text, {
      message_thread_id: threadId != null ? Number(threadId) : undefined,
      reply_markup: keyboard,
    });
    return { messageId: String(msg.message_id), chatId };
  }

  async sendFile(chatId: string, filePath: string, opts?: SendOpts): Promise<SentMessage> {
    const threadId = opts?.threadId;
    const ext = extname(filePath).toLowerCase();
    const filename = basename(filePath);
    let messageId: string;

    if (IMAGE_EXTENSIONS.has(ext)) {
      const msg = await this.bot.api.sendPhoto(
        Number(chatId),
        new InputFile(createReadStream(filePath), filename),
        { message_thread_id: threadId != null ? Number(threadId) : undefined },
      );
      messageId = String(msg.message_id);
    } else {
      const msg = await this.bot.api.sendDocument(
        Number(chatId),
        new InputFile(createReadStream(filePath), filename),
        { message_thread_id: threadId != null ? Number(threadId) : undefined },
      );
      messageId = String(msg.message_id);
    }

    return { messageId, chatId, threadId };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    await this.bot.api.editMessageText(Number(chatId), Number(messageId), text);
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.bot.api.setMessageReaction(Number(chatId), Number(messageId), [
      { type: "emoji", emoji: emoji as import("grammy/types").ReactionTypeEmoji["emoji"] },
    ]);
  }

  // ── Approval ─────────────────────────────────────────────────────────────

  async sendApproval(
    prompt: PermissionPrompt,
    callback: (decision: "approve" | "deny") => void,
    signal?: AbortSignal,
    threadId?: string,
  ): Promise<ApprovalHandle> {
    const nonce = Math.random().toString(36).slice(2, 10);
    const approveData = `approval:approve:${nonce}`;
    const denyData = `approval:deny:${nonce}`;

    const keyboard = new InlineKeyboard()
      .text("✅ Allow", approveData)
      .text("❌ Deny", denyData);

    // Format the permission message
    let text = `⚠️ *Permission Request*\nTool: \`${prompt.tool_name}\``;
    if (prompt.input_preview) {
      const preview = prompt.input_preview.length > 200
        ? prompt.input_preview.slice(0, 200) + "…"
        : prompt.input_preview;
      text += `\n\`\`\`\n${preview}\n\`\`\``;
    } else if (prompt.description) {
      text += `\n${prompt.description}`;
    }

    const cleanup = () => {
      this.off("callback_query", handler);
    };

    const handler = (query: { callbackData?: string; chatId?: string; messageId?: string }) => {
      if (!query.callbackData) return;
      const isApprove = query.callbackData === approveData;
      const isDeny = query.callbackData === denyData;
      if (!isApprove && !isDeny) return;

      cleanup();
      if (query.chatId && query.messageId) {
        const label = isApprove ? "✅ Allowed" : "❌ Denied";
        this.bot.api.editMessageText(
          Number(query.chatId), Number(query.messageId),
          `${label}\nTool: \`${prompt.tool_name}\``,
        ).catch(() => { /* UI update only */ });
      }
      callback(isApprove ? "approve" : "deny");
    };

    this.on("callback_query", handler);

    if (signal) {
      signal.addEventListener("abort", () => cleanup());
    }

    if (threadId) {
      const chatId = this.getLastChatId();
      if (chatId) {
        await this.bot.api.sendMessage(Number(chatId), text, {
          message_thread_id: Number(threadId),
          reply_markup: keyboard,
          parse_mode: "Markdown",
        }).catch(() => {
          return this.bot.api.sendMessage(Number(chatId), text, {
            message_thread_id: Number(threadId),
            reply_markup: keyboard,
          });
        });
      }
    } else {
      this.emit("approval_request", { prompt: text, keyboard, nonce });
    }

    return { cancel: cleanup };
  }

  /** Get the last known chatId (group ID for topic mode) */
  private lastChatId: string | null = null;
  getLastChatId(): string | null { return this.lastChatId; }
  setLastChatId(chatId: string): void { this.lastChatId = chatId; }

  // ── File download ─────────────────────────────────────────────────────────

  async downloadAttachment(fileId: string): Promise<string> {
    const file = await this.bot.api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) {
      throw new Error(`No file_path returned for fileId: ${fileId}`);
    }

    // Construct the download URL
    const token = (this.bot as unknown as { token: string }).token;
    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;

    const filename = filePath.split("/").pop() ?? fileId;
    const localPath = join(this.inboxDir, filename);

    // Download using fetch
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
    }

    const { createWriteStream } = await import("node:fs");
    const { pipeline } = await import("node:stream/promises");
    const { Readable } = await import("node:stream");

    const dest = createWriteStream(localPath);
    const body = response.body;
    if (!body) throw new Error("No response body");

    await pipeline(Readable.fromWeb(body as import("stream/web").ReadableStream), dest);

    return localPath;
  }

  // ── Pairing ───────────────────────────────────────────────────────────────

  async closeForumTopic(threadId: number): Promise<void> {
    const chatId = this.getLastChatId();
    if (!chatId) return;
    try {
      await this.bot.api.closeForumTopic(Number(chatId), threadId);
    } catch {
      // Best-effort — topic may already be closed
    }
  }

  async handlePairing(chatId: string, userId: string): Promise<string> {
    const code = this.accessManager.generateCode(Number(userId));
    return code;
  }

  async confirmPairing(code: string): Promise<boolean> {
    return this.accessManager.confirmCode(code);
  }
}
