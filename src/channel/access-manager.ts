import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AccessConfig } from "../types.js";

interface PendingCode {
  code: string;
  userId: number | string;
  createdAt: number;
  attempts: number;
}

interface AccessState {
  mode?: "pairing" | "locked";
  allowed_users: (number | string)[];
  pending_codes: PendingCode[];
}

export class AccessManager {
  private config: AccessConfig;
  private statePath: string;
  private state: AccessState;
  private failedAttempts: Map<string, { count: number; lastAttempt: number }> = new Map();

  constructor(config: AccessConfig, statePath: string) {
    this.config = config;
    this.statePath = statePath;

    // Load persisted state or start fresh
    if (existsSync(statePath)) {
      try {
        const raw = readFileSync(statePath, "utf8");
        const saved = JSON.parse(raw) as Partial<AccessState>;
        this.state = {
          mode: saved.mode,
          allowed_users: saved.allowed_users ?? [],
          pending_codes: saved.pending_codes ?? [],
        };
      } catch {
        this.state = { allowed_users: [], pending_codes: [] };
      }
    } else {
      this.state = { allowed_users: [], pending_codes: [] };
    }

    // Merge config's allowed_users with saved ones (deduplicated, normalized to string)
    const merged = new Set([...this.state.allowed_users, ...config.allowed_users].map(String));
    this.state.allowed_users = Array.from(merged);

    // If saved state has no mode, use config mode
    if (this.state.mode === undefined) {
      this.state.mode = config.mode;
    }

    // Prune expired codes on load
    this.pruneExpired();
  }

  private persist(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  private pruneExpired(): void {
    const now = Date.now();
    const expiryMs = this.config.code_expiry_minutes * 60 * 1000;
    const before = this.state.pending_codes.length;
    this.state.pending_codes = this.state.pending_codes.filter(
      (p) => now - p.createdAt < expiryMs,
    );
    if (this.state.pending_codes.length !== before) {
      this.persist();
    }
  }

  isAllowed(userId: number | string): boolean {
    const key = String(userId);
    return this.state.allowed_users.some(u => String(u) === key);
  }

  hasPairingQuota(userId: number | string): boolean {
    const key = String(userId);
    const userCodes = this.state.pending_codes.filter((p) => String(p.userId) === key);
    return userCodes.length < 2;
  }

  generateCode(userId: number | string): string {
    this.pruneExpired();

    if (this.state.mode === "locked") {
      throw new Error("Cannot generate pairing code in locked mode");
    }

    if (!this.hasPairingQuota(userId)) {
      throw new Error(`User ${userId} has reached max pairing code attempts (2)`);
    }

    // Count distinct users with pending codes (normalized to string)
    const usersWithPending = new Set(this.state.pending_codes.map((p) => String(p.userId)));
    // If this user is new and we're already at max, throw
    if (!usersWithPending.has(String(userId)) && usersWithPending.size >= this.config.max_pending_codes) {
      throw new Error(`Max pending codes reached for ${this.config.max_pending_codes} unique users`);
    }

    const code = randomBytes(4).toString("hex").toUpperCase();
    this.state.pending_codes.push({
      code,
      userId,
      createdAt: Date.now(),
      attempts: 0,
    });
    this.persist();
    return code;
  }

  confirmCode(code: string, callerUserId?: string): boolean {
    this.pruneExpired();

    // Rate limit: check per-userId failures (10 failures in 60 seconds)
    if (callerUserId) {
      const record = this.failedAttempts.get(callerUserId);
      if (record) {
        const elapsed = Date.now() - record.lastAttempt;
        if (elapsed > 60_000) {
          // Reset window
          this.failedAttempts.delete(callerUserId);
        } else if (record.count >= 10) {
          return false;
        }
      }
    }

    const entry = this.state.pending_codes.find((p) => p.code === code);
    if (!entry) {
      // Increment attempts on all pending codes that were checked
      for (const pending of this.state.pending_codes) {
        pending.attempts++;
      }
      // Auto-invalidate codes that have been tried too many times
      this.state.pending_codes = this.state.pending_codes.filter(
        (p) => p.attempts < 5,
      );

      // Track per-userId failures
      if (callerUserId) {
        const record = this.failedAttempts.get(callerUserId);
        if (record) {
          record.count++;
          record.lastAttempt = Date.now();
        } else {
          this.failedAttempts.set(callerUserId, { count: 1, lastAttempt: Date.now() });
        }
      }

      this.persist();
      return false;
    }

    // Add user to allowlist if not already there (normalized to string)
    const entryKey = String(entry.userId);
    if (!this.state.allowed_users.some(u => String(u) === entryKey)) {
      this.state.allowed_users.push(entryKey);
    }

    // Remove all pending codes for that user
    this.state.pending_codes = this.state.pending_codes.filter(
      (p) => String(p.userId) !== entryKey,
    );

    this.persist();
    return true;
  }

  setMode(mode: "pairing" | "locked"): void {
    this.state.mode = mode;
    this.persist();
  }

  getMode(): "pairing" | "locked" {
    return this.state.mode ?? this.config.mode;
  }

  getAllowedUsers(): (number | string)[] {
    return [...this.state.allowed_users];
  }

  removeUser(userId: number | string): boolean {
    const key = String(userId);
    const idx = this.state.allowed_users.findIndex(u => String(u) === key);
    if (idx === -1) {
      return false;
    }
    this.state.allowed_users.splice(idx, 1);
    this.persist();
    return true;
  }
}
