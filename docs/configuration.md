# Configuration

## Fleet config

Located at `~/.agend/fleet.yaml`:

```yaml
project_roots:
  - ~/Projects

channel:
  type: telegram         # telegram or discord
  mode: topic           # topic (recommended) or dm
  bot_token_env: AGEND_BOT_TOKEN
  group_id: -100xxxxxxxxxx
  access:
    mode: locked         # locked or pairing
    allowed_users:
      - 123456789

defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: "Asia/Taipei"
  daily_summary:
    enabled: true
    hour: 21
    minute: 0
  context_guardian:
    restart_threshold_pct: 80
    max_age_hours: 8
  model_failover: ["opus", "sonnet"]
  webhooks:
    - url: https://hooks.slack.com/...
      events: ["rotation", "hang", "cost_warn"]
  log_level: info

instances:
  my-project:
    working_directory: /path/to/project
    topic_id: 277
    description: "Main backend service"
    tags: ["backend", "api"]   # searchable labels; visible in list_instances
    cost_guard:
      daily_limit_usd: 30
    model: opus
```

## Secrets

Located at `~/.agend/.env`:

```
AGEND_BOT_TOKEN=123456789:AAH...
GROQ_API_KEY=gsk_...          # optional, for voice transcription
```

## Data directory

`~/.agend/`:

| Path | Purpose |
|------|---------|
| `fleet.yaml` | Fleet configuration |
| `.env` | Bot token + API keys |
| `fleet.log` | Fleet log (JSON) |
| `fleet.pid` | Fleet manager PID |
| `scheduler.db` | Schedule database (SQLite) |
| `events.db` | Event log (cost snapshots, rotations, hangs) |
| `instances/<name>/` | Per-instance data |
| `instances/<name>/daemon.log` | Instance log |
| `instances/<name>/session-id` | Session UUID for `--resume` |
| `instances/<name>/statusline.json` | Latest Claude status line |
| `instances/<name>/channel.sock` | IPC Unix socket |
| `instances/<name>/claude-settings.json` | Per-instance Claude settings |
| `instances/<name>/rotation-state.json` | Context restart snapshot |
| `instances/<name>/output.log` | Claude tmux output capture |
