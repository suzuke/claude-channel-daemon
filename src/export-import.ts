import { execFileSync } from "node:child_process";
import {
  existsSync,
  statSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, basename, resolve, sep as pathSep } from "node:path";
import { homedir } from "node:os";

const MINIMAL_FILES = ["fleet.yaml", ".env", "scheduler.db"];
const RUNTIME_EXCLUDES = [
  "*.sock",
  "*.pid",
  "*.log",
  "output.log",
  "fleet.log",
  "node_modules",
];

// Reject tarballs above this size to blunt zip-bomb style exhaustion.
const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

export async function exportConfig(
  dataDir: string,
  outputPath: string | undefined,
  full: boolean
): Promise<void> {
  if (!existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}`);
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  const outFile = resolve(outputPath ?? `agend-export-${date}.tar.gz`);

  if (full) {
    const excludeArgs = RUNTIME_EXCLUDES.flatMap((p) => ["--exclude", p]);
    execFileSync("tar", [
      "czf", outFile, ...excludeArgs,
      "-C", join(dataDir, ".."), basename(dataDir),
    ], { stdio: "pipe" });
  } else {
    // Minimal: only config files that exist
    const existing = MINIMAL_FILES.filter((f) => existsSync(join(dataDir, f)));
    if (existing.length === 0) {
      console.error("No config files found to export.");
      process.exit(1);
    }
    const fileArgs = existing.map((f) => `${basename(dataDir)}/${f}`);
    execFileSync("tar", [
      "czf", outFile, "-C", join(dataDir, ".."), ...fileArgs,
    ], { stdio: "pipe" });
  }

  const size = statSync(outFile).size;
  const sizeStr =
    size < 1024
      ? `${size} B`
      : size < 1024 * 1024
        ? `${(size / 1024).toFixed(1)} KB`
        : `${(size / (1024 * 1024)).toFixed(1)} MB`;

  console.log(`Exported to: ${outFile} (${sizeStr})`);
  console.warn(
    "\n⚠️  This file contains secrets (bot token, API keys). Transfer securely."
  );
}

export async function importConfig(
  dataDir: string,
  filePath: string
): Promise<void> {
  const absFile = resolve(filePath);
  if (!existsSync(absFile)) {
    console.error(`File not found: ${absFile}`);
    process.exit(1);
  }

  // Size guard (zip-bomb style).
  const inputSize = statSync(absFile).size;
  if (inputSize > MAX_IMPORT_BYTES) {
    console.error(`Import file exceeds ${MAX_IMPORT_BYTES} bytes: ${inputSize}`);
    process.exit(1);
  }

  mkdirSync(dataDir, { recursive: true });

  // Zip-slip / absolute-path protection: list every entry in the archive and
  // verify the resolved path stays under dataDir's parent. Reject absolute
  // paths, `..` segments and entries that escape after path resolution.
  const extractRoot = resolve(join(dataDir, ".."));
  const expectedPrefix = resolve(dataDir) + pathSep;
  const expectedBase = basename(resolve(dataDir));
  let entries: string[];
  try {
    const { stdout } = {
      stdout: execFileSync("tar", ["tzf", absFile], { stdio: ["ignore", "pipe", "pipe"] }),
    };
    entries = stdout
      .toString("utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch (err) {
    console.error(`Failed to list archive contents: ${(err as Error).message}`);
    process.exit(1);
  }
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.includes("..")) {
      console.error(`Refusing to import archive with unsafe entry: ${entry}`);
      process.exit(1);
    }
    const dest = resolve(extractRoot, entry);
    // Each entry must land inside the target dataDir (same basename as export).
    // Allow the dataDir itself and anything beneath it.
    if (dest !== resolve(dataDir) && !dest.startsWith(expectedPrefix)) {
      console.error(`Refusing to import entry outside dataDir: ${entry}`);
      process.exit(1);
    }
    // First path component must match dataDir's basename (tar strips nothing
    // here — we rely on the export producing `basename(dataDir)/...`).
    const firstSeg = entry.split(/[\\/]/, 1)[0];
    if (firstSeg !== expectedBase) {
      console.error(`Refusing to import entry with unexpected root: ${entry}`);
      process.exit(1);
    }
  }

  // Backup existing config files
  const timestamp = Date.now();
  for (const name of ["fleet.yaml", ".env"]) {
    const target = join(dataDir, name);
    if (existsSync(target)) {
      const bakPath = `${target}.bak.${timestamp}`;
      copyFileSync(target, bakPath);
      console.log(`Backed up: ${name} → ${basename(bakPath)}`);
    }
  }

  // Extract — strip the top-level directory name.
  // `-P` is intentionally NOT used: we want tar's default behaviour of
  // rejecting absolute paths. The per-entry audit above already caught any
  // absolute or traversal entries.
  execFileSync("tar", ["xzf", absFile, "-C", extractRoot], { stdio: "pipe" });
  console.log(`Imported to: ${dataDir}`);

  // Validate paths in fleet.yaml
  const fleetPath = join(dataDir, "fleet.yaml");
  if (existsSync(fleetPath)) {
    const yaml = await import("js-yaml");
    const config = yaml.load(readFileSync(fleetPath, "utf-8")) as any;
    const missing: string[] = [];

    // Check project_roots
    if (Array.isArray(config?.project_roots)) {
      for (const root of config.project_roots) {
        const expanded = expandHome(root);
        if (!existsSync(expanded)) missing.push(expanded);
      }
    }

    // Check instance working directories
    if (config?.instances) {
      for (const [name, inst] of Object.entries<any>(config.instances)) {
        if (inst?.working_directory) {
          const expanded = expandHome(inst.working_directory);
          if (!existsSync(expanded)) missing.push(expanded);
        }
      }
    }

    if (missing.length > 0) {
      console.warn(`\n⚠️  The following paths in fleet.yaml do not exist on this device:`);
      for (const p of missing) {
        console.warn(`   • ${p}`);
      }
      console.warn(`\nEdit ${fleetPath} to fix these before running 'agend fleet start'.`);
    } else {
      console.log("\nAll paths in fleet.yaml verified.");
    }
  }
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
