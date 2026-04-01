import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { SchedulerDb } from "../src/scheduler/db.js";

describe("SchedulerDb — Decisions", () => {
  let tmpDir: string;
  let db: SchedulerDb;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `decisions-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    db = new SchedulerDb(join(tmpDir, "scheduler.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates and retrieves a decision", () => {
    const d = db.createDecision({
      project_root: "/projects/web",
      title: "Use TypeScript strict mode",
      content: "All new files must use strict: true in tsconfig",
      created_by: "web-agent",
    });
    expect(d.id).toBeTruthy();
    expect(d.title).toBe("Use TypeScript strict mode");
    expect(d.status).toBe("active");
    expect(d.created_by).toBe("web-agent");
    expect(d.expires_at).toBeNull(); // default = permanent (no expiry)

    const retrieved = db.getDecision(d.id);
    expect(retrieved).toEqual(d);
  });

  it("lists decisions by project_root", () => {
    db.createDecision({ project_root: "/a", title: "A1", content: "c", created_by: "x" });
    db.createDecision({ project_root: "/a", title: "A2", content: "c", created_by: "x" });
    db.createDecision({ project_root: "/b", title: "B1", content: "c", created_by: "x" });

    const aDecisions = db.listDecisions("/a");
    expect(aDecisions).toHaveLength(2);
    const bDecisions = db.listDecisions("/b");
    expect(bDecisions).toHaveLength(1);
  });

  it("filters by tags", () => {
    db.createDecision({ project_root: "/p", title: "T1", content: "c", tags: ["arch", "db"], created_by: "x" });
    db.createDecision({ project_root: "/p", title: "T2", content: "c", tags: ["style"], created_by: "x" });
    db.createDecision({ project_root: "/p", title: "T3", content: "c", created_by: "x" }); // no tags

    const archDecisions = db.listDecisions("/p", { tags: ["arch"] });
    expect(archDecisions).toHaveLength(1);
    expect(archDecisions[0].title).toBe("T1");
  });

  it("updates a decision", () => {
    const d = db.createDecision({ project_root: "/p", title: "Old", content: "old content", created_by: "x" });
    const updated = db.updateDecision(d.id, { content: "new content", tags: ["updated"] });
    expect(updated.content).toBe("new content");
    expect(updated.tags).toEqual(["updated"]);
  });

  it("archives a decision", () => {
    const d = db.createDecision({ project_root: "/p", title: "Temp", content: "c", created_by: "x" });
    db.archiveDecision(d.id);
    const archived = db.getDecision(d.id);
    expect(archived?.status).toBe("archived");

    // Not visible in default list
    const active = db.listDecisions("/p");
    expect(active).toHaveLength(0);

    // Visible with includeArchived
    const all = db.listDecisions("/p", { includeArchived: true });
    expect(all).toHaveLength(1);
  });

  it("supersedes a decision", () => {
    const old = db.createDecision({ project_root: "/p", title: "V1", content: "old", created_by: "x" });
    const newer = db.createDecision({ project_root: "/p", title: "V2", content: "new", created_by: "x", supersedes: old.id });

    const oldAfter = db.getDecision(old.id);
    expect(oldAfter?.status).toBe("superseded");
    expect(oldAfter?.superseded_by).toBe(newer.id);

    // Only V2 is active
    const active = db.listDecisions("/p");
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe("V2");
  });

  it("creates expiring decision with explicit ttl_days", () => {
    const d = db.createDecision({ project_root: "/p", title: "Temp", content: "c", created_by: "x", ttl_days: 7 });
    expect(d.expires_at).toBeTruthy();
  });

  it("prunes expired decisions", () => {
    // Create a decision with expires_at in the past
    const d = db.createDecision({ project_root: "/p", title: "Expired", content: "c", created_by: "x", ttl_days: 1 });
    // Manually set expires_at to past
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();
    db["db"].prepare("UPDATE decisions SET expires_at = ? WHERE id = ?").run(pastDate, d.id);

    const pruned = db.pruneExpiredDecisions();
    expect(pruned).toBe(1);

    const after = db.getDecision(d.id);
    expect(after?.status).toBe("archived");
  });

  it("throws on update non-existent decision", () => {
    expect(() => db.updateDecision("fake-id", { content: "x" })).toThrow(/not found/i);
  });

  // ── Fleet scope ───────────────────────────────────────────────

  it("fleet decision is visible from any project_root", () => {
    db.createDecision({ project_root: "/a", scope: "fleet", title: "Always use worktrees", content: "c", created_by: "x" });
    db.createDecision({ project_root: "/a", scope: "project", title: "Use ESM", content: "c", created_by: "x" });

    // From project /a: sees both
    const fromA = db.listDecisions("/a");
    expect(fromA).toHaveLength(2);

    // From project /b: sees only fleet decision
    const fromB = db.listDecisions("/b");
    expect(fromB).toHaveLength(1);
    expect(fromB[0].title).toBe("Always use worktrees");
    expect(fromB[0].scope).toBe("fleet");
  });

  it("fleet decisions appear before project decisions", () => {
    db.createDecision({ project_root: "/p", scope: "project", title: "Project first", content: "c", created_by: "x" });
    db.createDecision({ project_root: "/p", scope: "fleet", title: "Fleet rule", content: "c", created_by: "x" });

    const list = db.listDecisions("/p");
    expect(list[0].scope).toBe("fleet");
    expect(list[1].scope).toBe("project");
  });

  it("defaults to project scope when not specified", () => {
    const d = db.createDecision({ project_root: "/p", title: "Default", content: "c", created_by: "x" });
    expect(d.scope).toBe("project");
  });

  it("migrates existing DB without scope column", () => {
    // Simulate a pre-v1.4 DB: create decisions table WITHOUT scope column
    const oldDbPath = join(tmpDir, "old-schema.db");
    const Database = require("better-sqlite3");
    const oldDb = new Database(oldDbPath);
    oldDb.exec(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, project_root TEXT NOT NULL, title TEXT NOT NULL,
        content TEXT NOT NULL, tags TEXT, status TEXT NOT NULL DEFAULT 'active',
        superseded_by TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        expires_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE schedules (id TEXT PRIMARY KEY, cron TEXT, message TEXT,
        source TEXT, target TEXT, reply_chat_id TEXT, reply_thread_id TEXT,
        label TEXT, enabled INTEGER DEFAULT 1, timezone TEXT, created_at TEXT,
        last_triggered_at TEXT, last_status TEXT);
    `);
    // Insert a row without scope
    oldDb.prepare("INSERT INTO decisions VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?, NULL, ?)")
      .run("old-1", "/p", "Old decision", "content", "agent", new Date().toISOString(), new Date().toISOString());
    oldDb.close();

    // Open with SchedulerDb — should auto-migrate
    const migratedDb = new SchedulerDb(oldDbPath);

    // Verify old row has scope = 'project' (default)
    const old = migratedDb.getDecision("old-1");
    expect(old).not.toBeNull();
    expect(old!.scope).toBe("project");

    // Verify CRUD works with scope
    const fleet = migratedDb.createDecision({
      project_root: "/other", scope: "fleet", title: "Fleet rule", content: "c", created_by: "x",
    });
    expect(fleet.scope).toBe("fleet");

    // Verify listDecisions returns fleet + project correctly
    const fromOther = migratedDb.listDecisions("/other");
    expect(fromOther).toHaveLength(1);
    expect(fromOther[0].scope).toBe("fleet");

    const fromP = migratedDb.listDecisions("/p");
    expect(fromP).toHaveLength(2); // old project + fleet

    migratedDb.close();
  });
});
