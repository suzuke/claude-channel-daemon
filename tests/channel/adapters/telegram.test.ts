import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock node:fs createReadStream to avoid real file I/O in sendFile tests ─
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: vi.fn(() => {
      // Return a minimal readable-stream-like object; grammy is mocked so it
      // never actually reads from this.
      const { Readable } = require("node:stream");
      return new Readable({ read() { this.push(null); } });
    }),
  };
});

// ── Mock grammy ───────────────────────────────────────────────────────────
// vi.mock is hoisted to top of file; all references must be inside the factory.

vi.mock("grammy", () => {
  const { EventEmitter } = require("node:events");

  // Registered message handlers – keyed by event name
  const handlers: Record<string, Array<(ctx: unknown) => Promise<void>>> = {};

  class MockBot extends EventEmitter {
    token: string;
    api: Record<string, ReturnType<typeof vi.fn>>;

    constructor(token: string) {
      super();
      this.token = token;
      this.api = {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        editMessageText: vi.fn().mockResolvedValue(undefined),
        sendPhoto: vi.fn().mockResolvedValue({ message_id: 2 }),
        sendDocument: vi.fn().mockResolvedValue({ message_id: 3 }),
        setMessageReaction: vi.fn().mockResolvedValue(undefined),
        getFile: vi.fn().mockResolvedValue({ file_path: "photos/test.jpg" }),
        closeForumTopic: vi.fn().mockResolvedValue(undefined),
      };
    }

    // Override on() to capture grammy-style event filters
    on(event: string, handler: (ctx: unknown) => Promise<void>): this {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return this;
    }

    start(_opts?: unknown): Promise<void> {
      return Promise.resolve();
    }

    stop(): Promise<void> {
      return Promise.resolve();
    }

    catch(_handler: (err: unknown) => void): this {
      return this;
    }
  }

  class MockInputFile {
    constructor(public source: unknown) {}
  }

  class MockInlineKeyboard {
    rows: Array<Array<{ text: string; callback_data: string }>> = [[]];

    text(label: string, data: string): this {
      this.rows[this.rows.length - 1].push({ text: label, callback_data: data });
      return this;
    }
  }

  // Expose handlers map so tests can fire them
  (globalThis as Record<string, unknown>).__grammyHandlers = handlers;

  return { Bot: MockBot, InputFile: MockInputFile, InlineKeyboard: MockInlineKeyboard };
});

// ── Imports after mock ────────────────────────────────────────────────────

import { TelegramAdapter } from "../../../src/channel/adapters/telegram.js";
import { AccessManager } from "../../../src/channel/access-manager.js";
import type { PermissionPrompt } from "../../../src/channel/types.js";

// ── Test helpers ──────────────────────────────────────────────────────────

function makeAccessManager(statePath: string, allowedUsers: number[] = [42]): AccessManager {
  return new AccessManager(
    { mode: "pairing", allowed_users: allowedUsers, max_pending_codes: 3, code_expiry_minutes: 60 },
    statePath,
  );
}

function makeTelegramMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 100, type: "private" },
    from: { id: 42, username: "testuser", first_name: "Test" },
    text: "hello",
    ...overrides,
  };
}

function getHandlers(event: string): Array<(ctx: unknown) => Promise<void>> {
  const h = (globalThis as Record<string, unknown>).__grammyHandlers as Record<
    string,
    Array<(ctx: unknown) => Promise<void>>
  >;
  return h[event] ?? [];
}

async function fireEvent(event: string, ctx: unknown): Promise<void> {
  for (const h of getHandlers(event)) {
    await h(ctx);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("TelegramAdapter", () => {
  let tmpDir: string;
  let am: AccessManager;
  let adapter: TelegramAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear captured handlers
    const h = (globalThis as Record<string, unknown>).__grammyHandlers as Record<string, unknown[]>;
    if (h) {
      for (const key of Object.keys(h)) {
        h[key] = [];
      }
    }

    tmpDir = join(tmpdir(), `ccd-telegram-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    am = makeAccessManager(join(tmpDir, "access.json"));
    adapter = new TelegramAdapter({
      id: "tg-1",
      botToken: "test-token",
      accessManager: am,
      inboxDir: join(tmpDir, "inbox"),
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Identity ──────────────────────────────────────────────────────────────

  it("has type 'telegram'", () => {
    expect(adapter.type).toBe("telegram");
  });

  it("has the configured id", () => {
    expect(adapter.id).toBe("tg-1");
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it("start() starts the queue and bot", async () => {
    // Just ensure it resolves without error
    await expect(adapter.start()).resolves.toBeUndefined();
  });

  it("stop() stops the queue and bot", async () => {
    await adapter.start();
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  // ── sendText ─────────────────────────────────────────────────────────────

  it("sendText sends a message and returns SentMessage", async () => {
    // Access the bot's api mock via the adapter internals
    const bot = (adapter as unknown as { bot: { api: Record<string, ReturnType<typeof vi.fn>> } }).bot;
    bot.api.sendMessage.mockResolvedValueOnce({ message_id: 99 });

    const result = await adapter.sendText("100", "Hello world");

    expect(bot.api.sendMessage).toHaveBeenCalledWith(100, "Hello world", {
      message_thread_id: undefined,
    });
    expect(result).toEqual({ messageId: "99", chatId: "100", threadId: undefined });
  });

  it("sendText passes threadId when provided", async () => {
    const bot = (adapter as unknown as { bot: { api: Record<string, ReturnType<typeof vi.fn>> } }).bot;
    bot.api.sendMessage.mockResolvedValueOnce({ message_id: 50 });

    const result = await adapter.sendText("200", "hi", { threadId: "7" });

    expect(bot.api.sendMessage).toHaveBeenCalledWith(200, "hi", { message_thread_id: 7 });
    expect(result.threadId).toBe("7");
  });

  it("sendText auto-chunks text exceeding chunkLimit", async () => {
    const bot = (adapter as unknown as { bot: { api: Record<string, ReturnType<typeof vi.fn>> } }).bot;
    bot.api.sendMessage.mockResolvedValue({ message_id: 1 });

    const longText = "x".repeat(5000);
    await adapter.sendText("100", longText);

    // First chunk sent directly; the text of that call must be ≤ 4096
    const firstArg = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(firstArg.length).toBeLessThanOrEqual(4096);
  });

  // ── Message handler ───────────────────────────────────────────────────────

  it("emits 'message' for allowed users", async () => {
    const received: unknown[] = [];
    adapter.on("message", (m) => received.push(m));

    await fireEvent("message", { message: makeTelegramMessage({ text: "hi there" }) });

    expect(received).toHaveLength(1);
    const msg = received[0] as Record<string, unknown>;
    expect(msg.text).toBe("hi there");
    expect(msg.chatId).toBe("100");
    expect(msg.userId).toBe("42");
    expect(msg.username).toBe("testuser");
    expect(msg.adapterId).toBe("tg-1");
    expect(msg.source).toBe("telegram");
  });

  it("blocks messages from non-allowed users", async () => {
    const received: unknown[] = [];
    adapter.on("message", (m) => received.push(m));

    await fireEvent("message", {
      message: makeTelegramMessage({ from: { id: 999, username: "stranger" } }),
    });

    expect(received).toHaveLength(0);
  });

  it("extracts threadId from message_thread_id", async () => {
    const received: Array<Record<string, unknown>> = [];
    adapter.on("message", (m) => received.push(m as Record<string, unknown>));

    await fireEvent("message", { message: makeTelegramMessage({ message_thread_id: 55 }) });

    expect(received[0].threadId).toBe("55");
  });

  it("sets threadId to undefined when message_thread_id is absent", async () => {
    const received: Array<Record<string, unknown>> = [];
    adapter.on("message", (m) => received.push(m as Record<string, unknown>));

    await fireEvent("message", { message: makeTelegramMessage() });

    expect(received[0].threadId).toBeUndefined();
  });

  it("captures replyTo from reply_to_message", async () => {
    const received: Array<Record<string, unknown>> = [];
    adapter.on("message", (m) => received.push(m as Record<string, unknown>));

    await fireEvent("message", {
      message: makeTelegramMessage({ reply_to_message: { message_id: 77 } }),
    });

    expect(received[0].replyTo).toBe("77");
  });

  // ── sendFile ──────────────────────────────────────────────────────────────

  it("sendFile uses sendPhoto for image extensions", async () => {
    const bot = (adapter as unknown as { bot: { api: Record<string, ReturnType<typeof vi.fn>> } }).bot;
    bot.api.sendPhoto.mockResolvedValueOnce({ message_id: 10 });

    const result = await adapter.sendFile("100", "/any/path/photo.jpg");

    expect(bot.api.sendPhoto).toHaveBeenCalled();
    expect(result.messageId).toBe("10");
  });

  it("sendFile uses sendDocument for non-image files", async () => {
    const bot = (adapter as unknown as { bot: { api: Record<string, ReturnType<typeof vi.fn>> } }).bot;
    bot.api.sendDocument.mockResolvedValueOnce({ message_id: 11 });

    const result = await adapter.sendFile("100", "/any/path/file.pdf");

    expect(bot.api.sendDocument).toHaveBeenCalled();
    expect(result.messageId).toBe("11");
  });

  // ── editMessage ───────────────────────────────────────────────────────────

  it("editMessage calls bot.api.editMessageText", async () => {
    const bot = (adapter as unknown as { bot: { api: Record<string, ReturnType<typeof vi.fn>> } }).bot;
    await adapter.editMessage("100", "42", "new text");
    expect(bot.api.editMessageText).toHaveBeenCalledWith(100, 42, "new text");
  });

  // ── react ─────────────────────────────────────────────────────────────────

  it("react calls bot.api.setMessageReaction", async () => {
    const bot = (adapter as unknown as { bot: { api: Record<string, ReturnType<typeof vi.fn>> } }).bot;
    await adapter.react("100", "42", "👍");
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(100, 42, [
      { type: "emoji", emoji: "👍" },
    ]);
  });

  // ── Pairing delegation ────────────────────────────────────────────────────

  it("handlePairing delegates to AccessManager.generateCode", async () => {
    const spy = vi.spyOn(am, "generateCode").mockReturnValue("AABBCC");
    const code = await adapter.handlePairing("100", "999");
    expect(spy).toHaveBeenCalledWith(999);
    expect(code).toBe("AABBCC");
  });

  it("confirmPairing delegates to AccessManager.confirmCode", async () => {
    const spy = vi.spyOn(am, "confirmCode").mockReturnValue(true);
    const result = await adapter.confirmPairing("AABBCC");
    expect(spy).toHaveBeenCalledWith("AABBCC");
    expect(result).toBe(true);
  });

  // ── sendApproval ──────────────────────────────────────────────────────────

  it("sendApproval returns an ApprovalHandle with cancel()", async () => {
    const callback = vi.fn();
    const prompt: PermissionPrompt = { tool_name: "Bash", description: "Allow action?" };
    const handle = await adapter.sendApproval(prompt, callback);
    expect(handle).toHaveProperty("cancel");
    expect(typeof handle.cancel).toBe("function");
    handle.cancel(); // should not throw
  });

  it("sendApproval emits approval_request event", async () => {
    const requests: unknown[] = [];
    adapter.on("approval_request", (r) => requests.push(r));

    const prompt: PermissionPrompt = { tool_name: "Bash", description: "Run rm -rf?" };
    await adapter.sendApproval(prompt, vi.fn());

    expect(requests).toHaveLength(1);
    const req = requests[0] as Record<string, unknown>;
    expect(typeof req.prompt).toBe("string");
    expect(req.nonce).toBeDefined();
  });

  it("sendApproval invokes callback with 'approve' on matching callback_query", async () => {
    const callback = vi.fn();
    let capturedNonce = "";

    adapter.on("approval_request", (r: unknown) => {
      capturedNonce = (r as Record<string, string>).nonce;
    });

    const prompt: PermissionPrompt = { tool_name: "Bash", description: "Do it?" };
    await adapter.sendApproval(prompt, callback);

    adapter.emit("callback_query", {
      callbackData: `approval:approve:${capturedNonce}`,
      from: { id: 42 },
    });

    expect(callback).toHaveBeenCalledWith("approve");
  });

  it("sendApproval invokes callback with 'deny' on matching callback_query", async () => {
    const callback = vi.fn();
    let capturedNonce = "";

    adapter.on("approval_request", (r: unknown) => {
      capturedNonce = (r as Record<string, string>).nonce;
    });

    const prompt: PermissionPrompt = { tool_name: "Bash", description: "Do it?" };
    await adapter.sendApproval(prompt, callback);

    adapter.emit("callback_query", {
      callbackData: `approval:deny:${capturedNonce}`,
      from: { id: 42 },
    });

    expect(callback).toHaveBeenCalledWith("deny");
  });

  // ── closeForumTopic ───────────────────────────────────────────────────────

  it("closeForumTopic calls bot.api.closeForumTopic with lastChatId and threadId", async () => {
    const bot = (adapter as unknown as { bot: { api: Record<string, ReturnType<typeof vi.fn>> } }).bot;
    adapter.setLastChatId("-100123456");
    await adapter.closeForumTopic(55);
    expect(bot.api.closeForumTopic).toHaveBeenCalledWith(-100123456, 55);
  });

  it("closeForumTopic is a no-op when lastChatId is not set", async () => {
    const bot = (adapter as unknown as { bot: { api: Record<string, ReturnType<typeof vi.fn>> } }).bot;
    // lastChatId defaults to null, so this should return without calling the API
    await expect(adapter.closeForumTopic(99)).resolves.toBeUndefined();
    expect(bot.api.closeForumTopic).not.toHaveBeenCalled();
  });

  it("closeForumTopic silently ignores API errors", async () => {
    const bot = (adapter as unknown as { bot: { api: Record<string, ReturnType<typeof vi.fn>> } }).bot;
    bot.api.closeForumTopic.mockRejectedValueOnce(new Error("TOPIC_CLOSED"));
    adapter.setLastChatId("-100123456");
    await expect(adapter.closeForumTopic(55)).resolves.toBeUndefined();
  });

  it("sendApproval does not invoke callback after signal abort", async () => {
    const controller = new AbortController();
    const callback = vi.fn();

    adapter.on("approval_request", () => {});

    const prompt: PermissionPrompt = { tool_name: "Bash", description: "Abort me?" };
    await adapter.sendApproval(prompt, callback, controller.signal);
    controller.abort();

    // A subsequent callback_query with a mismatched nonce should be ignored anyway
    adapter.emit("callback_query", { data: "approval:approve:stale-nonce" });
    expect(callback).not.toHaveBeenCalled();
  });
});
