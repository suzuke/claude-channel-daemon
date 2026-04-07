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

// ── Discord bot verification ─────────────────────────────

async function verifyDiscordToken(token: string): Promise<{ valid: boolean; username: string | null }> {
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) return { valid: false, username: null };
    const data = (await res.json()) as { username?: string };
    return { valid: true, username: data.username ?? null };
  } catch { return { valid: false, username: null }; }
}

async function listDiscordGuilds(token: string): Promise<{ id: string; name: string }[]> {
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) return [];
    return (await res.json()) as { id: string; name: string }[];
  } catch { return []; }
}

// ── Telegram group + user detection ──────────────────────

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

    // ── Step 2: Channel ────────────────────────────────

    console.log(`\n${bold("Step 2/4: Channel")}`);
    console.log("    1. Telegram");
    console.log("    2. Discord");
    const chChoice = await rl.question(`  Choose [1]: `);
    const channel = chChoice.trim() === "2" ? "discord" : "telegram";
    console.log(`  ${green("✓")} ${channel}\n`);

    let token = "";
    let botUsername = "";
    let groupId = "";
    let userId = "";
    let tokenEnvName = "";

    if (channel === "telegram") {
      // ── Telegram flow ──────────────────────────────────

      console.log(bold("Step 3/4: Telegram Bot"));
      console.log(`  1. Open BotFather: ${dim("https://t.me/BotFather")}`);
      console.log(`  2. Send /newbot and pick a name`);
      console.log(`  3. Copy the token\n`);

      tokenEnvName = "AGEND_BOT_TOKEN";
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

      console.log(bold("Step 4/4: Group & User ID"));
      console.log(`  Add @${botUsername} to a Telegram group, then send /start in the group.\n`);

      const detected = await detectGroupAndUser(token);
      groupId = String(detected.groupId);
      userId = String(detected.userId);
      console.log(`  ${green("✓")} Group: ${groupId} | User: ${userId}\n`);

    } else {
      // ── Discord flow ───────────────────────────────────

      console.log(bold("Step 3/4: Discord Bot"));
      console.log(`  1. Go to Discord Developer Portal: ${dim("https://discord.com/developers/applications")}`);
      console.log(`  2. New Application → Bot → Reset Token → Copy`);
      console.log(`  3. Enable ${bold("Message Content Intent")} under Bot → Privileged Gateway Intents\n`);

      tokenEnvName = "AGEND_DISCORD_TOKEN";
      while (true) {
        token = (await rl.question("  Paste bot token: ")).trim();
        if (!token) continue;
        const result = await verifyDiscordToken(token);
        if (!result.valid) {
          console.log(`  ${yellow("Token rejected by Discord.")} Try again.`);
          continue;
        }
        botUsername = result.username ?? "";
        console.log(`  ${green("✓")} Bot verified: ${botUsername}\n`);
        break;
      }

      console.log(bold("Step 4/4: Guild & User ID"));

      // Auto-detect guilds
      const guilds = await listDiscordGuilds(token);
      if (guilds.length === 0) {
        console.log(`  Bot is not in any server. Invite it first:`);
        console.log(`  ${dim("https://discord.com/developers/applications → OAuth2 → URL Generator")}`);
        console.log(`  Scopes: bot | Permissions: Send Messages, Read Message History, Manage Channels\n`);
        groupId = (await rl.question("  Paste Guild ID: ")).trim();
      } else if (guilds.length === 1) {
        groupId = guilds[0].id;
        console.log(`  ${green("✓")} Guild: ${guilds[0].name} (${groupId})`);
      } else {
        console.log("  Bot is in multiple servers:");
        for (let i = 0; i < guilds.length; i++) {
          console.log(`    ${i + 1}. ${guilds[i].name} ${dim(`(${guilds[i].id})`)}`);
        }
        const gChoice = await rl.question(`  Choose [1]: `);
        const gIdx = Math.max(0, Math.min(guilds.length - 1, parseInt(gChoice || "1", 10) - 1));
        groupId = guilds[gIdx].id;
        console.log(`  ${green("✓")} Guild: ${guilds[gIdx].name}`);
      }

      console.log(`\n  To get your User ID:`);
      console.log(`  Discord Settings → Advanced → ${bold("Developer Mode")} ON → Right-click yourself → Copy User ID\n`);
      userId = (await rl.question("  Paste your User ID: ")).trim();
      console.log(`  ${green("✓")} User: ${userId}\n`);
    }

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

    // Quote IDs that may be snowflakes (Discord 64-bit)
    const qGid = groupId.length >= 16 ? `"${groupId}"` : groupId;
    const qUid = userId.length >= 16 ? `"${userId}"` : userId;

    const fleetYaml = [
      "channel:",
      `  type: ${channel}`,
      "  mode: topic",
      `  bot_token_env: ${tokenEnvName}`,
      `  group_id: ${qGid}`,
      "  access:",
      "    mode: locked",
      "    allowed_users:",
      `      - ${qUid}`,
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

    writeFileSync(ENV_PATH, `${tokenEnvName}=${token}\n`);
    console.log(`  ${green("✓")} ${ENV_PATH}`);

    // ── Next steps ───────────────────────────────────────

    console.log(`\n${bold("═══ Setup Complete ═══")}\n`);
    if (channel === "discord") {
      console.log("  Next steps:");
      console.log(`    1. ${bold("npm install -g @suzuke/agend-plugin-discord")}`);
      console.log(`    2. ${dim("(Optional)")} Edit ~/.agend/fleet.yaml to customize`);
      console.log(`    3. ${bold("agend fleet start")}`);
      console.log(`    4. Talk to ${botUsername} in your Discord server\n`);
    } else {
      console.log("  Next steps:");
      console.log(`    1. ${dim("(Optional)")} Edit ~/.agend/fleet.yaml to customize`);
      console.log(`    2. ${bold("agend fleet start")}`);
      console.log(`    3. Talk to @${botUsername} in your Telegram group\n`);
    }
  } finally {
    rl.close();
  }
}
