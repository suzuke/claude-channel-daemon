# 從 AgEnD (TS) 遷移到 agend-terminal (Rust)

> [!IMPORTANT]
> 本文件是把現有 `@suzuke/agend` (TypeScript) 安裝遷移到
> [`agend-terminal`](https://github.com/suzuke/agend-terminal) (Rust) 的標準
> migration 指引。內容會分階段補完 —— Sprint 2 Phase A 先處理 Sections 2 + 3,因為對
> 既有 operator 來說,CLI flags 與 `fleet.yaml` schema 是阻力最高的兩個面向。其他章節
> 會在 Phase B 與 Phase C 補上。

> [!WARNING]
> `agend-terminal` 是 Rust 重寫,不是直譯 port。`fleet.yaml` schema 比 TS 版精簡許多 ——
> 許多原本住在 YAML 的 per-instance 旋鈕已搬到 env vars、backend presets 或 per-backend
> 指令檔案。**搬既有 config 之前請仔細讀 Section 3。**

## 為什麼要遷移? {#why-migrate}

*(Phase C —— 涵蓋:遷移動機、agend-terminal 相對 @suzuke/agend 的功能差異、何時不要遷移、支援的遷移期間。)*

## CLI flag mapping {#cli-flag-mapping}

`agend-terminal` 採 **單一扁平指令清單** (見 [`src/main.rs:165-337`](https://github.com/suzuke/agend-terminal/blob/main/src/main.rs#L165-L337)),不再使用 `@suzuke/agend` 的多群組結構 (`agend fleet …`、`agend backend …`…)。多數子群組摺到 top-level;部分整組移除 (功能搬到 MCP tools、TUI overlay、env vars,或延後實作)。

### Top-level commands (TS top-level → Rust)

| `@suzuke/agend` | `agend-terminal` | 狀態 / 備註 |
|---|---|---|
| `agend init` | — | **移除。** 改用 `agend-terminal quickstart` 互動式 setup,或手動撰寫 `fleet.yaml`。 |
| `agend quickstart` | `agend-terminal quickstart` | ✓ 等價改名。 |
| `agend start` | `agend-terminal start` | ✓ 啟動 daemon。注意:Rust 另有 `agend-terminal daemon` (顯式 daemon-mode 啟動) 與 `agend-terminal app` (TUI 多 pane 終端機介面) —— 兩者在 Rust 上是分開的指令,TS 將 multiplex 包進 `start`。 |
| `agend stop` | `agend-terminal stop` | ✓ |
| `agend restart` | — | **移除。** 用 `stop` + `start`。 |
| `agend ls` | `agend-terminal ls` (alias of `list`) | ✓ |
| `agend health` | `agend-terminal doctor` | **改名。** 把 health + backend probe 合併為一個診斷指令。 |
| `agend attach <instance>` | `agend-terminal attach <instance>` | ✓ 原生 PTY multiplexing 取代 TS 的 `tmux` wrapper,attach 退出快捷鍵可能不同。 |
| `agend logs <instance>` | — | **移除。** 直接讀 `$AGEND_HOME` 下的 log 檔案 (`daemon.log` 與每個 instance 的 log)。 |
| `agend update` | `agend-terminal upgrade` (僅 Unix) | **改名且平台收斂。** Hot in-place upgrade;接收 `--binary <path>`、`--yes`、`--install-supervisor`、`--stability-secs N`、`--ready-timeout-secs N`。 |
| `agend reload` | — | **移除。** 改 `fleet.yaml` 後 stop + start daemon。 |
| `agend install` / `agend uninstall` | — | **移除。** Service 安裝交給作業系統工具 (`systemd` / `launchd`) —— Rust binary 不自動註冊。 |
| `agend web` | — | **移除。** `agend-terminal` 沒有 web UI;TUI (`app`) 取代之。 |
| `agend export` / `agend import` | — | **移除。** 目前無 archive 格式;若要備份,直接複製 `$AGEND_HOME`。 |
| `agend export-chat` | — | **移除。** |
| — | `agend-terminal app` | **新增。** 啟動多 pane TUI。 |
| — | `agend-terminal tray` | **新增。** 系統匣整合 (feature-gated)。 |
| — | `agend-terminal inject <instance> <message>` | **新增。** 不透過 Telegram 直接把訊息打進 instance 的 stdin。 |
| — | `agend-terminal kill <instance>` | **新增。** 強制 kill hung 住的 instance。 |
| — | `agend-terminal connect` | **新增。** 把 controller 接到一個運行中的 daemon。 |
| — | `agend-terminal demo` | **新增。** 跑導覽式 demo 流程。 |
| — | `agend-terminal bugreport` | **新增。** 打包 logs/config 供 bug report 使用。 |
| — | `agend-terminal completions` | **新增。** 印出 shell completions。 |
| — | `agend-terminal mcp` | **新增。** MCP 相關診斷。 |
| — | `agend-terminal capture` | **新增。** Postmortem 用 session snapshot。 |
| — | `agend-terminal test` / `verify` | **新增。** 內部驗證指令。 |

### `agend fleet` 群組 → 摺平

| TS | Rust | 狀態 |
|---|---|---|
| `agend fleet start` | `agend-terminal fleet start [config]` | ✓ |
| `agend fleet stop` | `agend-terminal fleet stop` | ✓ |
| `agend fleet restart` | — | **移除。** 用 `fleet stop` + `fleet start`。 |
| `agend fleet status` | `agend-terminal status` | **改名且摺到 top-level**。 |
| `agend fleet logs` | — | **移除。** 直接讀 log 檔。 |
| `agend fleet history` | — | **移除。** 無等價物。 |
| `agend fleet activity` | — | **移除。** 無等價物。 |
| `agend fleet cleanup` | — | **移除。** Rust 不自動清 stale instance 資料夾;需要時手動刪。 |
| — | `agend-terminal admin cleanup-branches [--yes]` | **新增。** Admin 子群組;清 stale review branches。 |

### `agend backend` 群組 → 大部分移除

| TS | Rust | 狀態 |
|---|---|---|
| `agend backend doctor` | `agend-terminal doctor` | **改名且摺平。** 同樣的診斷面向;Rust 無 `backend` 子群組。 |
| `agend backend trust <dir>` | — | **移除。** 後端各自管 trust 檔案;`agend-terminal` 不預先信任目錄。改成手動跑一次 backend CLI 接受 trust 對話框。 |

### `agend topic ...` → 移除 (僅靠設定檔)

`topic list` / `topic bind` / `topic unbind` 在 `agend-terminal` 上 **無 CLI 等價物**。Topic-to-instance 路由改在 `fleet.yaml` (`instances.<name>.topic_id`) 設定;沒有運行時指令可改 binding。

**遷移**:直接編輯 `fleet.yaml`。需要查運行時 binding 改用 `agend-terminal status`,它會列每個 instance 的 `topic_id`。

### `agend access ...` → 移除 (改用 `channel.user_allowlist`)

`access lock` / `unlock` / `list` / `remove` / `pair` 在 `agend-terminal` **無 CLI 等價物**。存取控制改成宣告式 —— 透過 top-level `channel.user_allowlist` 欄位 —— 見 Section 3 的 High-friction #1。

**遷移**:把運行時 `access ...` 操作換成編輯 `fleet.yaml` 的 `channel.user_allowlist`,然後 restart daemon。

### `agend schedule ...` → 搬到 MCP tools / TUI

`schedule list` / `add` / `update` / `delete` / `enable` / `disable` / `history` / `trigger` 在 `agend-terminal` **無 CLI 等價物**。排程改住兩個地方:

- **MCP tools** —— `create_schedule`、`list_schedules`、`update_schedule`、`delete_schedule` (任何 agent 的工具面向皆可呼叫)。
- **TUI overlay** —— `agend-terminal app` 提供 schedule pane。

**遷移**:之前在 cron/CI 呼叫 `agend schedule add` 的 script 必須改呼叫 daemon 的 MCP tool 介面,或透過 `agend-terminal app` 預先輸入排程。

## fleet.yaml schema diff {#fleet-yaml-schema-diff}

Rust schema 在 [`src/fleet.rs:7-183`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L7-L183),是底下所有對照的 source of truth。Rust schema **刻意比 TS 精簡** —— 許多 per-instance 旋鈕已搬到 env vars、backend presets,或 per-backend 指令檔案。Port 既有 `fleet.yaml` 時請當成「重寫」而非「重命名」。

### 高摩擦變更 #1:`user_allowlist` 預設 fail-closed

**參考:** `agend-terminal` PR #216,schema 在 [`src/fleet.rs:50-60`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L50-L60),drop 邏輯在 [`src/channel/mod.rs:240-260`](https://github.com/suzuke/agend-terminal/blob/main/src/channel/mod.rs#L240-L260)。

**欄位**:`channel.user_allowlist: Option<Vec<i64>>` —— 是 `channel` 的 top-level 欄位,**不**巢狀於 `access` 之下 (Rust 的 `channel` 沒有 `access` 子鍵)。

**三態語意:**

| YAML | 行為 |
|---|---|
| 鍵不存在 | **Legacy open mode** —— 接受所有群組成員。Daemon 啟動時記 deprecation warning;此狀態為 backwards-compat 而保留,已被標記為將來移除。 |
| `user_allowlist: []` | **Lockdown。** 拒絕所有 sender。可作為不移除其他 channel config 的 kill-switch。 |
| `user_allowlist: [123, 456]` | **Allowlist。** 只接受這些 Telegram 數字 user IDs。 |

**Outbound 失敗模式 (post-PR #216 outbound notify fail-closed):**

如果 daemon 想對 channel 通知,但收件者不在 allowlist 中,你會在 `daemon.log` 看到:

```
WARN  outbound notify dropped — channel not authorised (fail-closed; configure user_allowlist to opt in)
```

(來源:`src/channel/mod.rs:254`。)

**Inbound 失敗模式:**

每筆被拒絕的 inbound 會 drop,並記一條帶該 `user_id` 的 `WARN` log。

**遷移動作**

```yaml
# fleet.yaml on agend-terminal
channel:
  type: telegram
  bot_token_env: BOT_TOKEN
  group_id: -1001234567890           # 裸 int,見 High-friction #2
  user_allowlist:                    # channel 的 top-level;從 @suzuke/agend 的 access.allowed_users 複製
    - 111111111                      # Telegram 數字 user ID,裸 int
    - 222222222
```

**Rust 上 bot 安靜時的 debug 清單:**

1. `grep "outbound notify dropped" $AGEND_HOME/daemon.log` —— 確認 gate 觸發了。
2. 確認 `channel.user_allowlist` 已設定於 `fleet.yaml`,且你的數字 user ID 在裡面 (不確定可在 Telegram 用 [@userinfobot](https://t.me/userinfobot))。
3. 如果你之前在 `@suzuke/agend` 用 `access.allowed_users`,該路徑 Rust **不再讀取** —— 把條目搬到 top-level `channel.user_allowlist`,IDs 用裸 int 形式。

> **為什麼 fail-closed:** Telegram bot 上空的 / 不存在的 allowlist 是 credential 暴露的等待事故 —— 任何人猜到或外洩 bot token 後可以 DM bot 觸發任意 backend tool use。Fail-closed 強迫 operator 做出明確的存取決策,比靜默暴露更安全也更易 debug。

### 高摩擦變更 #2:`group_id` 嚴格 `i64` —— **僅接受裸 int**

**參考:** [`src/fleet.rs:46`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L46) (欄位型別) 與 [`src/fleet.rs:725-826`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L725-L826) (round-trip 測試覆蓋 `-100123456`、`-100999`、`-3`、`-1`、`-2`)。

在 `@suzuke/agend`,`channel.group_id` 型別是 `number | string`,YAML loader 兩種都接受。Operator 指引一直是「大型負 ID 永遠 quote 成字串」,因為某些 code path 把 negative-prefix supergroup IDs 當 number 處理會 hit precision/sign 邊界。

在 `agend-terminal`,`channel.group_id` 嚴格定為 **`i64`**,serde deserialization 嚴格。**只接受裸 int 形式** —— quoted-string 形式 (`group_id: "-1001234567890"`) **會在啟動時失敗**,serde error 形如 `"invalid type: string \"-1001234567890\", expected i64"`。Rust YAML parser 不會自動 string ↔ int 互轉。

TS 的 string-handling bug 在 Rust 上不適用 (i64 原生覆蓋整個負 supergroup 範圍,並有 fleet.rs:725-826 的 round-trip 測試)。

**這 反轉了 TS 的遷移建議。** 如果你之前依 `@suzuke/agend` 建議 quote `group_id`,在新 daemon 載入 `fleet.yaml` 之前必須 **取消 quote**。

```yaml
# agend-terminal 必要形式:
channel:
  group_id: -1001234567890            # 裸 int

# agend-terminal 載入會失敗:
channel:
  group_id: "-1001234567890"          # quoted —— serde 拒絕「expected i64」
```

**其他值得注意的 int-vs-string parity:** `instances.<name>.topic_id` 在 Rust 也是嚴格 `Option<i32>` (fleet.rs:160) —— 僅裸 int。

### Top-level keys

`@suzuke/agend` 的 `FleetConfig` (`src/types.ts:218`) → `agend-terminal` 的 `FleetConfig` (`src/fleet.rs:7-29`):

| TS key | Rust 等價 | 備註 |
|---|---|---|
| `channel` | `channel: ChannelConfig` ✓ | 單數形式。**此外** Rust 接受複數形式 `channels: HashMap<String, ChannelConfig>` 用於 multi-channel routing —— 啟動時的 `normalize()` 會在只有一個 entry 時把 `channels` 摺成 `channel`。 |
| `project_roots` | **移除** | 沒有 fleet-level 的 project root allowlist;改用 per-instance `working_directory`。 |
| `defaults` | `defaults: InstanceDefaults` ✓ | 欄位集合差異很大 —— 見下方 instance 表。 |
| `instances` | `instances: HashMap<String, InstanceConfig>` ✓ | 角色相同;欄位集合精簡。 |
| `teams` | `teams: HashMap<String, TeamConfig>` ✓ | 形狀相同 (`{ members, description? }`)。 |
| `templates` | `templates: Option<HashMap<String, serde_yaml::Value>>` | **Rust 目前僅 parser** —— 鍵會 round-trip,但 template 展開尚未實作。**不要** 依賴 TS template 語意。 |
| `profiles` | **移除** | Per-instance 欄位攤平;將來若需要,reusable profiles 會以另一個 concern 重新引入。 |
| `health_port` | **移除** | Daemon 不開獨立 health port;改用 `agend-terminal doctor`。 |
| `stt` | **移除** | Voice→cloud 轉錄未實作;不支援 voice 訊息。 |

### `instances.<name>` 欄位 diff

`@suzuke/agend` `InstanceConfig` (`src/types.ts:65-111`) → `agend-terminal` `InstanceConfig` (`src/fleet.rs:140-183`):

| TS 欄位 | Rust 欄位 (snake_case) | 遷移動作 |
|---|---|---|
| `working_directory` | `working_directory: Option<String>` | ✓ 相同。實務上必填。 |
| `display_name` | `display_name: Option<String>` | ✓ 相同。 |
| `description` | `role: Option<String>` (帶 serde alias `description`) | **改名或用 alias。** Rust 上 `role: …` 與 `description: …` 都接受;canonical 是 `role`。 |
| `tags` | **移除** | 砍掉欄位。無替代;Rust 不採 tag-based routing。 |
| `topic_id` | `topic_id: Option<i32>` | ✓ 相同;**僅裸 int** (見 High-friction #2)。 |
| `general_topic` | **移除** | 砍掉欄位。 |
| `restart_policy` | **移除** | 砍掉欄位。Restart 邏輯 daemon-managed,固定常數在 `health.rs` (`CRASH_WINDOW=10min`、`BACKOFF_BASE=5s`、`BACKOFF_MAX=300s`、`DEFAULT_MAX_RETRIES=5`)。Per-instance restart 不開放調整。 |
| `context_guardian` | **移除** | 砍掉欄位。Context-rotation 調整改住 backend presets / runtime defaults。 |
| `log_level` | **移除** | 砍掉欄位。改用 env var (`RUST_LOG=…`) 全域設定。 |
| `backend` | `backend: Option<Backend>` | ✓ 相同。Backend 識別字串應一致 (claude / gemini / codex / opencode / kiro)。 |
| `tool_set` | **移除** | 砍掉欄位。MCP tool ACL 改成啟動 daemon 時設 env var `AGEND_MCP_TOOLS_ALLOW` / `AGEND_MCP_TOOLS_DENY`。 |
| `lightweight` | **移除** | 砍掉欄位。 |
| `systemPrompt` | **移除** | 砍掉欄位。指令改透過 per-backend `instructions_path` 檔案 (例如 workspace `CLAUDE.md`) 注入 —— 路徑見 `agend-terminal` 對應的 backend preset。TS `file:`-chain 語法 Rust 上無等價;若需要請手動拼接。 |
| `skipPermissions` | **移除** | 砍掉欄位。Permission flags 烘進每個 backend preset 的 `spawn_flags()`。 |
| `model` | `model: Option<String>` | ✓ 相同。傳成 `--model` 給 backend CLI。 |
| `model_failover` | **移除** | 砍掉欄位。Rust 目前無自動 failover;主 model rate-limit 時手動換 model 重啟。 |
| `cost_guard` | **移除** | 砍掉欄位。Rust 上目前無等價物。 |
| `worktree_source` | `git_branch: Option<String>` (帶 serde alias `worktree_source`) | **改名或用 alias。** Rust canonical 是 `git_branch`;TS 拼寫透過 alias 仍會載入。 |
| `workflow` | **移除** | 砍掉欄位。 |
| `startup_timeout_ms` | **移除** | 砍掉欄位。Startup 計時由各 backend preset 的 `ready_timeout_secs` 控制。 |
| `agent_mode` | **移除** | 砍掉欄位。通訊模式 (MCP vs HTTP) 由 backend preset 決定;不開放 per-instance 調整。 |

**Port 時可能想加的 Rust-only 欄位:**

| Rust 欄位 | 型別 | 用途 |
|---|---|---|
| `receive_fleet_updates` | `Option<bool>` | 預設 opt-in。對不該收到 fleet `<fleet-update>` 注入的 instance 設 `false`。 |
| `cols`、`rows` | `Option<u16>` | 覆寫該 instance 的 PTY 尺寸。 |
| `env` | `HashMap<String, String>` | Per-instance 加 env。注意:Rust 會依 `agent.rs::SENSITIVE_ENV_KEYS` 過濾類 credential 鍵 —— 從這裡注入的 secrets 可能會被 redacted。 |
| `command`、`args`、`ready_pattern` | low-level overrides | 用於選的 backend 不是內建 preset 的情況 (legacy / 客製化 CLI)。 |

**snake_case 注意:** TS schema 混用 `camelCase` (`systemPrompt`、`skipPermissions`) 與 `snake_case` (其餘)。Rust 一律 `snake_case`。上述兩個 TS camelCase 欄位 Rust 端都已移除,所以這個差異實際只影響 `worktree_source` / `git_branch` (alias 兩邊收) 與 `description` / `role` (alias 兩邊收)。

## Backend invocation diff {#backend-invocation-diff}

*(Phase B —— 涵蓋:`--mcp-config` 對應到 Rust 等價物、`--append-system-prompt-file` 流程、per-backend env-var 注入、MCP server respawn 語意、fleet-instructions 傳遞通道 —— TS 端 post-#55 模型也可參考 `docs/fleet-instructions-injection.md`。)*

## MCP tool API diff {#mcp-tool-api-diff}

*(Phase B —— 涵蓋:MCP tools 完整清單 (TS full set 約 20 個)、name rename、argument 形狀變更、return 值差異、broadcast `cost_limited` 欄位接續、deferred 或移除的 tools。)*

## Migration steps {#migration-steps}

*(Phase C —— 涵蓋:pre-flight 檢查清單、`agend-terminal migrate` (若提供) 呼叫、雙跑期間、rollback、post-migration 驗證。)*

## Known incompatibilities and deferred parity {#known-incompatibilities}

*(Phase C —— 涵蓋:意圖不 port 的功能、被延後到後續 Rust release 的 parity 項目、仍在設計中的項目。)*
