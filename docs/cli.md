# CLI Reference

## Telegram commands (General topic)

| Command | Description |
|---------|-------------|
| `/status` | Show fleet status, context %, and costs |
| `/restart` | In-process restart all instances (no process exit) |
| `/upgrade` | Exit process to apply new code (requires launchd/systemd auto-restart) |
| `/sysinfo` | Show detailed system diagnostics (version, load, IPC status) |

All other operations (create/delete/start instances, delegate tasks) are handled by the General instance through natural language.

## Service management

```bash
agend start                     # Start AgEnD service (requires install)
agend stop                      # Stop AgEnD service
agend restart                   # Restart AgEnD service
agend update                    # Update AgEnD to latest version and restart
agend update --skip-install     # Skip npm install, only restart service
agend reload                    # Hot-reload config (sends SIGHUP to fleet process)
```

`agend reload` re-reads `fleet.yaml` and reconciles instances: new instances are started, removed instances are stopped, and changed configs are applied — without restarting the fleet process.

## Fleet management

```bash
agend fleet start               # Start all instances (manual mode)
agend fleet start <name>        # Start a specific instance
agend fleet stop                # Stop all instances
agend fleet stop <name>         # Stop a specific instance
agend fleet restart             # Graceful restart (wait for idle, same code)
agend fleet restart <name>      # Restart a specific instance
agend fleet restart --reload    # Full process restart to load new code
agend fleet status              # Show instance status overview
agend fleet status --json       # JSON output
agend fleet logs                # (alias — prints "Use agend logs instead")
agend fleet history             # Show event history (cost, rotations, hangs)
agend fleet history --instance <name> --type <type> --since <date> --limit <n> --json
agend fleet activity            # Show activity log (collaboration, tool calls, messages)
agend fleet activity --since 2h --limit 200 --format text
agend fleet activity --format mermaid  # Output activity as Mermaid sequence diagram
agend fleet cleanup             # Remove orphaned instance directories
agend fleet cleanup --dry-run   # Preview cleanup without deleting
```

## Instance tools

```bash
agend ls                        # List instances with status, backend, team, context, activity
agend ls --json                 # JSON output
agend attach [name]             # Attach to instance tmux window (fuzzy match, interactive menu)
agend logs                      # Show fleet log
agend logs -n 100               # Show last 100 lines (default: 50)
agend logs -f                   # Follow mode (tail -f)
agend logs --instance <name>    # Filter by instance name
agend export-chat               # Export fleet activity as HTML chat log
agend export-chat --from <date> --to <date> -o <path>
```

## Backend diagnostics

```bash
agend backend doctor [backend]  # Check backend environment (binary, auth, tmux, TERM)
agend backend trust <backend>   # Pre-trust working directories (avoid Gemini CLI trust dialogs)
```

## Web Dashboard

```bash
agend web                       # Open Web UI dashboard in browser
```

## Schedules

```bash
agend schedule list             # List all schedules
agend schedule list --target <name> --json
agend schedule add              # Add a schedule from CLI
  --cron <expr>                 # Cron expression (required)
  --target <instance>           # Target instance (required)
  --message <text>              # Message to inject (required)
  --label <text>                # Human-readable label
  --timezone <tz>               # IANA timezone (default: Asia/Taipei)
agend schedule update <id>      # Update schedule parameters
  --cron --message --target --label --timezone --enabled <bool>
agend schedule delete <id>      # Delete a schedule
agend schedule enable <id>      # Enable a schedule
agend schedule disable <id>     # Disable a schedule
agend schedule history <id>     # Show schedule run history (--limit <n>)
agend schedule trigger <id>     # Manually trigger a schedule
```

## Template deployments

Template deployment is managed via MCP tools (used by agents), not CLI commands:

- `deploy_template` — deploy a template from `fleet.yaml` into a directory
- `teardown_deployment` — stop and delete all instances from a deployment
- `list_deployments` — list active deployments with status

See [configuration.md](configuration.md#templatesname) for template definition syntax.

## Topic bindings

```bash
agend topic list                # List topic bindings
agend topic bind <name> <tid>   # Bind instance to topic
agend topic unbind <name>       # Unbind instance from topic
```

## Access control

```bash
agend access list <name>        # List allowed users
agend access add <name> <uid>   # Add allowed user
agend access remove <name> <uid> # Remove user
agend access lock <name>        # Lock instance access (whitelist only)
agend access unlock <name>      # Unlock instance access (enable pairing)
agend access pair <name> <uid>  # Generate pairing code
```

## Setup & installation

```bash
agend quickstart                # Simplified setup (recommended for new users)
agend init                      # Full interactive setup wizard
agend install                   # Install as system service (launchd/systemd)
agend install --activate        # Install and start immediately
agend uninstall                 # Remove system service
agend export [path]             # Export config for device migration
agend export --full [path]      # Export config + all instance data
agend import <file>             # Import config from export file
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `AGEND_BOT_TOKEN` | Telegram/Discord bot token (or use `bot_token_env` in fleet.yaml to customize the env var name) |
| `GROQ_API_KEY` | Groq API key for voice transcription (optional) |
| `AGEND_TMUX_SESSION` | Override tmux session name (default: `agend`) |
| `AGEND_HOME` | Override data directory (default: `~/.agend`) |
