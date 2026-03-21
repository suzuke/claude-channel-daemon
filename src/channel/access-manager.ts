import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { AccessConfig } from "../types.js";

interface PendingCode {
  code: string;
  userId: number;
  createdAt: number;
  attempts: number;
}

interface AccessState {
  mode?: "pairing" | "locked";
  allowed_users: number[];
  pending_codes: PendingCode[];
}

export class AccessManager {
  private config: AccessConfig;
  private statePath: string;
  private state: AccessState;

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

    // Merge config's allowed_users with saved ones (deduplicated)
    const merged = new Set([...this.state.allowed_users, ...config.allowed_users]);
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

  isAllowed(userId: number): boolean {
    return this.state.allowed_users.includes(userId);
  }

  hasPairingQuota(userId: number): boolean {
    const userCodes = this.state.pending_codes.filter((p) => p.userId === userId);
    return userCodes.length < 2;
  }

  generateCode(userId: number): string {
    this.pruneExpired();

    if (this.state.mode === "locked") {
      throw new Error("Cannot generate pairing code in locked mode");
    }

    if (!this.hasPairingQuota(userId)) {
      throw new Error(`User ${userId} has reached max pairing code attempts (2)`);
    }

    // Count distinct users with pending codes
    const usersWithPending = new Set(this.state.pending_codes.map((p) => p.userId));
    // If this user is new and we're already at max, throw
    if (!usersWithPending.has(userId) && usersWithPending.size >= this.config.max_pending_codes) {
      throw new Error(`Max pending codes reached for ${this.config.max_pending_codes} unique users`);
    }

    const code = randomBytes(3).toString("hex").toUpperCase();
    this.state.pending_codes.push({
      code,
      userId,
      createdAt: Date.now(),
      attempts: 0,
    });
    this.persist();
    return code;
  }

  confirmCode(code: string): boolean {
    this.pruneExpired();

    const entry = this.state.pending_codes.find((p) => p.code === code);
    if (!entry) {
      return false;
    }

    // Add user to allowlist if not already there
    if (!this.state.allowed_users.includes(entry.userId)) {
      this.state.allowed_users.push(entry.userId);
    }

    // Remove all pending codes for that user
    this.state.pending_codes = this.state.pending_codes.filter(
      (p) => p.userId !== entry.userId,
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

  getAllowedUsers(): number[] {
    return [...this.state.allowed_users];
  }

  removeUser(userId: number): boolean {
    const idx = this.state.allowed_users.indexOf(userId);
    if (idx === -1) {
      return false;
    }
    this.state.allowed_users.splice(idx, 1);
    this.persist();
    return true;
  }
}
