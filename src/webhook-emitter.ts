import { createHmac } from "node:crypto";
import type { WebhookConfig } from "./types.js";
import type { Logger } from "./logger.js";

export interface WebhookPayload {
  event: string;
  instance: string;
  timestamp: string;
  data: Record<string, unknown>;
}

const DEFAULT_MAX_ATTEMPTS = 3;

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
        void this.post(config, payload);
      }
    }
  }

  private async post(config: WebhookConfig, payload: WebhookPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...config.headers,
    };
    if (config.secret) {
      const sig = createHmac("sha256", config.secret).update(body).digest("hex");
      headers["X-Agend-Signature"] = `sha256=${sig}`;
    }

    const maxAttempts = Math.max(1, config.max_attempts ?? DEFAULT_MAX_ATTEMPTS);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(config.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(5000),
        });
        // Only 2xx is success; 4xx is a non-retryable client error; 5xx is retryable.
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500) {
          this.logger.warn(
            { url: config.url, event: payload.event, status: res.status },
            "Webhook POST rejected by server (non-retryable)",
          );
          return;
        }
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      if (attempt < maxAttempts) {
        // Exponential backoff: 1s, 2s, 4s, …
        const delayMs = 1000 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    this.logger.warn(
      { err: lastErr, url: config.url, event: payload.event, attempts: maxAttempts },
      "Webhook POST failed after retries",
    );
  }
}
