# CLI Reference

## Telegram commands (General topic)

| Command | Description |
|---------|-------------|
| `/status` | Show fleet status, context %, and costs |
| `/reload` | Restart fleet with new code (requires launchd service) |

All other operations (create/delete/start instances, delegate tasks) are handled by the General instance through natural language.

## Fleet management

```bash
agend fleet start               # Start all instances (not needed with launchd)
agend fleet stop                # Stop all instances
agend fleet restart             # Graceful restart (wait for idle, same code)
agend fleet restart --reload    # Restart with new code (launchd auto-restarts)
agend fleet status              # Show instance status
agend fleet logs <name>         # Show instance logs
agend fleet history             # Show event history (cost, rotations, hangs)
agend fleet start <name>        # Start specific instance
agend fleet stop <name>         # Stop specific instance
agend fleet cleanup             # Remove orphaned instance directories
agend fleet cleanup --dry-run   # Preview cleanup without deleting
```

## Schedules

```bash
agend schedule list             # List all schedules
agend schedule add              # Add a schedule from CLI
agend schedule delete <id>      # Delete a schedule
agend schedule enable <id>      # Enable a schedule
agend schedule disable <id>     # Disable a schedule
agend schedule history <id>     # Show schedule run history
```

## Topic bindings

```bash
agend topic list                # List topic bindings
agend topic bind <name> <tid>   # Bind instance to topic
agend topic unbind <name>       # Unbind instance from topic
```

## Access control

```bash
agend access lock <name>        # Lock instance access
agend access unlock <name>      # Unlock instance access
agend access list <name>        # List allowed users
agend access remove <name> <uid>  # Remove user
agend access pair <name> <uid>  # Generate pairing code
```

## Setup & service

```bash
agend init                      # Interactive setup wizard
agend install                   # Install as system service (launchd/systemd)
agend install --activate        # Install and start immediately
agend uninstall                 # Remove system service
agend export [path]             # Export config for device migration
agend export --full [path]      # Export config + all instance data
agend import <file>             # Import config from export file
```
