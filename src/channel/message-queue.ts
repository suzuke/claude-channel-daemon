import type { QueuedMessage } from "./types.js";

const MAX_MESSAGE_LENGTH = 4096;
const WORKER_IDLE_WAIT_MS = 200;
const WORKER_BETWEEN_MS = 50;
const MAX_BACKOFF_MS = 30_000;
const FLOOD_CONTROL_THRESHOLD_MS = 10_000;
const INITIAL_BACKOFF_MS = 1_000;

interface QueueSender {
  send(chatId: string, threadId: string | undefined, text: string): Promise<{ messageId: string }>;
  edit(chatId: string, messageId: string, text: string): Promise<void>;
  sendFile(chatId: string, threadId: string | undefined, filePath: string): Promise<{ messageId: string }>;
}

interface QueueKey {
  chatId: string;
  threadId: string | undefined;
}

interface PerQueueState {
  key: QueueKey;
  items: QueuedMessage[];
  backoffMs: number;
  backoffUntil: number;
  running: boolean;
}

function is429Error(err: unknown): boolean {
  if (err instanceof Error) {
    const e = err as Error & { status?: number; code?: number; response?: { status?: number } };
    if (e.status === 429) return true;
    if (e.code === 429) return true;
    if (e.response?.status === 429) return true;
    if (e.message.includes("429") || e.message.toLowerCase().includes("too many requests")) return true;
  }
  return false;
}

function splitText(text: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + MAX_MESSAGE_LENGTH));
    offset += MAX_MESSAGE_LENGTH;
  }
  return chunks;
}

export class MessageQueue {
  private queues = new Map<string, PerQueueState>();
  private stopped = true;
  private logger?: { warn(obj: unknown, msg?: string): void };

  constructor(private sender: QueueSender, logger?: { warn(obj: unknown, msg?: string): void }) {
    this.logger = logger;
  }

  private queueKey(chatId: string, threadId: string | undefined): string {
    return threadId != null ? `${chatId}:${threadId}` : `${chatId}:`;
  }

  private getOrCreateQueue(chatId: string, threadId: string | undefined): PerQueueState {
    const key = this.queueKey(chatId, threadId);
    let state = this.queues.get(key);
    if (!state) {
      state = {
        key: { chatId, threadId },
        items: [],
        backoffMs: INITIAL_BACKOFF_MS,
        backoffUntil: 0,
        running: false,
      };
      this.queues.set(key, state);
    }
    return state;
  }

  enqueue(chatId: string, threadId: string | undefined, msg: QueuedMessage): void {
    const state = this.getOrCreateQueue(chatId, threadId);
    state.items.push(msg);
    // If worker is already running, it will pick this up automatically.
    // If queue was started and worker is not running, restart it.
    if (!this.stopped && !state.running) {
      this.runWorker(state);
    }
  }

  start(): void {
    this.stopped = false;
    // Start workers for any queues that already have items
    for (const state of this.queues.values()) {
      if (!state.running && state.items.length > 0) {
        this.runWorker(state);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    // Clear all queues
    for (const state of this.queues.values()) {
      state.items = [];
    }
  }

  private async runWorker(state: PerQueueState): Promise<void> {
    if (state.running) return;
    state.running = true;

    while (!this.stopped) {
      // Apply backoff if needed
      const now = Date.now();
      if (state.backoffUntil > now) {
        const waitMs = state.backoffUntil - now;
        await this.sleep(Math.min(waitMs, 100));
        continue;
      }

      // Apply flood control: drop status_update items if backoff > threshold
      if (state.backoffMs > FLOOD_CONTROL_THRESHOLD_MS) {
        const before = state.items.length;
        state.items = state.items.filter(item => item.type !== "status_update");
        if (before !== state.items.length) {
          // Items were dropped; reset backoff now that we've cleaned up
        }
      }

      if (state.items.length === 0) {
        await this.sleep(WORKER_IDLE_WAIT_MS);
        continue;
      }

      // Pop and process next item(s)
      const { items: pendingItems, work } = this.prepareNext(state);
      if (!work) {
        await this.sleep(WORKER_IDLE_WAIT_MS);
        continue;
      }
      try {
        await work();
        // Reset backoff on success
        state.backoffMs = INITIAL_BACKOFF_MS;
        state.backoffUntil = 0;
        await this.sleep(WORKER_BETWEEN_MS);
      } catch (err) {
        if (is429Error(err)) {
          // Re-insert the consumed items back at the front of the queue
          state.items.unshift(...pendingItems);
          // Exponential backoff, cap at MAX_BACKOFF_MS
          state.backoffUntil = Date.now() + state.backoffMs;
          state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
        } else {
          // Non-rate-limit error: drop the item to avoid infinite loops
          this.logger?.warn({ err, chatId: state.key.chatId }, "Message dropped due to non-retryable error");
          state.backoffMs = INITIAL_BACKOFF_MS;
          state.backoffUntil = 0;
          await this.sleep(WORKER_BETWEEN_MS);
        }
      }
    }

    state.running = false;
  }

  /**
   * Synchronously extracts items from the queue and returns the extracted items
   * plus an async work function. The work function does the actual sending.
   * This split allows us to know which items to re-queue if the work fails.
   */
  private prepareNext(state: PerQueueState): {
    items: QueuedMessage[];
    work: (() => Promise<void>) | null;
  } {
    const { chatId, threadId } = state.key;
    const first = state.items[0];
    if (!first) return { items: [], work: null };

    if (first.type === "content") {
      const { merged, consumed } = this.mergeContentMessages(state);
      const work = async () => {
        for (const chunk of merged) {
          if (chunk.filePath) {
            await this.sender.sendFile(chatId, threadId, chunk.filePath);
          } else if (chunk.text) {
            const parts = splitText(chunk.text);
            for (const part of parts) {
              await this.sender.send(chatId, threadId, part);
            }
          }
        }
      };
      return { items: consumed, work };
    } else if (first.type === "status_update") {
      state.items.shift();
      const item = first;
      const work = async () => {
        if (item.editMessageId) {
          await this.sender.edit(chatId, item.editMessageId, item.text ?? "");
        } else {
          await this.sender.send(chatId, threadId, item.text ?? "");
        }
      };
      return { items: [item], work };
    } else if (first.type === "status_clear") {
      state.items.shift();
      return { items: [first], work: async () => { /* no-op */ } };
    }
    return { items: [], work: null };
  }

  /**
   * Merges all adjacent content messages at the front of the queue.
   * Respects the 4096 char limit per chunk.
   * Returns merged chunks plus the original consumed items (for re-queuing on error).
   */
  private mergeContentMessages(state: PerQueueState): {
    merged: Array<{ text?: string; filePath?: string }>;
    consumed: QueuedMessage[];
  } {
    // Collect all leading content items
    const consumed: QueuedMessage[] = [];
    while (state.items.length > 0 && state.items[0].type === "content") {
      consumed.push(state.items.shift()!);
    }

    const merged: Array<{ text?: string; filePath?: string }> = [];
    let currentText = "";

    for (const item of consumed) {
      if (item.filePath) {
        // Flush any pending text first
        if (currentText.length > 0) {
          const parts = splitText(currentText);
          for (const part of parts) {
            merged.push({ text: part });
          }
          currentText = "";
        }
        merged.push({ filePath: item.filePath });
      } else if (item.text) {
        // Try to append to current text, splitting if necessary
        const combined = currentText + item.text;
        if (combined.length <= MAX_MESSAGE_LENGTH) {
          currentText = combined;
        } else {
          // Flush current accumulated text first
          if (currentText.length > 0) {
            const parts = splitText(currentText);
            for (const part of parts) {
              merged.push({ text: part });
            }
            currentText = "";
          }
          // Now handle item.text which might itself be long
          if (item.text.length <= MAX_MESSAGE_LENGTH) {
            currentText = item.text;
          } else {
            const parts = splitText(item.text);
            const lastPart = parts.pop()!;
            for (const part of parts) {
              merged.push({ text: part });
            }
            currentText = lastPart;
          }
        }
      }
    }

    if (currentText.length > 0) {
      merged.push({ text: currentText });
    }

    return { merged, consumed };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
