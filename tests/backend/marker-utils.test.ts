import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { appendWithMarker, removeMarker } from "../../src/backend/marker-utils.js";

const TEST_DIR = "/tmp/ccd-test-marker-utils";

describe("marker-utils", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  describe("appendWithMarker", () => {
    it("creates new file with marker block", () => {
      const f = join(TEST_DIR, "NEW.md");
      appendWithMarker(f, "inst-a", "Hello world");
      const content = readFileSync(f, "utf-8");
      expect(content).toContain("<!-- AGEND:inst-a:BEGIN -->");
      expect(content).toContain("Hello world");
      expect(content).toContain("<!-- AGEND:inst-a:END -->");
    });

    it("appends to existing file without overwriting", () => {
      const f = join(TEST_DIR, "EXISTING.md");
      writeFileSync(f, "# User content\n");
      appendWithMarker(f, "inst-a", "Fleet context");
      const content = readFileSync(f, "utf-8");
      expect(content).toContain("# User content");
      expect(content).toContain("Fleet context");
    });

    it("is idempotent — replaces existing block with same id", () => {
      const f = join(TEST_DIR, "IDEM.md");
      writeFileSync(f, "# User content\n");
      appendWithMarker(f, "inst-a", "Version 1");
      appendWithMarker(f, "inst-a", "Version 2");
      const content = readFileSync(f, "utf-8");
      expect(content).not.toContain("Version 1");
      expect(content).toContain("Version 2");
      // Should only have one BEGIN marker
      expect(content.match(/AGEND:inst-a:BEGIN/g)?.length).toBe(1);
    });

    it("handles multiple different ids", () => {
      const f = join(TEST_DIR, "MULTI.md");
      appendWithMarker(f, "inst-a", "Content A");
      appendWithMarker(f, "inst-b", "Content B");
      const content = readFileSync(f, "utf-8");
      expect(content).toContain("Content A");
      expect(content).toContain("Content B");
    });

    it("handles id with regex special characters", () => {
      const f = join(TEST_DIR, "SPECIAL.md");
      appendWithMarker(f, "my.instance-1", "Special content");
      const content = readFileSync(f, "utf-8");
      expect(content).toContain("<!-- AGEND:my.instance-1:BEGIN -->");
      expect(content).toContain("Special content");
    });

    it("ensures newline before marker when file doesn't end with one", () => {
      const f = join(TEST_DIR, "NONL.md");
      writeFileSync(f, "No trailing newline");
      appendWithMarker(f, "inst-a", "Content");
      const content = readFileSync(f, "utf-8");
      expect(content).toMatch(/No trailing newline\n\n<!-- AGEND/);
    });
  });

  describe("removeMarker", () => {
    it("removes marker block from file", () => {
      const f = join(TEST_DIR, "REMOVE.md");
      writeFileSync(f, "# User\n<!-- AGEND:inst-a:BEGIN -->\nFleet\n<!-- AGEND:inst-a:END -->\n");
      const isEmpty = removeMarker(f, "inst-a");
      const content = readFileSync(f, "utf-8");
      expect(content).not.toContain("AGEND");
      expect(content).toContain("# User");
      expect(isEmpty).toBe(false);
    });

    it("returns true when file is empty after removal", () => {
      const f = join(TEST_DIR, "EMPTY.md");
      writeFileSync(f, "<!-- AGEND:inst-a:BEGIN -->\nFleet\n<!-- AGEND:inst-a:END -->\n");
      const isEmpty = removeMarker(f, "inst-a");
      expect(isEmpty).toBe(true);
    });

    it("returns false when file does not exist", () => {
      expect(removeMarker(join(TEST_DIR, "NOPE.md"), "inst-a")).toBe(false);
    });

    it("returns false when marker not found", () => {
      const f = join(TEST_DIR, "NOMATCH.md");
      writeFileSync(f, "# Just user content\n");
      expect(removeMarker(f, "inst-a")).toBe(false);
      expect(readFileSync(f, "utf-8")).toBe("# Just user content\n");
    });

    it("only removes the specified id, leaves others intact", () => {
      const f = join(TEST_DIR, "SELECTIVE.md");
      appendWithMarker(f, "inst-a", "Content A");
      appendWithMarker(f, "inst-b", "Content B");
      removeMarker(f, "inst-a");
      const content = readFileSync(f, "utf-8");
      expect(content).not.toContain("Content A");
      expect(content).toContain("Content B");
    });

    it("handles id with regex special characters", () => {
      const f = join(TEST_DIR, "SPECIAL_RM.md");
      appendWithMarker(f, "my.instance-1", "Content");
      removeMarker(f, "my.instance-1");
      const content = readFileSync(f, "utf-8");
      expect(content).not.toContain("AGEND");
    });

    it("falls back to removing from BEGIN to EOF when END marker is missing", () => {
      const f = join(TEST_DIR, "BROKEN.md");
      writeFileSync(f, "# User\n<!-- AGEND:inst-a:BEGIN -->\nOrphan content\n");
      const warnings: string[] = [];
      removeMarker(f, "inst-a", { warn: (msg) => warnings.push(msg) });
      const content = readFileSync(f, "utf-8");
      expect(content).toContain("# User");
      expect(content).not.toContain("Orphan");
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("END marker missing");
    });
  });
});
