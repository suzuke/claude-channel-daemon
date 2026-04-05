import { createInterface } from "node:readline/promises";
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { stdin, stdout } from "node:process";
import { execSync } from "node:child_process";
import { BACKENDS, validateBotToken, verifyBotToken } from "./setup-wizard.js";

const DATA_DIR = join(homedir(), ".agend");
const FLEET_CONFIG_PATH = join(DATA_DIR, "fleet.yaml");
const ENV_PATH = join(DATA_DIR, ".env");

// ── ANSI helpers ─────────────────────────────────────────

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

// ── Backend detection ────────────────────────────────────

function detectBackends(): typeof BACKENDS {
  return BACKENDS.filter(b => {
    try {
      execSync(`which ${b.binary}`, { stdio: "pipe" });
      return true;
    } catch { return false; }
  });
}

// ── Group + User ID auto-detect via Telegram polling ─────

const DETECT_TIMEOUT = 3 * 60_000;

async function detectGroupAndUser(
  token: string,
): Promise<{ groupId: number; userId: number }> {
  const api = `https://api.telegram.org/bot${token}`;
  let offset = 0;
  const start = Date.now();

  // Consume stale updates first
  try {
    const stale = await fetch(`${api}/getUpdates?offset=-1&timeout=0`);
    const data = (await stale.json()) as { result?: { update_id: number }[] };
    if (data.result?.length) offset = data.result[data.result.length - 1].update_id + 1;
  } catch { /* ignore */ }

  while (Date.now() - start < DETECT_TIMEOUT) {
    process.stdout.write(`  Waiting for message... ${dim("(Ctrl+C to cancel)")}\r`);
    const res = await fetch(`${api}/getUpdates?offset=${offset}&timeout=30`);
    const data = (await res.json()) as {
      result?: {
        update_id: number;
        message?: { chat: { id: number; type: string }; from?: { id: number } };
      }[];
    };
    for (const update of data.result ?? []) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (msg?.chat?.type === "supergroup" || msg?.chat?.type === "group") {
        if (msg.from?.id) {
          process.stdout.write("\x1b[2K"); // clear line
          return { groupId: msg.chat.id, userId: msg.from.id };
        }
      }
    }
  }
  throw new Error("Timed out (3 min). Please run `agend quickstart` again.");
}

// ── Project roots detection ──────────────────────────────

function detectProjectRoots(): { path: string; gitCount: number }[] {
  const home = homedir();
  const candidates = platform() === "darwin"
    ? ["Documents", "Projects", "Developer"]
    : ["projects", "src", "workspace", "code"];

  const results: { path: string; gitCount: number }[] = [];
  for (const name of candidates) {
    const dir = join(home, name);
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      const gitCount = entries.filter(e => {
        try { return statSync(join(dir, e, ".git")).isDirectory(); } catch { return false; }
      }).length;
      results.push({ path: dir, gitCount });
    } catch { continue; }
  }
  results.sort((a, b) => b.gitCount - a.gitCount);
  return results;
}

// ── Main ─────────────────────────────────────────────────

export async function runQuickstart(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    console.log(`\n${bold("═══ AgEnD Quickstart ═══")}\n`);

    // Check fleet.pid conflict
    if (existsSync(join(DATA_DIR, "fleet.pid"))) {
      console.error("Fleet is already running. Stop it first: agend fleet stop");
      process.exit(1);
    }

    // Check existing config
    if (existsSync(FLEET_CONFIG_PATH)) {
      const overwrite = await rl.question(
        `  ${yellow("fleet.yaml already exists.")} Overwrite? [y/N] `,
      );
      if (overwrite.toLowerCase() !== "y") {
        console.log("  Aborted.");
        return;
      }
    }

    // Check tmux
    try {
      execSync("which tmux", { stdio: "pipe" });
    } catch {
      console.error("tmux is required. Install: brew install tmux (macOS) or apt install tmux (Linux)");
      process.exit(1);
    }

    // ── Step 1: Backend ──────────────────────────────────

    console.log(bold("Step 1/3: Backend"));
    const found = detectBackends();

    let backend: string;
    if (found.length === 0) {
      console.log(`  No supported backend found in PATH.`);
      console.log(`  Install Claude Code: ${dim("curl -fsSL https://claude.ai/install.sh | bash")}`);
      process.exit(1);
    } else if (found.length === 1) {
      backend = found[0].id;
      console.log(`  ${green("✓")} Detected: ${found[0].label} ${dim(`(${found[0].binary})`)}`);
    } else {
      console.log("  Multiple backends detected:");
      for (let i = 0; i < found.length; i++) {
        console.log(`    ${i + 1}. ${found[i].label} ${dim(`(${found[i].binary})`)}`);
      }
      const choice = await rl.question(`  Choose [1]: `);
      const idx = Math.max(0, Math.min(found.length - 1, parseInt(choice || "1", 10) - 1));
      backend = found[idx].id;
      console.log(`  ${green("✓")} Selected: ${found[idx].label}`);
    }

    // ── Step 2: Bot Token ────────────────────────────────

    console.log(`\n${bold("Step 2/3: Telegram Bot")}`);
    console.log(`  1. Open BotFather: ${dim("https://t.me/BotFather")}`);
    console.log(`  2. Send /newbot and pick a name`);
    console.log(`  3. Copy the token\n`);

    let token = "";
    let botUsername = "";
    while (true) {
      token = (await rl.question("  Paste token: ")).trim();
      if (!validateBotToken(token)) {
        console.log(`  ${yellow("Invalid format.")} Should look like: 123456789:ABCdef...`);
        continue;
      }
      const result = await verifyBotToken(token);
      if (!result.valid) {
        console.log(`  ${yellow("Token rejected by Telegram.")} Try again.`);
        continue;
      }
      botUsername = result.username ?? "";
      console.log(`  ${green("✓")} Bot verified: @${botUsername}\n`);
      break;
    }

    // ── Step 3: Group + User ID ──────────────────────────

    console.log(bold("Step 3/3: Group & User ID"));
    console.log(`  Add @${botUsername} to a Telegram group, then send /start in the group.\n`);

    const { groupId, userId } = await detectGroupAndUser(token);
    console.log(`  ${green("✓")} Group: ${groupId} | User: ${userId}\n`);

    // ── Project roots ────────────────────────────────────

    const roots = detectProjectRoots();
    let projectRoots: string[] = [];
    if (roots.length > 0) {
      console.log("  Detected project directories:");
      for (const r of roots) {
        console.log(`    ${r.path} ${dim(`(${r.gitCount} git repos)`)}`);
      }
      const best = roots[0];
      const confirm = await rl.question(`\n  Use ${best.path}? [Y/n] `);
      if (confirm.toLowerCase() !== "n") {
        projectRoots = [best.path];
        console.log(`  ${green("✓")} ${best.path}`);
      }
    }

    // ── Write config ─────────────────────────────────────

    mkdirSync(DATA_DIR, { recursive: true });

    const fleetYaml = [
      "channel:",
      "  type: telegram",
      "  mode: topic",
      "  bot_token_env: AGEND_BOT_TOKEN",
      `  group_id: ${groupId}`,
      "  access:",
      "    mode: locked",
      "    allowed_users:",
      `      - ${userId}`,
      "",
      ...(projectRoots.length > 0
        ? ["project_roots:", ...projectRoots.map(p => `  - ${p}`), ""]
        : []),
      "defaults:",
      `  backend: ${backend}`,
      "",
    ].join("\n");

    writeFileSync(FLEET_CONFIG_PATH, fleetYaml);
    console.log(`\n  ${green("✓")} ${FLEET_CONFIG_PATH}`);

    writeFileSync(ENV_PATH, `AGEND_BOT_TOKEN=${token}\n`);
    console.log(`  ${green("✓")} ${ENV_PATH}`);

    // ── Next steps ───────────────────────────────────────

    console.log(`\n${bold("═══ Setup Complete ═══")}\n`);
    console.log("  Next steps:");
    console.log(`    1. ${dim("(Optional)")} Edit ~/.agend/fleet.yaml to customize`);
    console.log(`    2. ${bold("agend fleet start")}`);
    console.log(`    3. Talk to @${botUsername} in your Telegram group\n`);
  } finally {
    rl.close();
  }
}
