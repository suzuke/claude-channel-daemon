import { createInterface } from "node:readline/promises";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { stdin, stdout } from "node:process";
import { execSync } from "node:child_process";

const DATA_DIR = join(homedir(), ".agend");
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

// ── Config builder (pure, testable) ─────────────────────

export interface WizardAnswers {
  backend: string;
  botTokenEnv: string;
  groupId?: number;
  channelMode: string;
  accessMode: "locked" | "pairing";
  allowedUsers: (number | string)[];
  projectRoots: string[];
  instances: Array<{ name: string; workDir: string; topicId?: string | number }>;
  costGuard: { enabled: boolean; dailyLimitUsd?: number; timezone?: string };
  dailySummary: { enabled: boolean; hour?: number };
}

export function buildFleetConfig(answers: WizardAnswers): Record<string, unknown> {
  const fleetData: Record<string, unknown> = {};

  if (answers.projectRoots.length > 0) {
    fleetData.project_roots = answers.projectRoots;
  }

  fleetData.channel = {
    type: "telegram",
    mode: answers.channelMode,
    bot_token_env: answers.botTokenEnv,
    ...(answers.groupId != null ? { group_id: answers.groupId } : {}),
    access: {
      mode: answers.accessMode,
      ...(answers.allowedUsers.length > 0 ? { allowed_users: answers.allowedUsers } : {}),
    },
  };

  fleetData.defaults = {
    ...(answers.backend !== "claude-code" ? { backend: answers.backend } : {}),
    restart_policy: {
      max_retries: 10,
      backoff: "exponential",
      reset_after: 300,
    },
    log_level: "info",
    ...(answers.costGuard.enabled && answers.costGuard.dailyLimitUsd ? {
      cost_guard: {
        daily_limit_usd: answers.costGuard.dailyLimitUsd,
        warn_at_percentage: 80,
        timezone: answers.costGuard.timezone ?? "UTC",
      },
    } : {}),
    ...(answers.dailySummary.enabled ? {
      daily_summary: {
        enabled: true,
        hour: answers.dailySummary.hour ?? 21,
        minute: 0,
      },
    } : {}),
  };

  const instancesObj: Record<string, Record<string, unknown>> = {};
  for (const inst of answers.instances) {
    instancesObj[inst.name] = {
      working_directory: inst.workDir,
      ...(inst.topicId != null ? { topic_id: inst.topicId } : {}),
    };
  }
  fleetData.instances = instancesObj;

  return fleetData;
}

// ── Prerequisite checks ──────────────────────────────────

export const BACKENDS = [
  { id: "claude-code", binary: "claude", label: "Claude Code",
    installUrl: "https://code.claude.com/docs/en/quickstart",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    auth: "claude (OAuth) or set ANTHROPIC_API_KEY" },
  { id: "codex", binary: "codex", label: "OpenAI Codex",
    installUrl: "https://developers.openai.com/codex/quickstart",
    install: "npm i -g @openai/codex",
    auth: "codex (ChatGPT login) or set OPENAI_API_KEY" },
  { id: "gemini-cli", binary: "gemini", label: "Gemini CLI",
    installUrl: "https://github.com/google-gemini/gemini-cli",
    install: "npm i -g @google/gemini-cli",
    auth: "gemini (Google OAuth)" },
  { id: "opencode", binary: "opencode", label: "OpenCode",
    installUrl: "https://opencode.ai/download",
    install: "curl -fsSL https://opencode.ai/install | bash",
    auth: "opencode (configure provider)" },
  { id: "kiro-cli", binary: "kiro-cli", label: "Kiro CLI",
    installUrl: "https://kiro.dev/docs/cli/",
    install: "brew install --cask kiro-cli",
    auth: "kiro-cli login (AWS Builder ID)" },
];

interface PrereqResult {
  backendOk: boolean;
  backendVersion: string;
  tmux: boolean;
  tmuxVersion: string;
}

export function checkPrerequisites(binary: string): PrereqResult {
  let backendOk = false;
  let backendVersion = "";
  let tmux = false;
  let tmuxVersion = "";

  try {
    backendVersion = execSync(`${binary} --version`, { stdio: "pipe" }).toString().trim();
    backendOk = true;
  } catch { /* not installed */ }

  try {
    tmuxVersion = execSync("tmux -V", { stdio: "pipe" }).toString().trim();
    tmux = true;
  } catch { /* not installed */ }

  return { backendOk, backendVersion, tmux, tmuxVersion };
}

// ── Main wizard ──────────────────────────────────────────

export async function runSetupWizard(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  console.log(`\n${bold("AgEnD — Setup Wizard")}\n`);

  const TOTAL_STEPS = 9;

  // ── Step 1: Backend + Prerequisites ──
  step(1, TOTAL_STEPS, "Backend & Prerequisites");

  const backendIdx = await choose(
    rl,
    "Which AI coding agent?",
    BACKENDS.map(b => ({ label: b.label, hint: b.binary })),
    0,
  );
  const selectedBackend = BACKENDS[backendIdx];

  const prereq = checkPrerequisites(selectedBackend.binary);

  if (prereq.backendOk) {
    console.log(`  ${green("✓")} ${selectedBackend.label} ${dim(prereq.backendVersion)}`);
  } else {
    console.log(`  ${red("✗")} ${selectedBackend.label} (${selectedBackend.binary}) not found`);
    console.log();
    console.log(`  ${bold(`Prerequisites for ${selectedBackend.label}:`)}`);
    console.log(`  ${dim("1. Install:")} ${selectedBackend.install}`);
    console.log(`  ${dim("2. Auth:")}    ${selectedBackend.auth}`);
    console.log(`  ${dim("3. Verify:")}  ${selectedBackend.binary} --version`);
    console.log();
    console.log(`  ${dim(`More info: ${selectedBackend.installUrl}`)}`);
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
  let tokenEnvName = "AGEND_BOT_TOKEN";
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
    validate: (v) => /^[A-Z_][A-Z0-9_]*$/.test(v) ? null : "Must be uppercase with underscores (e.g., AGEND_BOT_TOKEN)",
  });

  console.log();
  console.log(`  ${yellow("⚠")}  Only one service can poll a bot token at a time.`);
  console.log(`     ${dim("If this bot is also used by Claude Code's --channels telegram")}`);
  console.log(`     ${dim("plugin or any other polling service, stop it first.")}`);
  console.log(`     ${dim("Otherwise AgEnD will not receive messages.")}`);

  // ── Step 3: Mode ──
  step(3, TOTAL_STEPS, "Channel Mode");
  const mode = "topic";

  let groupId: number | undefined;
  {
    console.log();
    console.log(`  ${dim("To get the group ID:")}`);
    console.log(`  ${dim("1. Add the bot to a Telegram group with Forum Topics enabled")}`);
    console.log(`  ${dim("2. Send a message in the group")}`);
    console.log(`  ${dim("3. Open https://api.telegram.org/bot<TOKEN>/getUpdates")}`);
    console.log(`  ${dim("   Find \"chat\":{\"id\":-100...} in the response")}`);
    console.log(`  ${dim("   Or: add @getidsbot to the group")}`);
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
  const accessMode = "locked";

  console.log(`  ${dim("Only whitelisted Telegram user IDs can interact with the bot.")}`);
  console.log(`  ${dim("You can add more users later with: agend access add <user-id>")}`);
  console.log();
  console.log(`  ${dim("Your Telegram user ID — send /start to @userinfobot or @getidsbot")}`);

  const allowedUsers: (number | string)[] = [];
  const uidStr = await ask(rl, "Your Telegram user ID", {
    validate: (v) => {
      const n = parseInt(v, 10);
      return isNaN(n) || n <= 0 ? "Must be a positive number" : null;
    },
  });
  allowedUsers.push(uidStr);

  let addMore = await confirm(rl, "Add another user?", false);
  while (addMore) {
    const uid = await ask(rl, "User ID", {
      validate: (v) => {
        const n = parseInt(v, 10);
        return isNaN(n) || n <= 0 ? "Must be a positive number" : null;
      },
    });
    allowedUsers.push(uid);
    addMore = await confirm(rl, "Add another user?", false);
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

  const instances: { name: string; workDir: string; topicId?: number | string }[] = [];

  const addInstance = await confirm(rl, "Pre-configure an instance now?", false);
  if (addInstance) {
    let more = true;
    while (more) {
      const name = await ask(rl, "Instance name", {
        validate: (v) => {
          if (v.length === 0) return "Name required";
          if (!/^[a-zA-Z0-9._-]+$/.test(v) && !/^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(v)) {
            return "Name must be alphanumeric (a-z, 0-9, ., -, _) or CJK characters";
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

      let topicId: number | string | undefined;
      if (mode === "topic") {
        const tid = await ask(rl, "Topic ID (leave empty to auto-bind later)", {
          default: "",
        });
        if (tid) topicId = tid;
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

  // ── Step 8: Voice Transcription (Groq) ──
  step(8, TOTAL_STEPS, "Voice Transcription");
  let groqApiKey = "";

  // Check existing .env for GROQ_API_KEY
  if (existsSync(ENV_PATH)) {
    const existingEnv = readFileSync(ENV_PATH, "utf-8");
    const groqMatch = existingEnv.match(/^GROQ_API_KEY=(gsk_\S+)/m);
    if (groqMatch) {
      const masked = groqMatch[1].slice(0, 8) + "..." + groqMatch[1].slice(-4);
      console.log(`  ${dim(`Found existing key: ${masked}`)}`);
      const keep = await confirm(rl, "Keep existing Groq API key?");
      if (keep) groqApiKey = groqMatch[1];
    }
  }

  if (!groqApiKey) {
    const enableVoice = await confirm(rl, "Enable voice transcription (Groq Whisper)?", false);
    if (enableVoice) {
      console.log(`  ${dim("Get a key from https://console.groq.com/keys")}`);
      groqApiKey = await ask(rl, "Groq API Key", {
        validate: (v) => v.startsWith("gsk_") ? null : "Must start with gsk_",
      });
    }
  }

  // ── Step 9: Summary ──
  step(9, TOTAL_STEPS, "Summary");
  console.log();
  console.log(`  ${bold("Backend:")}    ${selectedBackend.label}`);
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
  console.log(`  ${bold("Voice:")}      ${groqApiKey ? green("enabled (Groq Whisper)") : dim("disabled")}`);
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
      .filter((line) => !line.startsWith(`${tokenEnvName}=`) && !(groqApiKey && line.startsWith("GROQ_API_KEY=")))
      .join("\n");
    if (envContent && !envContent.endsWith("\n")) envContent += "\n";
  }
  envContent += `${tokenEnvName}=${token}\n`;
  if (groqApiKey) envContent += `GROQ_API_KEY=${groqApiKey}\n`;
  writeFileSync(ENV_PATH, envContent);
  console.log(`  ${green("✓")} ${ENV_PATH}`);

  // fleet.yaml
  const yaml = await import("js-yaml");
  const fleetData = buildFleetConfig({
    backend: selectedBackend.id,
    botTokenEnv: tokenEnvName,
    groupId,
    channelMode: mode,
    accessMode,
    allowedUsers,
    projectRoots,
    instances,
    costGuard: { enabled: costGuardLimit > 0, dailyLimitUsd: costGuardLimit || undefined, timezone: costGuardTimezone },
    dailySummary: { enabled: enableSummary, hour: dailySummaryHour },
  });

  writeFileSync(FLEET_CONFIG_PATH, yaml.dump(fleetData, { lineWidth: 120 }));
  console.log(`  ${green("✓")} ${FLEET_CONFIG_PATH}`);

  // ── System service (optional) ──
  console.log();
  const installSvc = await confirm(rl, "Install as system service?", false);
  if (installSvc) {
    const { installService, detectPlatform } = await import("./service-installer.js");
    const svcPath = installService({
      label: "com.agend.fleet",
      execPath: process.argv[1],
      path: process.env.PATH!,
      workingDirectory: DATA_DIR,
      logPath: join(DATA_DIR, "fleet.log"),
    });
    console.log(`  ${green("✓")} ${svcPath}`);
    const plat = detectPlatform();
    if (plat === "macos") {
      console.log(`  Run: ${dim(`launchctl load ${svcPath}`)}`);
    } else {
      console.log(`  Run: ${dim("systemctl --user enable --now agend")}`);
    }
  }

  // ── Done ──
  console.log(`\n${green("✓")} ${bold("Setup complete!")}`);
  console.log(`  Bot: @${botUsername}`);
  console.log(`  Config: ${FLEET_CONFIG_PATH}`);
  console.log();
  console.log(`  Start the fleet:`);
  console.log(`    ${dim("agend fleet start")}`);
  if (mode === "topic") {
    console.log();
    console.log(`  ${dim("Create a new topic in the group — the bot will auto-detect it")}`);
    console.log(`  ${dim("and let you bind it to a project.")}`);
  }
  console.log();

  rl.close();
}
