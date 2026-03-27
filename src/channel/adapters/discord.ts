import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type TextChannel,
  type Message,
  type Interaction,
  type GuildChannelCreateOptions,
} from "discord.js";
import type {
  ChannelAdapter,
  ApprovalHandle,
  SendOpts,
  SentMessage,
  PermissionPrompt,
  Choice,
  AlertData,
} from "../types.js";
import type { AccessManager } from "../access-manager.js";
import { MessageQueue } from "../message-queue.js";

const DISCORD_MAX_LENGTH = 2000;

export interface DiscordAdapterOptions {
  id: string;
  botToken: string;
  accessManager: AccessManager;
  inboxDir: string;
  guildId: string;
  categoryName?: string;
  generalChannelId?: string;
}

export class DiscordAdapter extends EventEmitter implements ChannelAdapter {
  readonly type = "discord";
  readonly topology = "channels" as const;
  readonly id: string;

  private client: Client;
  private botToken: string;
  private accessManager: AccessManager;
  private inboxDir: string;
  private guildId: string;
  private categoryName: string;
  private generalChannelId?: string;
  private queue: MessageQueue;
  private lastChatId: string | null = null;

  constructor(opts: DiscordAdapterOptions) {
    super();
    this.id = opts.id;
    this.botToken = opts.botToken;
    this.accessManager = opts.accessManager;
    this.inboxDir = opts.inboxDir;
    this.guildId = opts.guildId;
    this.categoryName = opts.categoryName ?? "CCD Agents";
    this.generalChannelId = opts.generalChannelId;

    mkdirSync(this.inboxDir, { recursive: true });

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.queue = new MessageQueue({
      send: async (chatId, threadId, text) => {
        const channel = await this._fetchTextChannel(threadId ?? chatId);
        const msg = await channel.send(text);
        return { messageId: msg.id };
      },
      edit: async (chatId, messageId, text) => {
        const channel = await this._fetchTextChannel(chatId);
        const msg = await channel.messages.fetch(messageId);
        await msg.edit(text);
      },
      sendFile: async (chatId, threadId, filePath) => {
        const channel = await this._fetchTextChannel(threadId ?? chatId);
        const msg = await channel.send({ files: [filePath] });
        return { messageId: msg.id };
      },
    });

    this._registerHandlers();
  }

  private async _fetchTextChannel(channelId: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    return channel as TextChannel;
  }

  private _registerHandlers(): void {
    this.client.on("messageCreate", async (msg: Message) => {
      if (msg.author.bot) return;
      if (msg.guildId !== this.guildId) return;

      const userId = msg.author.id;

      // Access control — Discord snowflake IDs are strings, parseInt for AccessManager
      if (!this.accessManager.isAllowed(Number(userId))) {
        return;
      }

      const chatId = this.guildId;
      const threadId = msg.channelId;
      const messageId = msg.id;
      const username = msg.author.username;
      const text = msg.content;

      // Collect attachments
      const attachments = msg.attachments.map((att) => ({
        kind: "document" as const,
        fileId: att.id,
        mime: att.contentType ?? undefined,
        size: att.size,
        filename: att.name ?? undefined,
      }));

      this.emit("message", {
        source: "discord",
        adapterId: this.id,
        chatId,
        threadId,
        messageId,
        userId,
        username,
        text,
        timestamp: msg.createdAt,
        attachments: attachments.length > 0 ? attachments : undefined,
        replyTo: msg.reference?.messageId ?? undefined,
      });
    });

    // Handle button interactions
    this.client.on("interactionCreate", async (interaction: Interaction) => {
      if (!interaction.isButton()) return;

      await interaction.deferUpdate();

      this.emit("callback_query", {
        callbackData: interaction.customId,
        chatId: this.guildId,
        threadId: interaction.channelId,
        messageId: interaction.message.id,
      });
    });

    // Handle channel deletion (equivalent to topic_closed)
    this.client.on("channelDelete", (channel) => {
      if (!("guildId" in channel)) return;
      if (channel.guildId !== this.guildId) return;
      this.emit("topic_closed", {
        chatId: this.guildId,
        threadId: channel.id,
      });
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.queue.start();

    this.client.once("ready", () => {
      this.emit("started", this.client.user?.username ?? "discord-bot");
    });

    await this.client.login(this.botToken);
  }

  async stop(): Promise<void> {
    this.queue.stop();
    this.client.destroy();
  }

  // ── Text / file sending ────────────────────────────────────────────────

  async sendText(chatId: string, text: string, opts?: SendOpts): Promise<SentMessage> {
    const channelId = opts?.threadId ?? chatId;
    const channel = await this._fetchTextChannel(channelId);
    const chunkLimit = opts?.chunkLimit ?? DISCORD_MAX_LENGTH;

    const chunks = splitText(text, chunkLimit);
    if (chunks.length === 0) throw new Error("Empty text");

    const first = await channel.send(chunks[0]);

    // Enqueue remaining chunks
    for (let i = 1; i < chunks.length; i++) {
      this.queue.enqueue(chatId, opts?.threadId, { type: "content", text: chunks[i] });
    }

    return {
      messageId: first.id,
      chatId,
      threadId: opts?.threadId,
    };
  }

  async sendFile(chatId: string, filePath: string, opts?: SendOpts): Promise<SentMessage> {
    const channelId = opts?.threadId ?? chatId;
    const channel = await this._fetchTextChannel(channelId);
    const msg = await channel.send({ files: [filePath] });
    return { messageId: msg.id, chatId, threadId: opts?.threadId };
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    // chatId is guild ID in channels topology, but messageId is in a channel.
    // We need to find the message. Try all text channels in the guild.
    // Optimization: caller usually provides the channel via sendText return value.
    try {
      // Try the general channel first, then search
      const guild = await this.client.guilds.fetch(this.guildId);
      const channels = guild.channels.cache.filter(
        (c) => c.type === ChannelType.GuildText,
      );
      for (const [, ch] of channels) {
        try {
          const textCh = ch as TextChannel;
          const msg = await textCh.messages.fetch(messageId);
          await msg.edit(text.slice(0, DISCORD_MAX_LENGTH));
          return;
        } catch {
          continue;
        }
      }
      throw new Error(`Message ${messageId} not found in any channel`);
    } catch (err) {
      // Fallback: send a new message if edit fails
      if (this.generalChannelId) {
        const channel = await this._fetchTextChannel(this.generalChannelId);
        await channel.send(text.slice(0, DISCORD_MAX_LENGTH));
      }
    }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const channels = guild.channels.cache.filter(
        (c) => c.type === ChannelType.GuildText,
      );
      for (const [, ch] of channels) {
        try {
          const textCh = ch as TextChannel;
          const msg = await textCh.messages.fetch(messageId);
          await msg.react(emoji);
          return;
        } catch {
          continue;
        }
      }
    } catch {
      // No-op per degradation strategy
    }
  }

  // ── Approval ───────────────────────────────────────────────────────────

  async sendApproval(
    prompt: PermissionPrompt,
    callback: (decision: "approve" | "approve_always" | "deny") => void,
    signal?: AbortSignal,
    threadId?: string,
  ): Promise<ApprovalHandle> {
    const nonce = randomBytes(5).toString("hex");
    const approveData = `approval:approve:${nonce}`;
    const alwaysData = `approval:approve_always:${nonce}`;
    const denyData = `approval:deny:${nonce}`;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(approveData)
        .setLabel("Allow")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(alwaysData)
        .setLabel("Always")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(denyData)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger),
    );

    let text = `⚠️ **Permission Request**\nTool: \`${prompt.tool_name}\``;
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

    const handler = (query: { callbackData?: string; chatId?: string; threadId?: string; messageId?: string }) => {
      if (!query.callbackData) return;
      const isApprove = query.callbackData === approveData;
      const isAlways = query.callbackData === alwaysData;
      const isDeny = query.callbackData === denyData;
      if (!isApprove && !isAlways && !isDeny) return;

      cleanup();

      // Update the message to show the decision
      if (query.threadId && query.messageId) {
        this._fetchTextChannel(query.threadId).then((ch) => {
          ch.messages.fetch(query.messageId!).then((msg) => {
            const label = isDeny ? "❌ Denied" : isAlways ? "✅ Always Allowed" : "✅ Allowed";
            msg.edit({
              content: `${label}\nTool: \`${prompt.tool_name}\``,
              components: [],
            }).catch(() => {});
          }).catch(() => {});
        }).catch(() => {});
      }

      callback(isDeny ? "deny" : isAlways ? "approve_always" : "approve");
    };

    this.on("callback_query", handler);

    if (signal) {
      signal.addEventListener("abort", () => cleanup());
    }

    const channelId = threadId ?? this.generalChannelId;
    if (channelId) {
      const channel = await this._fetchTextChannel(channelId);
      await channel.send({ content: text, components: [row] });
    } else {
      this.emit("approval_request", { prompt: text, components: [row], nonce });
    }

    return { cancel: cleanup };
  }

  // ── Chat ID management ──────────────────────────────────────────────────

  getChatId(): string | null { return this.lastChatId; }
  setChatId(chatId: string): void { this.lastChatId = chatId; }

  // ── File download ──────────────────────────────────────────────────────

  async downloadAttachment(fileId: string): Promise<string> {
    // Discord attachment fileId is the attachment ID. We need to find the URL.
    // Since Discord attachments include URLs directly, we'll search for the message
    // containing this attachment. For MVP, we store the URL in the attachment metadata.
    // Here we try to download via the Discord CDN URL pattern.
    // In practice, the inbound message handler should store the URL.
    throw new Error("downloadAttachment not yet implemented for Discord — use attachment URL directly");
  }

  // ── Intent-oriented methods ──────────────────────────────────────────

  async promptUser(chatId: string, text: string, choices: Choice[], opts?: SendOpts): Promise<string> {
    const channelId = opts?.threadId ?? chatId;
    const channel = await this._fetchTextChannel(channelId);

    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const choice of choices) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(choice.id)
          .setLabel(choice.label.slice(0, 80)) // Discord button label max 80 chars
          .setStyle(ButtonStyle.Primary),
      );
    }

    const msg = await channel.send({ content: text, components: [row] });
    return msg.id;
  }

  async notifyAlert(chatId: string, alert: AlertData, opts?: SendOpts): Promise<SentMessage> {
    if (alert.choices && alert.choices.length > 0) {
      const channelId = opts?.threadId ?? chatId;
      const channel = await this._fetchTextChannel(channelId);

      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const choice of alert.choices) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(choice.id)
            .setLabel(choice.label.slice(0, 80))
            .setStyle(ButtonStyle.Secondary),
        );
      }

      const msg = await channel.send({ content: alert.message, components: [row] });
      return { messageId: msg.id, chatId, threadId: opts?.threadId };
    }
    return this.sendText(chatId, alert.message, opts);
  }

  // ── Topology: create channel ────────────────────────────────────────────

  async createTopic(name: string): Promise<number> {
    const guild = await this.client.guilds.fetch(this.guildId);

    // Find or create the category
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === this.categoryName,
    );

    if (!category) {
      category = await guild.channels.create({
        name: this.categoryName,
        type: ChannelType.GuildCategory,
      });
    }

    const channelOpts: GuildChannelCreateOptions = {
      name,
      type: ChannelType.GuildText,
      parent: category.id,
    };

    const channel = await guild.channels.create(channelOpts);
    return parseInt(channel.id);
  }

  async topicExists(topicId: number): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(String(topicId));
      return channel != null;
    } catch {
      return false;
    }
  }

  // ── Pairing ────────────────────────────────────────────────────────────

  async handlePairing(chatId: string, userId: string): Promise<string> {
    const code = this.accessManager.generateCode(Number(userId));
    return code;
  }

  async confirmPairing(code: string): Promise<boolean> {
    return this.accessManager.confirmCode(code);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + limit));
    offset += limit;
  }
  return chunks;
}
