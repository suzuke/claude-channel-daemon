import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Escape special regex characters in a string */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function beginTag(id: string): string { return `<!-- AGEND:${id}:BEGIN -->`; }
function endTag(id: string): string { return `<!-- AGEND:${id}:END -->`; }

/**
 * Append content wrapped in marker tags to a file. Idempotent — removes any
 * existing block with the same id before appending.
 */
export function appendWithMarker(filePath: string, id: string, content: string): void {
  let existing = "";
  try { existing = readFileSync(filePath, "utf-8"); } catch { /* new file */ }

  // Remove old block first (idempotent)
  existing = stripMarkerBlock(existing, id);

  // Ensure preceding newline
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : existing.length > 0 ? "\n" : "";
  const block = `${beginTag(id)}\n${content}\n${endTag(id)}\n`;
  writeFileSync(filePath, existing + sep + block);
}

/**
 * Remove a marker block from a file. Returns true if the file is empty/whitespace
 * after removal (caller may want to delete it).
 * Returns false if the file was not modified or still has content.
 */
export function removeMarker(filePath: string, id: string, logger?: { warn: (msg: string) => void }): boolean {
  if (!existsSync(filePath)) return false;
  let content: string;
  try { content = readFileSync(filePath, "utf-8"); } catch { return false; }

  const escaped = escapeRegex(id);
  const re = new RegExp(`\\n?<!-- AGEND:${escaped}:BEGIN -->\\n[\\s\\S]*?<!-- AGEND:${escaped}:END -->\\n?`, "g");

  const updated = content.replace(re, "");
  if (updated === content) {
    // Regex didn't match — try fallback: find BEGIN marker to end of file
    const beginStr = beginTag(id);
    const idx = content.indexOf(beginStr);
    if (idx >= 0) {
      const fallback = content.slice(0, idx).replace(/\n+$/, "\n");
      writeFileSync(filePath, fallback);
      logger?.warn(`marker-utils: END marker missing for ${id} in ${filePath}, removed from BEGIN to EOF`);
      return fallback.trim().length === 0;
    }
    return false;
  }

  writeFileSync(filePath, updated);
  return updated.trim().length === 0;
}

/** Strip a marker block from a string (in-memory, no file I/O) */
function stripMarkerBlock(content: string, id: string): string {
  const escaped = escapeRegex(id);
  const re = new RegExp(`\\n?<!-- AGEND:${escaped}:BEGIN -->\\n[\\s\\S]*?<!-- AGEND:${escaped}:END -->\\n?`, "g");
  return content.replace(re, "");
}
