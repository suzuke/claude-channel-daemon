import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export interface InstallCommand {
  type: "pip" | "apt" | "cargo" | "npm";
  packages: string[];
}

const INSTALL_PATTERNS: Array<{
  type: InstallCommand["type"];
  pattern: RegExp;
  extract: (match: RegExpMatchArray) => string[];
}> = [
  {
    type: "pip",
    pattern: /pip3?\s+install\s+(.+)/,
    extract: (m) => {
      const tokens = m[1].split(/\s+/);
      const skipNext = new Set(["-r", "-c", "-e", "--requirement", "--constraint", "--editable"]);
      const packages: string[] = [];
      let skip = false;
      for (const t of tokens) {
        if (skip) { skip = false; continue; }
        if (skipNext.has(t)) { skip = true; continue; }
        if (t.startsWith("-") || t.startsWith("--")) continue;
        if (t === "." || t.startsWith("./") || t.startsWith("/")) continue;  // local paths
        if (t.includes("://") || t.includes("+https")) continue;  // URLs
        if (t.endsWith(".txt") || t.endsWith(".cfg") || t.endsWith(".toml")) continue;  // files
        packages.push(t);
      }
      return packages;
    },
  },
  {
    type: "apt",
    pattern: /apt(?:-get)?\s+install\s+(.+)/,
    extract: (m) => m[1].split(/\s+/).filter(p => !p.startsWith("-") && !p.startsWith("--")),
  },
  {
    type: "cargo",
    pattern: /cargo\s+install\s+(.+)/,
    extract: (m) => {
      const tokens = m[1].split(/\s+/);
      const skipNext = new Set(["--path", "--git", "--branch", "--tag", "--rev", "--root", "--index", "--registry"]);
      const packages: string[] = [];
      let skip = false;
      for (const t of tokens) {
        if (skip) { skip = false; continue; }
        if (skipNext.has(t)) { skip = true; continue; }
        if (t.startsWith("-") || t.startsWith("--")) continue;
        if (t.includes("://") || t.includes("/")) continue;  // URLs and paths
        packages.push(t);
      }
      return packages;
    },
  },
  {
    type: "npm",
    pattern: /npm\s+install\s+-g\s+(.+)/,
    extract: (m) => m[1].split(/\s+/).filter(p => !p.startsWith("-") && !p.startsWith("--")),
  },
];

/**
 * Parse a shell command and detect if it's a package install command.
 * For multiline / chained commands (&&), each segment is checked.
 * Returns the first matching install command, or null.
 */
export function parseInstallCommand(command: string): InstallCommand | null {
  // Split on && to handle chained commands like "apt-get update && apt-get install -y ffmpeg"
  const segments = command.split(/\s*&&\s*/);
  for (const segment of segments) {
    // Strip leading sudo
    const stripped = segment.replace(/^\s*sudo\s+/, "");
    for (const { type, pattern, extract } of INSTALL_PATTERNS) {
      const match = stripped.match(pattern);
      if (match) {
        const packages = extract(match);
        if (packages.length > 0) return { type, packages };
      }
    }
  }
  return null;
}

/**
 * Record an install command to a file, deduplicating against existing entries.
 */
export function recordInstall(filePath: string, install: InstallCommand): void {
  const ts = new Date().toISOString();
  // Deduplicate: check existing records before appending
  const existing = new Set<string>();
  if (existsSync(filePath)) {
    for (const line of readFileSync(filePath, "utf-8").split("\n")) {
      const [type, pkg] = line.split("|");
      if (type && pkg) existing.add(`${type}|${pkg}`);
    }
  }
  const newLines = install.packages
    .filter(pkg => !existing.has(`${install.type}|${pkg}`))
    .map(pkg => `${install.type}|${pkg}|${ts}`);
  if (newLines.length > 0) {
    appendFileSync(filePath, newLines.join("\n") + "\n");
  }
}

export interface PendingPackages {
  apt: string[];
  pip: string[];
  cargo: string[];
  npm: string[];
  count: number;
  oldestTs: Date | null;
}

/**
 * Read pending packages from the record file.
 */
export function readPendingPackages(filePath: string): PendingPackages {
  const result: PendingPackages = { apt: [], pip: [], cargo: [], npm: [], count: 0, oldestTs: null };
  if (!existsSync(filePath)) return result;

  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return result;

  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const [type, pkg, ts] = line.split("|");
    if (!type || !pkg) continue;
    const key = `${type}|${pkg}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (type === "apt") result.apt.push(pkg);
    else if (type === "pip") result.pip.push(pkg);
    else if (type === "cargo") result.cargo.push(pkg);
    else if (type === "npm") result.npm.push(pkg);

    if (ts) {
      const date = new Date(ts);
      if (!result.oldestTs || date < result.oldestTs) result.oldestTs = date;
    }
  }
  result.count = result.apt.length + result.pip.length + result.cargo.length + result.npm.length;
  return result;
}

/**
 * Clear all pending packages by truncating the file.
 */
export function clearPendingPackages(filePath: string): void {
  writeFileSync(filePath, "");
}
