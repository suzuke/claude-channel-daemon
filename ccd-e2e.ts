import { Daemon } from "./src/daemon.js";

const d = new Daemon("test", {
  working_directory: "/Users/suzuke/Documents/Hack/claude-channel-daemon",
  restart_policy: { max_retries: 10, backoff: "exponential" as const, reset_after: 300 },
  context_guardian: { threshold_percentage: 80, max_age_hours: 4, strategy: "hybrid" as const },
  memory: { auto_summarize: false, watch_memory_dir: false, backup_to_sqlite: false },
  log_level: "info" as const,
  approval_port: 18400,
  channel: {
    type: "telegram" as const,
    mode: "dm" as const,
    bot_token_env: "CCD_TEST_BOT_TOKEN",
    access: {
      mode: "locked" as const,
      allowed_users: [1047180393],
      max_pending_codes: 3,
      code_expiry_minutes: 60,
    },
  },
}, "/Users/suzuke/.claude-channel-daemon/instances/claude-channel-daemon", false);

await d.start();
console.log("\n=== DAEMON RUNNING ===");
console.log("DM @golem789_bot on Telegram to test.");
console.log("tmux attach -t ccd to see Claude.");
console.log("Ctrl+C to stop.\n");

process.on("SIGINT", async () => {
  await d.stop();
  process.exit(0);
});
setInterval(() => {}, 60000);
