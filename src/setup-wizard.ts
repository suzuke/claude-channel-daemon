import { createInterface } from "node:readline/promises";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { stdin, stdout } from "node:process";
import { execSync } from "node:child_process";

const DATA_DIR = join(homedir(), ".claude-channel-daemon");
const FLEET_CONFIG_PATH = join(DATA_DIR, "fleet.yaml");
const ENV_PATH = join(DATA_DIR, ".env");

// ── Helpers ──────────────────────────────────────────────

export function validateBotToken(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{30,}$/.test(token);
}

export async function verifyBotToken(
  token: string,
): Promise<{ valid: boolean; username: string | null }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (data.ok && data.result?.username) {
      return { valid: true, username: data.result.username };
    }
    return { valid: false, username: null };
  } catch {
    return { valid: false, username: null };
  }
}

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
function cyan(s: string): string {
  return `\x1b[36m${s}\x1b[0m`;
}

function step(n: number, total: number, label: string): void {
  console.log(`\n${cyan(`[${n}/${total}]`)} ${bold(label)}`);
}

/** Ask a question; retry until validator passes. Empty → default. */
async function ask(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  opts: {
    default?: string;
    validate?: (input: string) => string | null; // null = ok, string = error
  } = {},
): Promise<string> {
  const suffix = opts.default != null ? ` ${dim(`[${opts.default}]`)}` : "";
  for (;;) {
    const raw = await rl.question(`  ${prompt}${suffix}: `);
    const value = raw.trim() || opts.default || "";
    if (opts.validate) {
      const err = opts.validate(value);
      if (err) {
        console.log(`  ${red(err)}`);
        continue;
      }
    }
    return value;
  }
}

/** Ask a yes/no question. */
async function confirm(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  defaultYes = true,
): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const raw = await rl.question(`  ${prompt} (${hint}): `);
  const v = raw.trim().toLowerCase();
  if (v === "") return defaultYes;
  return v === "y" || v === "yes";
}

/** Ask user to pick from numbered options. Returns 0-based index. */
async function choose(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  options: { label: string; hint?: string }[],
  defaultIndex = 0,
): Promise<number> {
  console.log(`  ${prompt}`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIndex ? cyan("→") : " ";
    const hint = options[i].hint ? ` ${dim(options[i].hint!)}` : "";
    console.log(`  ${marker} ${i + 1}. ${options[i].label}${hint}`);
  }
  for (;;) {
    const raw = await rl.question(`  Pick ${dim(`[${defaultIndex + 1}]`)}: `);
    const v = raw.trim();
    if (v === "") return defaultIndex;
    const n = parseInt(v, 10);
    if (n >= 1 && n <= options.length) return n - 1;
    console.log(`  ${red(`Enter 1-${options.length}`)}`);
  }
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return resolve(p);
}

// ── Prerequisite checks ──────────────────────────────────

interface PrereqResult {
  claude: boolean;
  claudeVersion: string;
  tmux: boolean;
  tmuxVersion: string;
}

export function checkPrerequisites(): PrereqResult {
  let claude = false;
  let claudeVersion = "";
  let tmux = false;
  let tmuxVersion = "";

  try {
    claudeVersion = execSync("claude --version", { stdio: "pipe" }).toString().trim();
    claude = true;
  } catch { /* not installed */ }

  try {
    tmuxVersion = execSync("tmux -V", { stdio: "pipe" }).toString().trim();
    tmux = true;
  } catch { /* not installed */ }

  return { claude, claudeVersion, tmux, tmuxVersion };
}

// ── Main wizard ──────────────────────────────────────────

export async function runSetupWizard(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  console.log(`\n${bold("Claude Channel Daemon — Setup")}\n`);

  const TOTAL_STEPS = 8;

  // ── Step 1: Prerequisites ──
  step(1, TOTAL_STEPS, "Checking prerequisites");
  const prereq = checkPrerequisites();

  if (prereq.claude) {
    console.log(`  ${green("✓")} Claude Code ${dim(prereq.claudeVersion)}`);
  } else {
    console.log(`  ${red("✗")} Claude Code not found`);
    console.log(`    Install: ${dim("https://docs.anthropic.com/en/docs/claude-code")}`);
    rl.close();
    process.exit(1);
  }

  if (prereq.tmux) {
    console.log(`  ${green("✓")} tmux ${dim(prereq.tmuxVersion)}`);
  } else {
    console.log(`  ${red("✗")} tmux not found`);
    console.log(`    macOS: ${dim("brew install tmux")}`);
    console.log(`    Linux: ${dim("apt install tmux / dnf install tmux")}`);
    rl.close();
    process.exit(1);
  }

  // Detect existing config
  if (existsSync(FLEET_CONFIG_PATH)) {
    console.log(`\n  ${yellow("⚠")} Existing config found: ${dim(FLEET_CONFIG_PATH)}`);
    const overwrite = await confirm(rl, "Overwrite with new config?", false);
    if (!overwrite) {
      console.log("  Setup cancelled.");
      rl.close();
      return;
    }
  }

  // ── Step 2: Bot token ──
  step(2, TOTAL_STEPS, "Telegram Bot Token");
  console.log(`  ${dim("Get one from @BotFather on Telegram")}`);

  // Check if env var already set
  let tokenEnvName = "CCD_BOT_TOKEN";
  let token = "";
  let botUsername = "";

  // Check existing .env for token
  if (existsSync(ENV_PATH)) {
    const envContent = readFileSync(ENV_PATH, "utf-8");
    const match = envContent.match(/^([A-Z_]+)=(\d+:[A-Za-z0-9_-]{30,})/m);
    if (match) {
      const maskedToken = match[2].slice(0, 10) + "...";
      console.log(`  ${dim(`Found existing token in .env: ${match[1]}=${maskedToken}`)}`);
      const reuse = await confirm(rl, "Use existing token?");
      if (reuse) {
        tokenEnvName = match[1];
        token = match[2];
      }
    }
  }

  if (!token) {
    token = await ask(rl, "Bot Token", {
      validate: (v) => validateBotToken(v) ? null : "Invalid format. Expected: 123456789:ABC...",
    });
  }

  console.log(`  Verifying with Telegram API...`);
  const verification = await verifyBotToken(token);
  if (!verification.valid) {
    console.log(`  ${red("✗")} Token rejected by Telegram. Check your token.`);
    rl.close();
    process.exit(1);
  }
  botUsername = verification.username!;
  console.log(`  ${green("✓")} @${botUsername}`);

  tokenEnvName = await ask(rl, "Env variable name for token", {
    default: tokenEnvName,
    validate: (v) => /^[A-Z_][A-Z0-9_]*$/.test(v) ? null : "Must be uppercase with underscores (e.g., CCD_BOT_TOKEN)",
  });

  // ── Step 3: Mode ──
  step(3, TOTAL_STEPS, "Channel Mode");
  const modeIndex = await choose(
    rl,
    "How will this bot serve your projects?",
    [
      { label: "Topic mode", hint: "1 group, N forum topics = N projects (recommended)" },
      { label: "DM mode", hint: "1 bot = 1 project, direct messages" },
    ],
    0,
  );
  const mode = modeIndex === 0 ? "topic" : "dm";

  let groupId: number | undefined;
  if (mode === "topic") {
    console.log();
    console.log(`  ${dim("To get the group ID:")}`);
    console.log(`  ${dim("1. Add the bot to a Telegram group with Forum Topics enabled")}`);
    console.log(`  ${dim("2. Send a message in the group")}`);
    console.log(`  ${dim("3. Forward it to @userinfobot or check the update JSON")}`);
    console.log(`  ${dim("   Group IDs are negative numbers, e.g., -1001234567890")}`);
    console.log();

    const gidStr = await ask(rl, "Group ID", {
      validate: (v) => {
        const n = parseInt(v, 10);
        if (isNaN(n)) return "Must be a number";
        if (n >= 0) return "Group IDs are negative (e.g., -1001234567890)";
        return null;
      },
    });
    groupId = parseInt(gidStr, 10);
  }

  // ── Step 4: Access control ──
  step(4, TOTAL_STEPS, "Access Control");
  const accessIndex = await choose(
    rl,
    "Who can interact with the bot?",
    [
      { label: "Locked", hint: "only whitelisted Telegram user IDs" },
      { label: "Pairing", hint: "anyone with a pairing code can join" },
    ],
    0,
  );
  const accessMode = accessIndex === 0 ? "locked" : "pairing";

  const allowedUsers: number[] = [];
  if (accessMode === "locked") {
    console.log();
    console.log(`  ${dim("Your Telegram user ID — send /start to @userinfobot to find it")}`);
    const uidStr = await ask(rl, "Your Telegram user ID", {
      validate: (v) => {
        const n = parseInt(v, 10);
        return isNaN(n) || n <= 0 ? "Must be a positive number" : null;
      },
    });
    allowedUsers.push(parseInt(uidStr, 10));

    let addMore = await confirm(rl, "Add another user?", false);
    while (addMore) {
      const uid = await ask(rl, "User ID", {
        validate: (v) => {
          const n = parseInt(v, 10);
          return isNaN(n) || n <= 0 ? "Must be a positive number" : null;
        },
      });
      allowedUsers.push(parseInt(uid, 10));
      addMore = await confirm(rl, "Add another user?", false);
    }
  }

  // ── Step 5: Project roots ──
  step(5, TOTAL_STEPS, "Project Roots");
  console.log(`  ${dim("Directories containing your projects (for auto-bind browsing)")}`);
  console.log(`  ${dim("When a new topic is created, the bot shows projects from these dirs")}`);
  console.log();

  const projectRoots: string[] = [];
  let addRoot = true;
  while (addRoot) {
    const root = await ask(rl, projectRoots.length === 0 ? "Project root" : "Another root", {
      default: projectRoots.length === 0 ? "~/Projects" : undefined,
      validate: (v) => {
        const expanded = expandHome(v);
        if (!existsSync(expanded)) return `Directory not found: ${expanded}`;
        return null;
      },
    });
    // Store with ~ for readability
    const expanded = expandHome(root);
    const homePrefix = homedir();
    const display = expanded.startsWith(homePrefix)
      ? "~" + expanded.slice(homePrefix.length)
      : expanded;
    projectRoots.push(display);
    console.log(`  ${green("+")} ${display}`);
    addRoot = await confirm(rl, "Add another root?", false);
  }

  // ── Step 6: Initial instance ──
  step(6, TOTAL_STEPS, "Initial Instances");
  if (mode === "topic") {
    console.log(`  ${dim("In topic mode, instances auto-bind to new forum topics.")}`);
    console.log(`  ${dim("You can pre-configure instances now, or let the bot handle it.")}`);
  }

  const instances: { name: string; workDir: string; topicId?: number }[] = [];

  const addInstance = await confirm(rl, "Pre-configure an instance now?", false);
  if (addInstance) {
    let more = true;
    while (more) {
      const name = await ask(rl, "Instance name", {
        validate: (v) => {
          if (v.length === 0) return "Name required";
          if (!/^[a-zA-Z0-9._-]+$/.test(v) && !/^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(v)) {
            // Allow alphanumeric, dots, hyphens, underscores, or CJK chars
          }
          if (instances.some((i) => i.name === v)) return "Name already used";
          return null;
        },
      });

      const workDir = await ask(rl, "Working directory", {
        validate: (v) => {
          const expanded = expandHome(v);
          if (!existsSync(expanded)) {
            return `Not found: ${expanded} — create it first or auto-create on bind`;
          }
          return null;
        },
      });

      let topicId: number | undefined;
      if (mode === "topic") {
        const tid = await ask(rl, "Topic ID (leave empty to auto-bind later)", {
          default: "",
        });
        if (tid) topicId = parseInt(tid, 10);
      }

      const expanded = expandHome(workDir);
      instances.push({ name, workDir: expanded, topicId });
      console.log(`  ${green("+")} ${name} → ${expanded}${topicId ? ` (topic #${topicId})` : ""}`);
      more = await confirm(rl, "Add another instance?", false);
    }
  }

  // ── Step 7: Fleet Defaults ──
  step(7, TOTAL_STEPS, "Fleet Defaults");

  let costGuardLimit = 0;
  let costGuardTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const enableCostGuard = await confirm(rl, "Enable cost guard (daily spending limit)?", false);
  if (enableCostGuard) {
    const limitStr = await ask(rl, "Daily limit (USD)", {
      default: "50",
      validate: (v) => {
        const n = parseFloat(v);
        return isNaN(n) || n <= 0 ? "Must be a positive number" : null;
      },
    });
    costGuardLimit = parseFloat(limitStr);
    costGuardTimezone = await ask(rl, "Timezone", {
      default: costGuardTimezone,
      validate: (v) => {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: v });
          return null;
        } catch {
          return `Invalid timezone: "${v}". Use IANA format (e.g. Asia/Taipei, America/New_York)`;
        }
      },
    });
  }

  let dailySummaryHour = 21;
  const enableSummary = await confirm(rl, "Enable daily summary report?", true);
  if (enableSummary) {
    const hourStr = await ask(rl, "Summary hour (0-23, local time)", {
      default: "21",
      validate: (v) => {
        const n = parseInt(v, 10);
        return isNaN(n) || n < 0 || n > 23 ? "Must be 0-23" : null;
      },
    });
    dailySummaryHour = parseInt(hourStr, 10);
  }

  // ── Step 8: Summary ──
  step(8, TOTAL_STEPS, "Summary");
  console.log();
  console.log(`  ${bold("Bot:")}        @${botUsername}`);
  console.log(`  ${bold("Token env:")}  ${tokenEnvName}`);
  console.log(`  ${bold("Mode:")}       ${mode}${groupId ? ` (group: ${groupId})` : ""}`);
  console.log(`  ${bold("Access:")}     ${accessMode}${allowedUsers.length > 0 ? ` — users: ${allowedUsers.join(", ")}` : ""}`);
  console.log(`  ${bold("Roots:")}      ${projectRoots.join(", ") || dim("(none)")}`);
  if (instances.length > 0) {
    console.log(`  ${bold("Instances:")}`);
    for (const inst of instances) {
      console.log(`    ${inst.name} → ${inst.workDir}${inst.topicId ? ` #${inst.topicId}` : ""}`);
    }
  } else {
    console.log(`  ${bold("Instances:")}  ${dim("(none — will auto-create from topics)")}`);
  }
  if (costGuardLimit > 0) {
    console.log(`  ${bold("Cost guard:")} $${costGuardLimit}/day (${costGuardTimezone})`);
  } else {
    console.log(`  ${bold("Cost guard:")} ${dim("disabled")}`);
  }
  console.log(`  ${bold("Daily sum.:")} ${enableSummary ? `${dailySummaryHour}:00` : dim("disabled")}`);
  console.log();

  const proceed = await confirm(rl, "Write config?");
  if (!proceed) {
    console.log("  Setup cancelled.");
    rl.close();
    return;
  }

  // ── Write files ──
  mkdirSync(DATA_DIR, { recursive: true });

  // .env — merge with existing, don't clobber other vars
  let envContent = "";
  if (existsSync(ENV_PATH)) {
    envContent = readFileSync(ENV_PATH, "utf-8");
    // Remove old token line with same env name
    envContent = envContent
      .split("\n")
      .filter((line) => !line.startsWith(`${tokenEnvName}=`))
      .join("\n");
    if (envContent && !envContent.endsWith("\n")) envContent += "\n";
  }
  envContent += `${tokenEnvName}=${token}\n`;
  writeFileSync(ENV_PATH, envContent);
  console.log(`  ${green("✓")} ${ENV_PATH}`);

  // fleet.yaml
  const yaml = await import("js-yaml");
  const fleetData: Record<string, unknown> = {};

  if (projectRoots.length > 0) {
    fleetData.project_roots = projectRoots;
  }

  fleetData.channel = {
    type: "telegram",
    mode,
    bot_token_env: tokenEnvName,
    ...(groupId != null ? { group_id: groupId } : {}),
    access: {
      mode: accessMode,
      ...(allowedUsers.length > 0 ? { allowed_users: allowedUsers } : {}),
    },
  };

  fleetData.defaults = {
    restart_policy: {
      max_retries: 10,
      backoff: "exponential",
      reset_after: 300,
    },
    context_guardian: {
      threshold_percentage: 40,
      max_age_hours: 8,
      strategy: "hybrid",
    },
    memory: {
      watch_memory_dir: true,
      backup_to_sqlite: true,
    },
    log_level: "info",
    ...(costGuardLimit > 0 ? {
      cost_guard: {
        daily_limit_usd: costGuardLimit,
        warn_at_percentage: 80,
        timezone: costGuardTimezone,
      },
    } : {}),
    ...(enableSummary ? {
      daily_summary: {
        enabled: true,
        hour: dailySummaryHour,
        minute: 0,
      },
    } : {}),
  };

  const instancesObj: Record<string, Record<string, unknown>> = {};
  for (const inst of instances) {
    instancesObj[inst.name] = {
      working_directory: inst.workDir,
      ...(inst.topicId != null ? { topic_id: inst.topicId } : {}),
    };
  }
  fleetData.instances = instancesObj;

  writeFileSync(FLEET_CONFIG_PATH, yaml.dump(fleetData, { lineWidth: 120 }));
  console.log(`  ${green("✓")} ${FLEET_CONFIG_PATH}`);

  // ── System service (optional) ──
  console.log();
  const installSvc = await confirm(rl, "Install as system service?", false);
  if (installSvc) {
    const { installService, detectPlatform } = await import("./service-installer.js");
    const svcPath = installService({
      label: "com.ccd.fleet",
      execPath: process.argv[1],
      workingDirectory: DATA_DIR,
      logPath: join(DATA_DIR, "fleet.log"),
    });
    console.log(`  ${green("✓")} ${svcPath}`);
    const plat = detectPlatform();
    if (plat === "macos") {
      console.log(`  Run: ${dim(`launchctl load ${svcPath}`)}`);
    } else {
      console.log(`  Run: ${dim("systemctl --user enable --now ccd")}`);
    }
  }

  // ── Done ──
  console.log(`\n${green("✓")} ${bold("Setup complete!")}`);
  console.log(`  Bot: @${botUsername}`);
  console.log(`  Config: ${FLEET_CONFIG_PATH}`);
  console.log();
  console.log(`  Start the fleet:`);
  console.log(`    ${dim("ccd fleet start")}`);
  if (mode === "topic") {
    console.log();
    console.log(`  ${dim("Create a new topic in the group — the bot will auto-detect it")}`);
    console.log(`  ${dim("and let you bind it to a project.")}`);
  }
  console.log();

  rl.close();
}
