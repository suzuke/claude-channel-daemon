import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryLayer } from "../src/memory-layer.js";
import { MemoryDb } from "../src/db.js";
import { createLogger } from "../src/logger.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

describe("MemoryLayer", () => {
  let tmpDir: string;
  let memoryDir: string;
  let db: MemoryDb;
  let layer: MemoryLayer;
  const logger = createLogger("silent");

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-mem-test-${Date.now()}`);
    memoryDir = join(tmpDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    db = new MemoryDb(join(tmpDir, "test.db"));
    layer = new MemoryLayer(memoryDir, db, logger);
  });

  afterEach(async () => {
    await layer.stop();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects new memory file and backs up", async () => {
    await layer.start();

    writeFileSync(join(memoryDir, "test.md"), "# Test memory");

    // chokidar needs a moment to detect
    await new Promise((r) => setTimeout(r, 500));

    const rows = db.getAll();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].content).toBe("# Test memory");
  });

  it("detects changed memory file and backs up new version", async () => {
    writeFileSync(join(memoryDir, "existing.md"), "v1");
    await layer.start();

    writeFileSync(join(memoryDir, "existing.md"), "v2");
    await new Promise((r) => setTimeout(r, 500));

    const rows = db.getByFilePath(join(memoryDir, "existing.md"));
    expect(rows.some((r) => r.content === "v2")).toBe(true);
  });

  it("emits file_changed event when a file is added", async () => {
    const changeSpy = vi.fn();
    layer.on("file_changed", changeSpy);
    await layer.start();

    const testFile = join(memoryDir, "test.md");
    writeFileSync(testFile, "hello");

    // chokidar needs time to detect + stabilityThreshold (200ms)
    await vi.waitFor(() => {
      expect(changeSpy).toHaveBeenCalledWith(testFile);
    }, { timeout: 3000 });
  });
});
