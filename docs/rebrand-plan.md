# AgEnD Rebrand Plan

## Naming

- **Full name**: AgEnD (Agent Engineering Daemon)
- **npm package**: `agend`
- **CLI command**: `agend`
- **GitHub repo**: `suzuke/agend`

## Changes

### Phase 1: Code rename (one commit)

| Item | Before | After |
|------|--------|-------|
| package.json name | `claude-channel-daemon` | `agend` |
| package.json bin | `ccd`, `claude-channel-daemon` | `agend` |
| Data directory | `~/.claude-channel-daemon` | `~/.agend` |
| tmux session name | `ccd` | `agend` |
| MCP server name | `ccd-channel` | `agend` |
| MCP tool prefix | `mcp__ccd-channel__*` | `mcp__agend__*` |
| IPC env var | `CCD_SOCKET_PATH` | `AGEND_SOCKET_PATH` |
| Instance env var | `CCD_INSTANCE_NAME` | `AGEND_INSTANCE_NAME` |
| Session env var | `CCD_SESSION_NAME` | `AGEND_SESSION_NAME` |
| launchd label | `com.ccd.fleet` | `com.agend.fleet` |
| systemd unit | `ccd-fleet.service` | `agend-fleet.service` |
| Fleet PID file | `fleet.pid` | `fleet.pid` (unchanged) |
| CLAUDE.md reference | `CCD Fleet Context` | `AgEnD Fleet Context` |
| README | claude-channel-daemon | AgEnD |

### Phase 2: Migration (same release)

- `agend migrate` command:
  1. Move `~/.claude-channel-daemon` → `~/.agend`
  2. Update launchd plist path
  3. Update tmux session name
  4. Symlink `~/.claude-channel-daemon` → `~/.agend` for backward compat
- First run auto-detection: if `~/.agend` doesn't exist but `~/.claude-channel-daemon` does, prompt to migrate

### Phase 3: Backward compat

- Keep `ccd` as alias in package.json bin (prints deprecation warning, delegates to `agend`)
- Support `CCD_SOCKET_PATH` as fallback for `AGEND_SOCKET_PATH` (one release cycle)
- Support `CCD_INSTANCE_NAME` as fallback for `AGEND_INSTANCE_NAME` (one release cycle)

### Phase 4: GitHub repo rename

- Manual: Settings → Rename repository → `agend`
- GitHub auto-redirects old URL
- Update package.json repository URL

## Files to modify

```
package.json                    — name, bin, repository, keywords
src/cli.ts                      — DATA_DIR path, command descriptions
src/daemon.ts                   — CCD_INSTANCE_NAME → AGEND_INSTANCE_NAME
src/daemon-entry.ts             — env var names
src/fleet-manager.ts            — TMUX_SESSION, data dir references
src/fleet-system-prompt.ts      — "CCD Fleet Context" → "AgEnD Fleet Context"
src/channel/mcp-server.ts       — server name, CCD_SOCKET_PATH, CCD_SESSION_NAME
src/channel/mcp-tools.ts        — tool descriptions mentioning CCD
src/service-installer.ts        — launchd label, systemd unit name
src/setup-wizard.ts             — directory paths, branding
src/export-import.ts            — directory paths
README.md                       — full rewrite
README.zh-TW.md                 — full rewrite
templates/                      — launchd plist, systemd unit
tests/                          — update paths and assertions
```

## Version

- Bump to `1.0.0` (major version for breaking change)
- Tag `v1.0.0`
- Publish `agend` to npm
- Deprecate `claude-channel-daemon` on npm with message pointing to `agend`

## Risk

- Existing users' `fleet.yaml` references `~/.claude-channel-daemon` paths → migration handles this
- Existing schedules in `scheduler.db` reference old instance names → no change needed (instance names stay)
- External sessions using `CCD_SOCKET_PATH` → fallback env var support
- Telegram bot commands unchanged (`/status`, `/reload`)

## Timeline

- Phase 1-3: one PR, one release
- Phase 4: after npm publish confirmed
