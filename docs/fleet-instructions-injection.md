# Fleet Instructions Injection — per-backend behaviour

How AgEnD delivers fleet context (identity, role, workflow, decisions, custom prompt) into each CLI backend's prompt, and how that interacts with the MCP `instructions` capability.

Background: see issue [#55](https://github.com/suzuke/AgEnD/issues/55) — before this fix, every non-Claude backend received the same fleet context twice (once via a workspace project doc, once via the MCP `initialize` response's `instructions` field), wasting tokens and diluting attention.

## The MCP `instructions` capability

The MCP spec lets a server return an `instructions` string in its `InitializeResult`. The client may surface that string to the model as system-level guidance. Whether the client actually does so — and how it merges with the user's prompt — is **per-CLI implementation**, not guaranteed by the spec. So we cannot rely on it as a sole delivery channel without per-backend evidence.

## The `nativeInstructionsMechanism` flag

Each backend declares one of three values in `src/backend/<name>.ts`:

| Value          | Meaning                                                                                  |
|----------------|------------------------------------------------------------------------------------------|
| `append-flag`  | CLI flag or config field points at a file outside the workspace. No workspace artefact. |
| `project-doc`  | Workspace markdown auto-loaded by the CLI.                                              |
| `none`         | No native injection — daemon falls back to MCP `instructions` capability.               |

The daemon (`src/daemon.ts:buildBackendConfig`) reads this flag:

- **`append-flag` / `project-doc`** → set `AGEND_DISABLE_MCP_INSTRUCTIONS=1` in the MCP server's env, drop the fleet-context env vars (`AGEND_DISPLAY_NAME`, `AGEND_DESCRIPTION`, `AGEND_WORKFLOW`, `AGEND_CUSTOM_PROMPT`, `AGEND_DECISIONS`). The MCP server (`src/channel/mcp-server.ts`) then omits its `instructions` capability entirely.
- **`none`** → keep all fleet-context env vars. The MCP server emits `instructions: buildMcpInstructions()` so the model still receives fleet context.

Either way the backend's `writeConfig()` always receives the assembled `instructions` string in its `CliBackendConfig`; whether and how to write it is the backend's choice.

## Per-backend behaviour

| Backend       | Mechanism      | Where the fleet context lands                                       | MCP `instructions` capability |
|---------------|----------------|---------------------------------------------------------------------|-------------------------------|
| `claude-code` | `append-flag`  | `<instance_dir>/fleet-instructions.md`, loaded via `--append-system-prompt-file`. Claude re-reads the file on `--resume`. | omitted                       |
| `opencode`    | `append-flag`  | `<instance_dir>/fleet-instructions.md`, listed in `opencode.json:instructions`. | omitted                       |
| `gemini-cli`  | `project-doc`  | `<workingDirectory>/GEMINI.md`, marker block keyed by instance name. | omitted                       |
| `codex`       | `project-doc`  | `<workingDirectory>/AGENTS.md`, marker block keyed by instance name. Codex enforces a 32 KiB limit on this file — the backend warns if exceeded. | omitted                       |
| `kiro-cli`    | `project-doc`  | `<workingDirectory>/.kiro/steering/agend-<instance>.md`. | omitted                       |
| `mock`        | `none`         | Not written anywhere. | active (fallback) |

## Verifying surface behaviour for a new backend

When adding a backend that has neither a flag nor a project-doc convention, `nativeInstructionsMechanism: "none"` is the safe default — the model still sees fleet context via MCP `instructions`, **but** that requires the CLI to surface the capability into its model prompt. To verify:

1. Start the instance with `customPrompt: "Reply with exactly the string FLEET_OK if you see fleet context in your system prompt."`.
2. Send any user message.
3. If the agent replies `FLEET_OK`, the CLI surfaces MCP `instructions`. Promote it to `none`.
4. If it does not, the CLI ignores the field and you must add a native injection mechanism (write a project doc or use a `--append-system-prompt`-style flag) and tag the backend `project-doc` / `append-flag`.

If a CLI exposes a CLI flag that points at a file (the cleanest option), prefer `append-flag` — workspace markdown leaves an artefact users may find surprising.

## Resume behaviour

Some backends do not re-read their instructions source on session resume; the `instructionsReloadedOnResume` flag captures this. The daemon's `trySpawn()` watches `prev-instructions` and forces a fresh session when the instructions text changes. This is independent of `nativeInstructionsMechanism`: changing only the delivery channel (e.g. via this fix) does not change the instructions text, so existing sessions are not invalidated by the upgrade itself.
