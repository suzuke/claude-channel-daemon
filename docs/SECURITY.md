# Security Considerations

> [!WARNING]
> **AgEnD is in maintenance mode.** Active development has moved to
> **[agend-terminal](https://github.com/suzuke/agend-terminal)**.
>
> Security reports for `@suzuke/agend` are still accepted — please file via the
> process described in this document. New code reports should target
> `agend-terminal`.

Running Claude Code remotely via Telegram changes the trust model compared to sitting at a terminal. Be aware of the following:

## Telegram account = shell access

Any user in `allowed_users` can instruct Claude to run arbitrary shell commands on the host machine. If your Telegram account is compromised (stolen session, social engineering, borrowed phone), the attacker effectively has shell access. Mitigations:

- Enable Telegram 2FA
- Keep `allowed_users` minimal
- Use `pairing` mode instead of pre-configuring user IDs when possible
- Review the Claude Code permission allow/deny lists in `claude-settings.json`

## Permission bypass (`skipPermissions`)

The `skipPermissions` config option passes `--dangerously-skip-permissions` to Claude Code, which disables all tool-use permission prompts. This means Claude can read/write any file, run any command, and make network requests without asking. This is Claude Code's official flag for automation scenarios, but in a remote Telegram context it means **zero human-in-the-loop for any operation**. Only enable this if you fully trust the deployment environment.

## `Bash(*)` in the allow list

By default (when `skipPermissions` is false), agend configures `Bash(*)` in Claude Code's permission allow list so that shell commands don't require individual approval. The deny list blocks a few destructive patterns (`rm -rf /`, `dd`, `mkfs`), but this is a blocklist — it cannot cover all dangerous commands. This matches Claude Code's own permission model, where `Bash(*)` is a supported power-user configuration.

If you want tighter control, edit the `allow` list in `claude-settings.json` (generated per-instance in `~/.agend/instances/<name>/`) to use specific patterns like `Bash(npm test)`, `Bash(git *)` instead of `Bash(*)`.

## IPC socket

The daemon communicates with Claude's MCP server via a Unix socket at `~/.agend/instances/<name>/channel.sock`. The socket is restricted to owner-only access (`0600`) and requires a shared secret handshake. These measures prevent other local processes from injecting messages, but do not protect against a compromised user account on the same machine.

## Secrets storage

Bot tokens and API keys are stored in plaintext at `~/.agend/.env`. The `agend export` command includes this file and warns about secure transfer. Consider filesystem encryption if the host is shared.
