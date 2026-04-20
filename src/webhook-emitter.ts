import { createHmac, randomUUID } from "node:crypto";
import type { WebhookConfig } from "./types.js";
import type { Logger } from "./logger.js";

export interface WebhookPayload {
  event: string;
  instance: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Retry schedule (ms) for failed POSTs. We retry on network error and 5xx,
 * but never on 4xx (caller config error — would just spam the receiver).
 * Cap at 3 attempts total (1 initial + 2 retries) so a flaky receiver doesn't
 * back up our event pipeline indefinitely.
 */
const RETRY_DELAYS_MS = [1000, 4000];
const REQUEST_TIMEOUT_MS = 5000;

export class WebhookEmitter {
  constructor(
    private configs: WebhookConfig[],
    private logger: Logger,
  ) {}

  emit(event: string, instance: string, data: Record<string, unknown> = {}): void {
    const payload: WebhookPayload = {
      event,
      instance,
      timestamp: new Date().toISOString(),
      data,
    };

    for (const config of this.configs) {
      if (config.events.includes("*") || config.events.includes(event)) {
        // One delivery id per event, reused across retries so receivers can dedupe.
        this.deliver(config, JSON.stringify(payload), randomUUID(), 0).catch(() => {
          /* swallowed — deliver() already logs on terminal failure */
        });
      }
    }
  }

  /** Test seam: subclasses or tests can override fetch behavior. */
  protected fetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  }

  private async deliver(
    config: WebhookConfig,
    body: string,
    deliveryId: string,
    attempt: number,
  ): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-AgEnD-Delivery": deliveryId,
      "X-AgEnD-Timestamp": timestamp,
      ...config.headers,
    };

    if (config.secret) {
      // Sign `${timestamp}.${body}` so a recorded body alone can't be replayed
      // outside the receiver's timestamp tolerance window.
      const sig = createHmac("sha256", config.secret)
        .update(`${timestamp}.${body}`)
        .digest("hex");
      headers["X-AgEnD-Signature"] = `sha256=${sig}`;
    }

    let shouldRetry = false;
    let failureReason: string;

    try {
      const res = await this.fetch(config.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return;
      // 5xx → retry; 4xx → caller misconfig, don't retry.
      shouldRetry = res.status >= 500;
      failureReason = `HTTP ${res.status}`;
    } catch (err) {
      shouldRetry = true;
      failureReason = err instanceof Error ? err.message : String(err);
    }

    if (shouldRetry && attempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attempt];
      setTimeout(() => {
        this.deliver(config, body, deliveryId, attempt + 1).catch(() => { /* logged */ });
      }, delay);
      return;
    }

    this.logger.warn(
      { url: config.url, deliveryId, attempts: attempt + 1, reason: failureReason },
      "Webhook POST failed (giving up)",
    );
  }
}
