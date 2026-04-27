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

`@suzuke/agend` 已進入 maintenance mode,新功能都在 `agend-terminal` 落地。本節是價值與成本的誠實版本 —— 直接,不行銷話術。

### 你會得到什麼

- **原生 PTY multiplexing。** Rust daemon 透過跨平台的 `portable-pty` crate 直接和 PTY 對話 (該 crate 在 Unix 用 `openpty`,在 Windows 用 `ConPTY`)。`@suzuke/agend` 每次啟 backend 都 shell out 給 `tmux new-window`,把 tmux 的所有問題都繼承下來 (server 崩、stale window IDs、attach 怪行為)。Rust 上,daemon 自己的 TUI 就是 multiplexer。
- **跨平台支援。** Rust 跑 macOS / Linux / Windows;TS 只有 macOS / Linux (`tmux` 在 Windows 跑不起來)。`which::which` 會看 `PATHEXT`,所以 Windows 上的 `claude.cmd` / `codex.ps1` 可正確解析。
- **Type safety 落在重要的地方。** [§3 fleet.yaml schema diff](#fleet-yaml-schema-diff) 中的遷移項目 —— `group_id` 精度、`topic_id` 寬度、`outbound_capabilities` enum 收斂 —— Rust 在 config 載入時就檢查。TS daemon 是透過 bug report 學到同一組教訓。
- **Async daemon,沒有 per-instance Node process。** Rust 把每個 agent 以子程序形式起在單一 daemon binary 之下。TS daemon 是單一 Node process,但每實例的 runtime overhead 比 Rust task 高很多;重 fleet (>5 instance 同時跑) 感受最深。
- **單一真相來源的 backend 表。** `BackendPreset` 集中每個 backend 的 spawn flags / resume mode / instructions delivery。TS 上同一個面向被切到五個 `CliBackend` class,per-backend 行為會漂移。詳見 [§4 Backend invocation diff](#backend-invocation-diff)。
- **內建 TUI。** `agend-terminal app` 在運行中的 daemon 之上提供多 pane 終端機介面。`@suzuke/agend` 只有 web UI (`agend web`);TUI 是 Rust 獨有功能。

### 為什麼 `@suzuke/agend` 進入 deprecation

- **JS `Number.MAX_SAFE_INTEGER`** (2^53 − 1) 在你用 Discord guild ID 但沒 quote 時就咬人;Telegram supergroup ID 安然在 threshold 之下,但「永遠 quote 大型 ID」的紀律在 codebase 各處執行得不一致。Rust 用 `i64` 兩種都用裸 int 形式涵蓋 —— 詳見 [High-friction #2](#fleet-yaml-schema-diff)。
- **`tmux` 作為 multiplexer** 把 daemon 完全鎖出 Windows,並且多了一層 bug 容易藏的地方 (「pane 黑掉了;是 agent、tmux server、還是 wrapper script 出問題?」)。
- **Process management overhead。** TS 上每個 spawn 出來的 backend 住在 tmux pane 裡,daemon 用「signal-capturing wrapper script + PTY-output regex」管理。Rust 直接驅動 PTY。
- **Implicit channel ACLs。** TS 把所有 outbound MCP 呼叫視為「任何 instance 都能用」。Rust PR #230 引入明確的 `outbound_capabilities` allowlist —— 一個 security-relevant 的預設,沒辦法在不破壞既有 fleet 的前提下回填到 TS。

### 應該現在遷移嗎?

**立刻遷移**,如果你符合任何下列情況:

- 你同時跑超過 ~5 個 instance (fleet 效能與 daemon overhead)。
- 你的 operator 在 Windows,或你希望他們可以在 Windows。
- 你依賴 TUI 做 fleet 觀測 (Rust 的 web UI 也 OK,但 TUI 是更上一階)。
- 你常踩到 cost-guard pause 流程 —— Rust 在每個 outbound 介面都 honor per-target gate,並有 [`outbound_capabilities`](#fleet-yaml-schema-diff) 的明確 allowlist 配套。

**可以延後**,如果:

- 你只跑一個 Telegram-bound instance、一兩個 operator、沒 Discord、沒 Windows 使用者。
- 你的 fleet config 穩定,不需要新欄位。
- 你還沒踩過 JS `Number` 精度問題 (小 fleet、無 Discord、無 Windows 精度敏感場景)。

### Pre-alpha 注意事項

`agend-terminal` 目前是 **pre-alpha**。Schema 與 CLI 介面仍在變動 —— Sprint 22 P0 (`outbound_capabilities` 從 optional 翻成 required) 是一個例子;Sprint 23 同欄位將 absent 升為 hard parse error 是另一個。遷移前:

1. **鎖版本。** 用特定 Cargo install / GitHub release tag,不是 `main`。
2. **每次升級前讀 release notes。** 兩階段轉變 (warn-but-permit → hard error) 在這時期 release 之間移動很快。
3. **保留 `@suzuke/agend` 安裝與 `fleet.yaml` 備份。** Rollback 流程見 [§6 Migration steps](#migration-steps)。

`@suzuke/agend` 的 maintenance-mode 承諾僅限 security 修補與 backend CLI 相容性更新 —— 不再加新功能。遷移窗口在 `agend-terminal` 仍 pre-1.0、且 `@suzuke/agend` 持續收 security fix 之間都開著。

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

如果 daemon 想對 channel 通知,但收件者不在 allowlist 中,以下這行會以 **DEBUG** level 寫入 `daemon.log` (`tracing::debug!` 在 `src/channel/mod.rs:251-255`):

```
DEBUG  outbound notify dropped — channel not authorised (fail-closed; configure user_allowlist to opt in)
```

> [!IMPORTANT]
> Drop 事件是 `DEBUG`,**不是** `WARN`。預設 `RUST_LOG=info` 下你看不到 ——`grep daemon.log` 也找不到,operator 自然會結論「config OK」,**這正好是相反的判斷**。**重現此失敗模式時請先設 `RUST_LOG=debug` (或 `RUST_LOG=agend_terminal=debug`) 再啟動 daemon。** 把這行升到 `WARN` 是 `agend-terminal` 端的修正 (dev-team backlog),本指引反映目前行為。

**Inbound 失敗模式:**

每筆被拒絕的 inbound 會 drop,並記一條帶該 `user_id` 的 log。同樣注意:依特定 log level 做 grep 前,請先在 `agend-terminal` 原始碼確認 level。

**遷移動作**

```yaml
# fleet.yaml on agend-terminal
channel:
  type: telegram
  bot_token_env: BOT_TOKEN
  group_id: -1001234567890           # 裸 int,見 High-friction #2
  user_allowlist:                    # channel 的 top-level;從 @suzuke/agend 的 channel.access.allowed_users 複製
    - 111111111                      # Telegram 數字 user ID,裸 int
    - 222222222
```

**Rust 上 bot 安靜時的 debug 清單:**

1. `grep "outbound notify dropped" $AGEND_HOME/daemon.log` —— 確認 gate 觸發了。
2. 確認 `channel.user_allowlist` 已設定於 `fleet.yaml`,且你的數字 user ID 在裡面 (不確定可在 Telegram 用 [@userinfobot](https://t.me/userinfobot))。
3. 如果你之前在 `@suzuke/agend` 用 `channel.access.allowed_users` (完整路徑;`access` 在 `src/types.ts:57` 嵌在 `channel` 之下),該路徑 Rust **不再讀取** —— 把條目搬到 top-level `channel.user_allowlist`,IDs 用裸 int 形式。
4. **TS pairing-mode 使用者** (透過 `agend access pair` 發 pairing 碼,使用者兌換後 ID 進到 `channel.access.allowed_users`) 也必須直接列進 `channel.user_allowlist` —— `agend-terminal` 沒有 pairing flow 等價物。如果你的 `@suzuke/agend` 環境用 `access.mode: "pairing"`,請把每個目前 active 的 user ID 明列進 Rust allowlist。

> **為什麼 fail-closed:** Telegram bot 上空的 / 不存在的 allowlist 是 credential 暴露的等待事故 —— 任何人猜到或外洩 bot token 後可以 DM bot 觸發任意 backend tool use。Fail-closed 強迫 operator 做出明確的存取決策,比靜默暴露更安全也更易 debug。

### 高摩擦變更 #2:`group_id` 嚴格 `i64` —— **僅接受裸 int**

**參考:** [`src/fleet.rs:46`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L46) (欄位型別) 與 [`src/fleet.rs:725-826`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L725-L826) (round-trip 測試)。

在 `@suzuke/agend`,`channel.group_id` 型別是 `number | string`,YAML loader 兩種都接受。**TS canonical 文件對 Telegram supergroup ID 採裸 int** —— 見 `docs/configuration.md:23` (`group_id: -1001234567890`) 與 `tests/setup-wizard-config.test.ts:127` (`toBe(-1001234567890)`)。需要 quote 成字串的是 **Discord guild ID** (正向 18-19 位 snowflake,超過 JavaScript `Number.MAX_SAFE_INTEGER` 即 2^53 − 1) —— 見 `docs/features.md:302`、`docs/plugin-development.md:293`、`docs/plugin-adapter-architecture.md:28,298`。Quote Discord ID 是為了避開 JS `Number` 的精度損失;quote Telegram ID 從來不是 TS 的 canonical 建議。

在 `agend-terminal`,`channel.group_id` 嚴格定為 **`i64`**,serde deserialization 嚴格。**只接受裸 int 形式** —— quoted-string 形式 (`group_id: "-1001234567890"`) **會在啟動時失敗**,serde error 形如 `"invalid type: string \"-1001234567890\", expected i64"`。Rust YAML parser 不會自動 string ↔ int 互轉。`i64` 同時涵蓋 Telegram 負向 supergroup ID (在範圍內) 與 Discord snowflake (適合 2^63 − 1),兩者都可用同一裸 int 形式。

[`src/fleet.rs:725-826`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L725-L826) 的 round-trip 測試鎖定的是裸 int 解析契約,代表性負 ID 包含 (`-100123456`、`-100999`、`-3`、`-1`、`-2`)。Quoted-string 拒絕是 serde 對 `i64`-typed 欄位的預設行為,沒有單獨 regression-pinned —— 將來若 serde 出現允許寬鬆轉型的旋鈕,行為可能變,不過 typed-field 契約讓這種漂移不太可能發生。

**遷移動作。** 如果你的 `fleet.yaml` 對任何 `group_id` 值有 quote (尤其是 Discord 用戶,quote 是 TS 端的標準避坑作法),在新 daemon 載入 config 之前先取消 quote:

```yaml
# agend-terminal 必要形式 (Telegram 與 Discord 皆然):
channel:
  group_id: -1001234567890            # 裸 int

# agend-terminal 載入會失敗:
channel:
  group_id: "-1001234567890"          # quoted —— serde 拒絕「expected i64」
```

**其他值得注意的 int-vs-string parity:** `instances.<name>.topic_id` 在 Rust 也是嚴格 `Option<i32>` (fleet.rs:160) —— 僅裸 int。

### 高摩擦變更 #3:`outbound_capabilities` 是 Rust 端必填的新增欄位

**參考:** Sprint 22 P0 PR [#230](https://github.com/suzuke/agend-terminal/pull/230)。Schema doc-comment 在 [`src/fleet.rs:173-208`](https://github.com/suzuke/agend-terminal/blob/main/src/fleet.rs#L173-L208);enforcement helper 在 [`src/channel/auth.rs::gate_outbound_for_agent`](https://github.com/suzuke/agend-terminal/blob/main/src/channel/auth.rs);enum 在同檔案的 `ChannelOpKind`。Operator 完整參考:[`docs/MIGRATION-OUTBOUND-CAPS.md`](https://github.com/suzuke/agend-terminal/blob/main/docs/MIGRATION-OUTBOUND-CAPS.md)。

`@suzuke/agend` 沒有對等欄位 —— outbound channel ACL 過去是隱式的(「任何工具任何 instance 都能呼叫」)。`agend-terminal` 引入 `instances.<name>.outbound_capabilities: Vec<ChannelOpKind>`,用來限制每個 instance 可呼叫哪些 agent-driven channel ops。目前四個變體 (YAML 用 snake_case → 對應 `ChannelOpKind` variant):`reply` → `Reply`、`react` → `React`、`edit` → `Edit`、`inject_provenance` → `InjectProvenance`。

**三態語意** (與高摩擦變更 #1 的 `channel.user_allowlist` 同模式):

| YAML | Sprint 22 P0(目前) | Sprint 23(下一階段) |
|---|---|---|
| `outbound_capabilities: [reply, react]` | 列出的 ops 允許 | 同 |
| `outbound_capabilities: []` | fail-closed(明確不允許 agent outbound) | 同 |
| 鍵不存在 | FATAL warn-but-permit one daemon cycle | hard parse error |

**鍵不存在時的症狀(Sprint 22 P0 grace 期間)。** Daemon 透過 `tracing::error!` 發:

```
ERROR FATAL (warn-but-permit one daemon cycle): instance '<name>' outbound_capabilities NOT SET. Sprint 22 P0 grants this <op> call under gradual-migration grace. ...
```

該 op 仍會繼續執行 —— 但這條 warning 在每個 daemon process 內每個 instance 只會發一次(以 mutex-guarded `HashSet` 限速,不會 spam log)。Sprint 23 ship 後,鍵不存在會變成 hard parse error,daemon 會直接拒絕載入 config。**不要依賴 grace window 撐到 Sprint 22 P0 之後**。

**Built-in coordinator 自動注入。** `general` instance(以及未來自動建立的 coordinator)會在啟動時由 [`bootstrap::fleet_normalize::auto_create_general`](https://github.com/suzuke/agend-terminal/blob/main/src/bootstrap/fleet_normalize.rs#L23-L87) 自動注入 `[reply, react, edit, inject_provenance]`(連結範圍同時涵蓋定義四項預設值的 `default_built_in_outbound_capabilities()` helper 與消費它的 `auto_create_general` fn)。**User 自己寫的 YAML entry 不會自動注入** —— Sprint 23 之前,operator 定義的每個 instance 都必須明確宣告 `outbound_capabilities`。

**遷移動作。** 把既有 `@suzuke/agend` `fleet.yaml` 移到 `agend-terminal` 時,給每一個 operator 自寫的 instance 加上 `outbound_capabilities`:

```yaml
instances:
  worker-a:
    working_directory: /path/to/repo
    outbound_capabilities: [reply, react]      # 明確列出 agent 應該用的 channel ops
  worker-b:
    working_directory: /path/to/other-repo
    outbound_capabilities: []                  # 明確 lockdown —— agent 不可呼叫 channel ops
```

完整的 `ChannelOpKind` enum 參考、2-stage transition timeline 的 rationale、以及跨 channel 架構備註(Telegram-vs-Discord 共用 gate 的行為),請見 operator 完整參考 [`docs/MIGRATION-OUTBOUND-CAPS.md`](https://github.com/suzuke/agend-terminal/blob/main/docs/MIGRATION-OUTBOUND-CAPS.md)。

### Top-level keys

`@suzuke/agend` 的 `FleetConfig` (`src/types.ts:218`) → `agend-terminal` 的 `FleetConfig` (`src/fleet.rs:7-29`):

| TS key | Rust 等價 | 備註 |
|---|---|---|
| `channel` | `channel: ChannelConfig` ✓ | 單數形式。**此外** Rust 接受複數形式 `channels: HashMap<String, ChannelConfig>` 用於 multi-channel routing —— 啟動時的 `normalize()` 會在只有一個 entry 時把 `channels` 摺成 `channel`。 |
| `project_roots` | **移除** | 沒有 fleet-level 的 project root allowlist;改用 per-instance `working_directory`。 |
| `defaults` | `defaults: InstanceDefaults` ✓ | 欄位集合差異很大 —— 見下方 instance 表。 |
| `instances` | `instances: HashMap<String, InstanceConfig>` ✓ | 角色相同;欄位集合精簡。 |
| `teams` | `teams: HashMap<String, TeamConfig>` ✓ | Rust 形狀 (`src/fleet.rs:175-183`):`{ members, orchestrator?, description? }`。新增的 `orchestrator: Option<String>` 欄位指定一個成員作為 team-addressed `delegate_task` 的 routing 目標,並用於 TUI team-tab 視圖的分組。TS `TeamConfig` 只有 `{ members, description? }` —— port 時若想保持 TS 等價行為,`orchestrator` 留空即可;採用新 routing 慣例後再設定。 |
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
| `outbound_capabilities` | `Vec<ChannelOpKind>` | **Sprint 23 起,operator 自寫的每個 instance 都必填。** 限制該 instance 可呼叫哪些 agent-driven channel ops(`reply` / `react` / `edit` / `inject_provenance`)。三態語意 + 2-stage timeline + `general` 自動注入 —— 詳見上方「高摩擦變更 #3」。 |
| `receive_fleet_updates` | `Option<bool>` | 預設 opt-in。對不該收到 fleet `<fleet-update>` 注入的 instance 設 `false`。 |
| `cols`、`rows` | `Option<u16>` | 覆寫該 instance 的 PTY 尺寸。 |
| `env` | `HashMap<String, String>` | Per-instance 加 env。注意:Rust 會依 `agent.rs::SENSITIVE_ENV_KEYS` 過濾類 credential 鍵 —— 從這裡注入的 secrets 可能會被 redacted。 |
| `command`、`args`、`ready_pattern` | low-level overrides | 用於選的 backend 不是內建 preset 的情況 (legacy / 客製化 CLI)。 |

**snake_case 注意:** TS schema 混用 `camelCase` (`systemPrompt`、`skipPermissions`) 與 `snake_case` (其餘)。Rust 一律 `snake_case`。上述兩個 TS camelCase 欄位 Rust 端都已移除,所以這個差異實際只影響 `worktree_source` / `git_branch` (alias 兩邊收) 與 `description` / `role` (alias 兩邊收)。

## Backend invocation diff {#backend-invocation-diff}

遷移上線第一天最容易踩到的雷，是兩個 daemon 拉起 backend CLI、餵 instructions、發訊號的方式有實質差異。本節給出完整 diff，讓在 TS 版能跑的 fleet，在 Rust 版也能繼續跑。

### 兩種 invocation 模型

| 面向 | `@suzuke/agend` (TS) | `agend-terminal` (Rust) |
|---|---|---|
| Spawn 介面 | 每個 backend 透過 `tmux new-window <shell-string>`，shell 引用邏輯散落在 `src/backend/<name>.ts` | 每個 pane 直接走 PTY (Unix 用 `openpty`，Windows 用 ConPTY)，command 與 args 從靜態 `BackendPreset` 解析 |
| Backend 抽象 | 每個 backend 一個 TypeScript class，實作 `CliBackend`（`buildCommand`、`writeConfig`、`getReadyPattern`、`getStartupDialogs`…） | 一個 enum variant 配一個 `BackendPreset` struct，集中在 `src/backend.rs` |
| Renderer | 沒有 — pane 內容就是 tmux 顯示的 | daemon TUI 內建 vterm/Ratatui pane；agent 看到的就是這個 byte stream |
| 跨平台目標 | 只支援 macOS / Linux（依賴 tmux） | macOS / Linux / Windows（ConPTY）；`which::which` 會看 `PATHEXT`，所以 Windows 上的 `claude.cmd` / `codex.ps1` 可正確解析 |
| Backend 種類 | 五種固定:`claude-code`、`opencode`、`gemini-cli`、`codex`、`kiro`，加上 `mock`（僅 E2E 用） | 同樣五種，外加 `Backend::Shell`（通用 `$SHELL`）與 `Backend::Raw(path)`（任意執行檔）—— 兩者都沒有 preset 配線 |

TS daemon 把幾乎所有事都委派給 per-backend class；Rust daemon 把所有事集中到一張 preset 表，每條 spawn path 都讀同一張表。實務上這意味著:在 TS 上，調整某個 backend 的行為是動 `src/backend/<name>.ts`；在 Rust 上，是改 `BackendPreset` 的某個欄位，然後所有 call site 自動跟著變。

### Per-backend invocation 對照表

每個 backend 的 command line 形狀大致保留下來，外部包裝改變了。

| Backend | TS invocation 摘要 | Rust invocation 摘要 |
|---|---|---|
| **Claude Code** | `claude --settings <path> --mcp-config <path> --dangerously-skip-permissions [--resume <session-id>] [--model <m>] [--append-system-prompt-file <path>]`，邏輯在 `src/backend/claude-code.ts:17-45`。Spawn 前會把 `ANTHROPIC_API_KEY` 預先核可寫入 `~/.claude.json`。 | `claude --dangerously-skip-permissions [--continue]`，再透過 `Backend::spawn_flags`（`src/backend.rs:411-426`）在對應檔案存在時注入 `--append-system-prompt-file` 與 `--mcp-config`。Resume 策略:`ResumeMode::ContinueInCwd { flag: "--continue" }`。 |
| **OpenCode** | `opencode [--session <sid>] [--continue] [--model <m>]`。MCP 透過 working directory 內的 `opencode.json:mcp.<key>` 配置；instructions 走 `opencode.json:instructions` 陣列指向 `<instance_dir>/fleet-instructions.md`（`src/backend/opencode.ts:14-73`）。 | `opencode [--continue]`。Resume:`ContinueInCwd { flag: "--continue" }`。**行為變更:** instructions 現在透過 marker-merge 寫入 workspace 的 `AGENTS.md`，**不再**走每實例獨立、由 `opencode.json` 引用的檔案。詳見下方的「Instructions 注入」小節。 |
| **Codex** | `codex resume --last [--dangerously-bypass-approvals-and-sandbox \| --full-auto] [-c model="<m>"]`。MCP 透過全域 `~/.codex/config.toml`（呼叫 `codex mcp add <name>`）註冊；信任授權則 append `[projects."<workdir>"]` 至同檔。 | Resume 時 `codex resume --last --dangerously-bypass-approvals-and-sandbox`；fresh start 時 `codex --dangerously-bypass-approvals-and-sandbox`（透過 `fresh_args` 欄位拿掉 `resume --last`）。Resume:`ResumeMode::NotSupported`（Codex 的 resume 是子命令而非 flag，所以塞在 `args` 裡）。 |
| **Gemini CLI** | `gemini --yolo [--resume latest] [--model <m>]`。MCP 註冊在 `<workdir>/.gemini/settings.json:mcpServers.<key>`；信任透過 `~/.gemini/trustedFolders.json`。 | `gemini --yolo`，搭配 `ResumeMode::Fixed { args: &["--resume", "latest"] }` 補上 resume flags。 |
| **Kiro CLI** | `kiro-cli chat --trust-all-tools [--resume] [--model <m>] --require-mcp-startup`。MCP 透過每 server 一支 **wrapper script**（`<instance_dir>/mcp-wrapper-<name>.sh`，mode `0o700`）—— 這個 wrapper 先 export env，再 exec 實際的 MCP binary，繞過 Kiro 忽略 `mcp.json` 的 `env` block。 | `kiro-cli chat --trust-all-tools [--resume]`。Resume:`ContinueInCwd { flag: "--resume" }`。Rust 拿掉了 wrapper script 的 workaround，因為 `mcp_config.rs` 直接以 Kiro 認得的形式把 env 寫到磁碟。 |

### Resume 策略 diff

TS 版每個 instance 維護自己的 session id，靠 `--resume <id>`、`--session <id>` 重新接上。Rust 版不追蹤 session id —— 用每個 backend 自己的「resume cwd 內最近一次 session」語意，三種 variant:

- `ResumeMode::ContinueInCwd { flag }` —— Claude (`--continue`)、OpenCode (`--continue`)、Kiro (`--resume`)。
- `ResumeMode::Fixed { args: &[..] }` —— Gemini (`--resume latest`)。
- `ResumeMode::NotSupported` —— Codex（resume 是 `resume` 子命令，已經塞在 `args`）。

這個策略可行的前提是:Rust 版每個 agent 永遠 spawn 在獨立的 working directory（git repo 自動建 worktree），所以「cwd 最近 session」剛好就 1:1 對應到該實例自己的 session。

唯一一個邊界:Claude pane 開了但完全沒用過時，`claude --continue` 會錯誤退出（"No conversation found to continue"）。雖然 daemon 的 crash-respawn 路徑會接住，但失敗訊息會閃進 pane 後才被覆蓋，看起來像壞掉。`Backend::has_resumable_session(working_dir)`（僅 Claude，位於 `src/backend.rs`）會掃描 `~/.claude/projects/<encoded-cwd>/*.jsonl`，偵測到「只有 metadata」的 session 時把 `Resume` 預先降級為 `Fresh`，使用者就看不到那個 flash。其他 backend 樂觀回傳 `true`，倚賴 crash-respawn safety net。

### Instructions 注入 — `nativeInstructionsMechanism` 對應

Bug #55（PR #56）在 TS 端引入 `CliBackend` interface 上的三值欄位 `nativeInstructionsMechanism`。Rust 沒有同名欄位；對應的機制由 `BackendPreset` 的三個欄位編碼:`instructions_path`、`instructions_shared`、`inject_instructions_on_ready`。對應如下:

| Backend | TS `nativeInstructionsMechanism`（PR #56 後） | Rust 對應 | TS 檔案位置 | Rust 檔案位置 |
|---|---|---|---|---|
| `claude-code` | `append-flag`（`--append-system-prompt-file`） | `instructions_path = ".claude/agend.md"`、`shared = false`、`inject_on_ready = false`。Flag 由 `Backend::spawn_flags` 注入。 | `<instance_dir>/fleet-instructions.md` | `<workdir>/.claude/agend.md`（在 `.claude/` 下但**刻意不放** `.claude/rules/`，避免 Claude 重複載入） |
| `opencode` | `append-flag`（`opencode.json:instructions`） | `instructions_path = "AGENTS.md"`、`shared = true`、`inject_on_ready = false`。對 workspace 的 `AGENTS.md` 做 marker-merge。 | `<instance_dir>/fleet-instructions.md`（由 workspace `opencode.json` 引用） | `<workdir>/AGENTS.md`（workspace project doc） |
| `gemini-cli` | `project-doc`（`GEMINI.md`） | `instructions_path = "GEMINI.md"`、`shared = true`、`inject_on_ready = false`。Marker-merge。 | `<workdir>/GEMINI.md` | `<workdir>/GEMINI.md` |
| `codex` | `project-doc`（`AGENTS.md`） | `instructions_path = "AGENTS.md"`、`shared = true`、`inject_on_ready = false`。Marker-merge，Codex 的 32 KiB 上限保留。 | `<workdir>/AGENTS.md` | `<workdir>/AGENTS.md` |
| `kiro` | `project-doc`（`.kiro/steering/agend-<instance>.md`） | `instructions_path = ".kiro/steering/agend.md"`、`shared = false`、`inject_on_ready = true`。Rust 不再仰賴 `.kiro/steering/*.md` 自動載入，而是在 Ready 觸發後**把檔案內容當作第一則 user message 打進 pane**。 | `<workdir>/.kiro/steering/agend-<instance>.md`（每實例獨立檔案） | `<workdir>/.kiro/steering/agend.md`（每 workdir 一個檔案）**並**在 Ready 時注入 |
| `mock` | `none`（fallback 至 MCP `instructions` capability） | n/a — Rust 沒有 mock backend；E2E 改用 `Backend::Shell`。 | n/a | n/a |

遷移時三個值得特別留意的行為變化:

1. **OpenCode 現在會寫 workspace project doc（`AGENTS.md`）**。TS 把 fleet instructions 留在 `<instance_dir>/fleet-instructions.md`，使用者根本看不到。Rust 把 OpenCode 比照 Codex 處理。如果你的 repo 有 commit `AGENTS.md`，遷移後會看到 marker block 出現在 diff 中；如果 `.gitignore` 已把 `AGENTS.md` 排除，無行為變化。
2. **Kiro 從每實例命名改為每 workdir 命名**。TS 寫 `.kiro/steering/agend-<instance>.md`，Rust 寫 `.kiro/steering/agend.md`。在 TS 下若兩個 Kiro instance 共用同一 working directory，各自會有自己的檔案；在 Rust 下會共用一個 —— 而 Rust 通常用獨立 worktree 避免這種共用。
3. **Kiro 的 instructions 改以 user message 注入**。TS `src/backend/kiro.ts:81` 寫檔時的註解聲稱 auto-load；Rust 團隊的實證調查發現 `.kiro/steering/*.md` 是 IDE 才會用的功能、獨立 CLI 不讀取，因此 Rust 改由 daemon 在 Ready 後把檔案內容貼進 pane（`inject_instructions_on_ready = true`）。這代表 instructions 占的是 chat history，不是 system prompt slot；冗長的 customPrompt 在啟動時就會吃 context tokens。PR #55 已經把 MCP 端的重複注入風險排除，所以這裡沒有雙重消耗。（如果 TS 註解才是對的、Kiro CLI 真會 auto-load，遷移結果一樣 —— instructions 仍會抵達模型 —— 只是 channel 從被動 auto-load 變成第一則 user message 主動 inject。）

Bug #55 在 daemon 端的 gate（當 `nativeInstructionsMechanism !== 'none'` 時，丟掉五個 fleet-context env vars 並設 `AGEND_DISABLE_MCP_INSTRUCTIONS=1`）位於 `src/daemon.ts:1022-1039`。Rust 沒在同一層複製這個 gate；它在更早的階段就 gate —— backend preset 寫了檔案就不再構建 MCP `instructions` capability response。可觀察的不變式 ——「模型永遠不會看到兩遍 fleet context」—— 在兩個 daemon 上都成立。

### 信號與 ESC byte 語意

**Transport**（按鍵或 byte 能不能從 daemon 送進 agent 的 PTY）—— 下表四個 backend 已驗證。**Semantics**（agent 收到 ESC 或 SIGINT 後，會不會做正確的事）—— 在 `src/backend_harness.rs` 內以 per-backend capability matrix 獨立追蹤。Rust 專案 Sprint 11 會做 real-CLI 驗證；在那之前，下表用 §3.5.8 規定的 **`pending`** 標記。

| Backend | PTY byte transport（ESC `0x1b`、Ctrl-C `0x03`） | `interrupt` MCP tool 語意（ESC 中斷 LLM turn） | `tool_kill` MCP tool 語意（SIGINT 給 fg pgid） |
|---|---|---|---|
| `kiro-cli` | `True`（由 `verify_byte_delivery` 驗證） | `pending`（Sprint 11） | `pending`（Sprint 11） |
| `codex` | `True` | `pending` | `pending` |
| `claude` | `False` —— 由 `record_transport_results` 在 `src/backend_harness.rs:71-74` 的明確 Claude 分支設定（每個 backend 的初始值在 line 56 是 `Unverified`；Claude 因為「LLM context not tied to PTY buffer (known gap)」—— line 50 的註記 —— 被降級為 `False`） | `pending` | `pending` |
| `gemini` | `True` | `pending` | `pending` |
| `opencode` | 尚未進 harness matrix（`Backend::all()` 會回傳它，但 matrix 初始化只 seed 上面四個）—— `pending` | `pending` | `pending` |

Rust 端今天**確實保證**的事情:

- **Process tree termination**。`process::kill_process_tree(pid)`（`src/process.rs`）對 process group 發 `SIGTERM`，sleep 500 ms，然後無條件補 `SIGKILL`。Windows 退而求其次用 `TerminateProcess`。這條路徑用於 instance shutdown、replace、crash recovery —— 不負責中斷正在進行中的 LLM turn。
- **ESC byte 注入**。`interrupt` MCP tool（`src/mcp/handlers.rs:969-991`）透過 daemon API 把 `0x1b` 寫進目標 agent 的 PTY。對端模型是否會把 ESC 解讀為「停止生成」是上面表格中的 `pending`。
- **SIGINT 給 foreground process group**。`tool_kill` MCP tool（`src/mcp/handlers.rs:994-1031`）透過 `tcgetpgrp` 找出 pane 的 foreground pgid，然後對它發 `SIGINT`。Unix 才支援 —— Windows 上會回傳 `{"error": "tool_kill is only supported on Unix (Linux/macOS)"}`，而非靜默 no-op。

TS daemon 完全沒有 `interrupt`、`tool_kill`、`kill_process_tree` 這類 group kill、capability matrix —— 這些都不存在。TS 上的「取消」只能仰賴 backend 自己的 quit command（`/exit`、`/quit`、`exit`）或 OS 層級殺掉 tmux pane。

### 對遷移的實質影響

- 如果你直接 script CLI invocation（在 daemon 之外自己 spawn binary），只有 Codex 形狀變了（resume 回到原本就是子命令的形式，TS 拿來包裝 `--resume <id>` 的 wrapper 不見了）。
- 如果你的 repo 有 commit `AGENTS.md` 或 `GEMINI.md`，遷移後會看到 marker block。`.gitignore` 不需要新加 `<!-- agend:<instance> -->` 之類 glob —— marker block 是檔案內容，不是另一個檔案。
- 如果你有 Kiro 工具讀 `.kiro/steering/agend-<instance>.md`，改成讀 `.kiro/steering/agend.md`。
- 如果你以前依賴 TS MCP `instructions` capability fallback 來測 mock backend，請把 E2E 切到 `Backend::Shell` 並改用 `task` MCP tool flow 注入 instructions。

## MCP tool API diff {#mcp-tool-api-diff}

按 Sprint 0 review 與 dev-lead 的 HIGH-FRICTION 標記，這是**整份遷移指南最重的主題**。差異不是改名 —— Rust 把 TS 視為單一 communication surface 的東西**拆成三軌 coordination tracks**，並另外加了一批沒有 TS 對應的工具。

### 三軌 coordination 模型

```
                ┌───────────────── 1. work ─────────────────┐
                │       task       (work board: create / claim / in_progress / verified / done)
agent ──────────┤
                │  send_to_instance, broadcast, delegate_task, request_information, report_result
                ├──────── 2. comms (push/pull) ─────────────┤
                │   inbox, describe_message, describe_thread (pull side, Rust 獨有)
                │   set_waiting_on, clear_blocked_reason     (presence side, Rust 獨有)
                │
                └─────── 3. scope freeze ───────────────────┘
                          post_decision, list_decisions, update_decision
```

為什麼是三軌？TS 上 agent 的 MCP 工具箱把「做工作」、「告訴另一個 agent」、「決定政策」當成同一件事 —— 在 `src/outbound-handlers.ts` 的 `outboundHandlers` 內由不同訊息 shape route。Rust daemon 強制更明確的分層，原因和 `git` 把 index、working tree、object store 拆開一樣:負責「凍結一個 scope decision」的工具和負責「投遞一條訊息」或「claim 一個 task」的工具有不同的 correctness invariants，混在一起就無法推理 ordering 或 recovery（協定層的論述見 `FLEET-DEV-PROTOCOL-v1.md` §1、§2）。

對 agent 而言，實務影響是:

- **Work board（`task`）** 是「這件事做完沒」的唯一真相來源。狀態轉移 `claimed → in_progress → verified → done` 不能跳關，跳了會被拒絕。
- **Comms** 仍然用 `send_to_instance` / `broadcast` 做 push，但加入 **pull**（`inbox`）與 **presence**（`set_waiting_on`），讓 agent 重啟後能補回未讀訊息。
- **Decisions（`post_decision`）** 是唯一「凍結未來 scope」的機制。reviewer 找到 scope violation 時引用 decision id；違反者不能事後辯說「我們從沒決議過」。

### 兩端都存在的工具

下列工具兩個 daemon 都有，名稱與形狀大致相同；diff 在 input/output schema 與週邊 lifecycle。先掃過表格找「schema diff」，只在你實際用該工具時才細看 sub-section。

| 工具 | TS schema 位置 | Rust schema 位置 | Schema diff |
|---|---|---|---|
| `reply` | `src/outbound-schemas.ts:ReplyArgs` | `src/mcp/tools.rs:channel_tools` | 無 |
| `react` | `ReactArgs` | `channel_tools` | 無 |
| `edit_message` | `EditMessageArgs` | `channel_tools` | 無 |
| `download_attachment` | `DownloadAttachmentArgs` | `channel_tools` | 無 |
| `send_to_instance` | `SendToInstanceArgs` | `comm_tools` | Rust 加上選填的 `thread_id`、`parent_id` 用於 thread 追蹤。雙方都接受 `request_kind ∈ {query, task, report, update}`。 |
| `delegate_task` | `DelegateTaskArgs` | `comm_tools` | Rust 加上 `task_id`、`thread_id`、`parent_id`、`force` + `force_reason`（取代已棄用的 `interrupt` + `reason`）、`second_reviewer` + `second_reviewer_reason`，後者支援協定 §3.5 dual-review。 |
| `report_result` | `ReportResultArgs` | `comm_tools` | Rust 加上 `reviewed_head`（review 當下的 git SHA，會出現在 metadata）、`thread_id`、`parent_id`。 |
| `request_information` | `RequestInformationArgs` | `comm_tools` | 無 |
| `broadcast` | `BroadcastArgs` | `comm_tools` | 無。雙方都把 `report` 從 `request_kind` 排除 —— broadcast 不能攜帶 per-correlation report。 |
| `list_instances` | `ListInstancesArgs` | `instance_tools` | TS 支援 `tags` 過濾（`src/outbound-schemas.ts:146-148`）；Rust 不接參數（`src/mcp/tools.rs` 的 `inputSchema.properties: {}`）。如果原本依賴 tag-based listing，遷移時請拿掉 filter，改成 client 端事後過濾，或改用 `team`（`create_team` / `update_team`）做路由。 |
| `create_instance` | `CreateInstanceArgs` | `instance_tools` | Rust 加上 `team` + `count`（同質 team）、`backends`（異質 team）、`layout` ∈ `{tab, split-right, split-below}`、`target_pane`、`task`（spawn 後注入的初始任務）。`layout` 與 `target_pane` 屬於 TUI 感知欄位，TS 沒有對應。 |
| `delete_instance` | `DeleteInstanceArgs` | `instance_tools` | 無 |
| `replace_instance` | `ReplaceInstanceArgs` | `instance_tools` | 無 |
| `start_instance` | `StartInstanceArgs` | `instance_tools` | 無 |
| `describe_instance` | `DescribeInstanceArgs` | `instance_tools` | Rust 多回傳 `waiting_on`、`waiting_on_since`、最後 heartbeat、last_polled_at、dispatch tracking —— 與下面 `set_waiting_on` / `report_health` 流程搭配。 |
| `set_display_name` | `SetDisplayNameArgs` | `instance_tools` | 無 |
| `set_description` | `SetDescriptionArgs` | `instance_tools` | 無 |
| `post_decision` | `PostDecisionArgs` | `decision_tools` | 無 |
| `list_decisions` | `ListDecisionsArgs` | `decision_tools` | 無 |
| `update_decision` | `UpdateDecisionArgs` | `decision_tools` | 無 |
| `task` | `TaskBoardArgs` | `task_tools` | **status enum 擴充。** TS:`open / claimed / done / blocked / cancelled`。Rust:`open / claimed / in_progress / blocked / verified / done / cancelled`。新增 `due_at`、`duration` 表達期限。新加的 `in_progress` 與 `verified` 兩個狀態對應協定 §10.3 的 three-state completion（`in_progress` → `verified` → `done`）。 |
| `create_team` | `CreateTeamArgs` | `team_tools` | Rust 加上 `orchestrator`（必須是 member；接收 team-level routing）。 |
| `update_team` | `UpdateTeamArgs` | `team_tools` | Rust 加上 `orchestrator`（重新指派 orchestrator）。 |
| `list_teams` / `delete_team` | 同上 | `team_tools` | 無 |
| `create_schedule` | `CreateScheduleArgs` | `schedule_tools` | **trigger 拆分。** TS:只接受 cron expression。Rust:可選 `cron`（recurring）**或** `run_at`（ISO 8601 one-shot）—— 兩者互斥。One-shot 觸發後或被偵測為 missed 後自動 disable。 |
| `list_schedules` / `update_schedule` / `delete_schedule` | 同上 | `schedule_tools` | `update_schedule` 兩個 trigger 欄位都接受；補哪個就替換 trigger kind。 |
| `deploy_template` / `teardown_deployment` / `list_deployments` | `*Args` | `deploy_tools` | 無 |
| `checkout_repo` / `release_repo` | `*Args` | `repo_tools` | 無 |

### Rust 新增的工具（TS 沒有對應）

下面這 11 個工具，是把現有 `@suzuke/agend` agent prompt 移植過來時最該關注的。按所屬軌列出。

#### Comms — pull side

| 工具 | 用途 | 為什麼遷移時重要 |
|---|---|---|
| `inbox` | Drain 寄到本實例的待收訊息。回傳 `{messages: [...]}`，並對 Telegram 已綁定的 binding emit `AgentPickedUp` event（每筆 pickup 對應一個 ✅ 反應）。 | TS 上每一則跨實例訊息都會直接打進 pane（透過 tmux）；agent 重啟意味著 in-flight 的訊息會丟。Rust 的 inbox 會持久化，crash 在任務中途的 agent 在 resume 時可呼叫 `inbox` 補回未讀。 |
| `describe_message` | 用 ID 查 inbox 訊息狀態 —— 回傳 `ReadAt`（含 timestamp）、`UnreadExpired` 或 `NotFound`。選填 `instance` 把 lookup 限定到該實例的 inbox。 | 寄送方可在 retry 前確認對方有沒有 pick up 這條訊息。TS 沒有對應 —— 只能從沉默猜。 |
| `describe_thread` | 取出 thread 內所有訊息，按 timestamp 排序。選填 `instance` 限定到某個收件人 inbox。 | 用來事後重建多 hop 協作 trace（impl → reviewer → impl …）。和 `send_to_instance` / `delegate_task` / `report_result` 新增的 `thread_id` / `parent_id` 欄位搭配使用。 |

#### Comms — presence 與 process control

| 工具 | 用途 | 為什麼遷移時重要 |
|---|---|---|
| `set_waiting_on` | 宣告本實例現在被誰擋住（`condition` 字串）。空字串清除。Daemon 自動衰減 stale 條目 —— 見 `set_waiting_on` handler 在 `src/mcp/handlers.rs:1033-1063`。 | 取代 TS 上 agent 把「我在等 reviewer」之類 prose 寫進訊息的做法。現在是 machine-readable；orchestrator 可以 `list_instances` 直接看誰被誰擋住。 |
| `clear_blocked_reason` | 在不重寫 `waiting_on` 的情況下，強制清除 stale 阻塞原因。 | Orchestrator 在阻塞條件已解決但 blocked 實例尚未察覺時使用（例如 reviewer 已給 verdict，implementer 還在等）。 |
| `report_health` | 回報自己的 liveness / state 給 daemon，配合 heartbeat path。 | 取代 TS 那種「MCP server 還連著就算活著」的隱式訊號 —— 現在改成顯式、結構化。 |
| `interrupt` | 對目標 agent 的 PTY 注入 ESC byte（`0x1b`），中斷當下 LLM turn。選填 `reason` 會在 ESC 後當作後續 prompt 注入。Context 保留，agent 接受下一個 prompt。 | TS 完全沒有從外部中斷 LLM 一輪生成的方式 —— 只能等 timeout 或殺掉 pane。各 backend 是否真把 ESC 當「停止生成」是上面「信號與 ESC byte 語意」小節裡的 `pending`。 |
| `tool_kill` | 對目標 agent 的 PTY foreground process group 發 `SIGINT`，取消活躍中的**工具子進程**而保留 agent session。Unix only。成功時回傳 `{ok: true, pgid}`。 | 在 agent 卡在長時間 shell 命令（`cargo build`、`pytest …`）但你想保留 agent chat history 時用。TS 沒有對應 —— 唯一脫困的方法是殺整個 pane 重來。 |

#### TUI control

| 工具 | 用途 | 為什麼遷移時重要 |
|---|---|---|
| `move_pane` | 把實例的 pane 移到 daemon TUI 內的另一個 tab。會 split 既有 tab 的 focused pane，或建立新 tab。Scrollback 與 PTY state 保留。 | TS 沒有 TUI 可移 pane。如果你 TS agent 是用 `delete_instance` + `create_instance` 來「視覺上搬位置」，請改用 `move_pane` —— 它保留 session、scrollback、worktree。 |

#### CI watching

| 工具 | 用途 | 為什麼遷移時重要 |
|---|---|---|
| `watch_ci` | 監看 GitHub Actions CI（指定 repo + branch）。CI 進入終端狀態（success / failure 或任何 terminal state）時，事件自動注入 watching agent 的 inbox。若 daemon env 有 `GITHUB_TOKEN` 走認證 polling；否則退化為非認證 polling（fleet 共享 60 req/hr），response 中會帶 `warning` 欄位。 | TS agent 用 `gh pr checks --watch` 從 shell 輪詢，會卡住 agent 並消耗 token。Rust 把 polling 移到 daemon，agent 只在終端狀態被通知。 |
| `unwatch_ci` | 停止監看某 repo 的 CI。 | n/a —— 與 `watch_ci` 配對。 |

### 跨實例 comms —— 整份遷移最深的 friction

這是 dev-lead 點名要寫最深的區塊，所以下面端到端走一個具體遷移情境。

**TS pattern（今天）:**
```
agent A: send_to_instance(target='B', message='please review PR #42', request_kind='task')
  ↓ TS daemon 透過 outboundHandlers['send_to_instance'] 路由
  ↓ Bug #57 cost-guard 預檢（B 超出預算就丟掉）
  ↓ targetIpc.send({type: 'fleet_inbound', targetSession: 'B', content, meta: {...}})
  ↓ B 的 MCP server 收到 fleet_inbound，把它打進 B 的 pane，前綴 [from:A]
agent B（在工作）:在 chat 看到訊息，自行決定要不要中斷現任務回應。
agent B（離線）:訊息消失 —— TS 不會把 `fleet_inbound` 持久化到 pane buffer 之外。
```

**Rust pattern（遷移後）:**
```
agent A: send_to_instance(target='B', message='please review PR #42', request_kind='task',
                          thread_id='th-pr42', parent_id='m-…')
  ↓ Rust daemon 透過 mcp/handlers.rs 的 send_to_instance 路由
  ↓ 寫入 B 的 inbox 檔（<home>/inbox/<B>.json，持久化）
  ↓ 若 B 已綁定 Telegram topic，Telegram sink 發 UX event
agent B（在工作）:下一次 [AGEND-MSG] system reminder 會帶這條訊息 header，B 可呼叫 inbox drain。
agent B（離線 / 重啟中）:inbox 檔仍在；下次啟動 B 透過 inbox 看到 pending 訊息。
agent A:可隨後呼叫 describe_message(message_id=…) 或 describe_thread(thread_id='th-pr42') 確認 pickup。
```

遷移時 prompt 與 runbook 必須調整的事:

1. **不要再假設 push delivery 就夠**。如果你的 agent 有可能漏掉訊息（重啟、crash、手動 stop），在啟動時加上 `inbox` check。Rust daemon 已經會在新訊息到達時用 `[AGEND-MSG]` system reminder 提醒，但要 drain backlog 與透過 `AgentPickedUp` 確認 pickup，仍需顯式 `inbox` 呼叫。
2. **採用 `thread_id` 與 `parent_id`**。協定的協作模式（delegate → ack → report；review → finding → re-review）在 thread 鏈上是天然 traceable。TS 用 prose `correlation_id` 串相同模式；Rust 仍接受 `correlation_id`，但補上結構化的這對欄位。
3. **用 `set_waiting_on` 取代 prose**。把「我在等 reviewer」打進 chat 機器讀不到；`set_waiting_on(condition='review from at-dev-4 on PR #63')` 可由 `describe_instance` 查詢，也可用 `list_instances` 全 fleet 列出。
4. **把 TS 時代的「殺了重生」模式換成 `interrupt` 與 `tool_kill`**。如果你的 TS prompt 寫「agent 卡住就 replace」，改寫為「agent 卡在 LLM turn 中就 `interrupt(target=…)`；卡在 tool subprocess 中就 `tool_kill(target=…)`；replace 留給最後手段」。
5. **`request_kind: 'report'` flow 要帶 `reviewed_head`**。reviewer 在 `report_result` 時附上 review 當下的 git SHA。Rust 的 merge gate（協定 §10.3 / §3 metadata fields）把這個欄位視為 staleness 判定的 load-bearing 訊號。

### Tool-set 設定檔

TS 透過 `AGEND_TOOL_SET`（`src/channel/mcp-tools.ts:120-126`）暴露兩個 profile:
- `standard`:`reply, react, edit_message, send_to_instance, broadcast, list_instances, describe_instance, list_decisions, post_decision, task, set_display_name, set_description`
- `minimal`:`reply, send_to_instance, list_decisions, download_attachment`

Rust 目前在 `src/mcp/tools.rs` 沒有暴露 tool-set profile —— 每個 spawn 出來的 agent 看到全部 45 個工具。**`pending`** 確認:若 Sprint 11 在 Rust 端加 profile 機制，依賴 TS `minimal` 來壓 token cost 的 agent 可能要重調。在那之前，請把 Rust 的工具箱當 `full` 看待去 prompt-engineer。

## Migration steps {#migration-steps}

7 階段 actionable plan。第 2 / 3 / 4 / 5 節是參考材料,本節是執行順序。

### 1. 遷移前 audit (在 TS 上)

清點你依賴的狀態。動 `agend-terminal` 之前,在既有 `@suzuke/agend` 安裝上執行:

- `agend ls` —— 列出每個運行中的 instance、其 `working_directory` 與 `topic_id`。存下輸出。
- `agend topic list` —— 列出每個 Telegram topic binding。存下輸出。
- `agend access list` —— 列出 `channel.access.allowed_users` 的每個條目。存下輸出。記下你的 `access.mode` 是 `pairing` 還是 `locked` —— 這對 [Phase A High-friction #1](#fleet-yaml-schema-diff) 很重要。
- `agend schedule list` —— 列出每個 active 排程。存下輸出。注意:Rust 沒有 schedule CLI 對等,要透過 MCP tool 或 TUI overlay 重建 (見 [§2 Schedule group](#cli-flag-mapping))。
- 從頭到尾讀過 `~/.agend/fleet.yaml`。確認你填了哪些欄位;[§3 fleet.yaml schema diff](#fleet-yaml-schema-diff) 會告訴你哪些有 Rust 對等、哪些沒有。
- `agend fleet history` 與 `agend fleet activity` (若有依賴) —— 注意兩者 Rust 端都沒 CLI 對等 (Rust 上直接讀 `$AGEND_HOME` 下的 log 檔)。

如果 fleet 操作的 repo 有 commit `AGENTS.md` / `GEMINI.md`,現在就 audit。Phase B 已記載 [OpenCode 改寫 `AGENTS.md` 的行為變化](#backend-invocation-diff);你的 `.gitignore` 姿態會有影響。

### 2. Snapshot 資料

動任何東西之前,做三份耐久備份:

```bash
# 複製 fleet config
cp ~/.agend/fleet.yaml ~/.agend/fleet.yaml.pre-migration.backup

# 整個 $AGEND_HOME 打包 (decisions DB、instance state、daemon log 等)
tar czf ~/agend-home-pre-migration-$(date +%Y%m%d).tar.gz -C "$HOME" .agend

# 記下 @suzuke/agend 版本
agend --version > ~/agend-version-pre-migration.txt
```

第三個檔案是 rollback 目標 —— 寫下來,需要時可以裝同一個版本。

### 3. 選遷移模式

- **Greenfield (全新安裝)** —— 推薦,除非你有值得帶過去的歷史狀態。`agend-terminal init` 從頭跑,手寫一份依 §3 推導的 `fleet.yaml`。除了步驟 2 的備份,捨棄 `@suzuke/agend` 歷史。較快、較乾淨、schema 差異會早點浮現。
- **In-place** —— 把 `~/.agend/fleet.yaml` 複製到 Rust daemon 的 config 位置,然後依 §3 的 diff 表逐項調整,直到 daemon 願意載入。較慢、較多 debug,適合有非平凡 decision 歷史或 template 用法的 fleet。**這條路千萬不要省掉步驟 2**。

如果不確定怎麼選,先在 sandbox VM 跑一次 greenfield、看順不順,再回來做 in-place。

### 4. Workflow 改變:每 branch 一個 git worktree

`agend-terminal` 期待每個 instance 跑在 **獨立的 working directory** —— 對 git repo 來說,代表 daemon 操作的每個 branch 都要一個 worktree。這是 Rust resume 策略隱含的 (各 backend 的 `ContinueInCwd { flag }` 模式以 cwd 為 key 找「最近 session」,所以不同 cwd 才會對應到不同 session)。也是全域 `CLAUDE.md` operator policy 的硬規則。

如果你的 `@suzuke/agend` workflow 是多個 instance 在同一個 checkout 上 (用 `git checkout` 切 branch) 編輯,Rust 上你需要改兩件事:

```bash
# 對你想讓 instance 操作的每個 branch:
git worktree add ../my-repo.worktrees/<branch-name> <branch-name>

# 然後讓 instance 的 working_directory 指到 worktree 路徑:
# instances:
#   worker-a:
#     working_directory: /path/to/my-repo.worktrees/feat-x
```

這避免並行 agent 之間的 checkout race,並且和 Rust daemon 的 session-per-cwd 模型對齊。

### 5. Cross-link integrate (套用各節 diff)

這是真正動用 §2 / §3 / §4 / §5 的時刻。逐節把 mapping 套用到你 migrate 後的 `fleet.yaml`、prompts、runbook:

- **CLI flag substitution** → 重讀 [§2 CLI flag mapping](#cli-flag-mapping)。每個你 script、cron、CI 中的 `agend …` 呼叫,換成 `agend-terminal` 的對等。如果該 row 寫 **Removed**,就走那 row 列出的 operator migration action (讀 log 檔 / 改 `fleet.yaml` / 用 MCP tool / 依賴 OS-native service)。
- **`fleet.yaml` 逐欄位** → 重讀 [§3 fleet.yaml schema diff](#fleet-yaml-schema-diff)。三個 high-friction 項 #1 (`user_allowlist` fail-closed)、#2 (`group_id` 嚴格 `i64`,port 時 un-quote)、#3 (`outbound_capabilities` Rust-only required) 都是阻擋級的 —— 沒處理 daemon 不會載入。14 個被移除的 `InstanceConfig` 欄位都有 Rust 替代位置 (env var / backend preset / per-backend instruction file),按需要套用。
- **Backend invocation 模式** → 重讀 [§4 Backend invocation diff](#backend-invocation-diff)。如果你直接 script CLI invocation (不是只透過 daemon),只有 Codex 形狀變了 (resume 回到子命令)。確認三個 behavior change flag:OpenCode 改寫 `AGENTS.md`、Kiro 改 per-workdir 命名、Kiro 改在 Ready 後當 user message 注入。
- **MCP tool API** → 重讀 [§5 MCP tool API diff](#mcp-tool-api-diff)。§5 列出五項 prompt 改動 (從「不要再假設 push delivery 夠」一直到「`request_kind: 'report'` 改用 `reviewed_head`」)。更新 agent prompts 與 runbook。

### 6. 遷移後 smoke test 清單

在宣告遷移完成前跑這些。每項測一個獨立面向:

- [ ] **Daemon 啟動。** `agend-terminal start --detached` (或你慣用的啟動路徑)。`agend-terminal status` 回報 daemon alive 並列出每個 configured instance。
- [ ] **Bot 回基本訊息。** 從 allowlisted 的 Telegram 帳號發任何訊息。綁定 instance 收到 (`agend-terminal logs <instance>` 或 pane scrollback 顯示 inbound) 並回覆 —— 代表 `outbound_capabilities` (尤其 `reply`) 設定正確。
- [ ] **Inbound user-allowlist gate。** 從非 allowlisted 帳號發訊息。確認 daemon log 有對應 user_id 的 inbound 拒絕記錄 (`grep "outbound notify dropped" $AGEND_HOME/daemon.log` —— 沒看到記得 `RUST_LOG=debug`)。Bot 不回覆。
- [ ] **跨實例 dispatch。** 從一個 agent 對另一個發 `delegate_task`。收件方看到 `[AGEND-MSG]` system reminder,可透過 `inbox` drain。`describe_message(message_id=…)` 確認 pickup。請確保兩個 agent 都 idle 時跑這個測試,或若想驗證 busy-override 路徑就傳 `force: true` —— 對 mid-LLM-turn 收件方發 `delegate_task` 預設會回 BUSY (Rust PR #149 在 Sprint 8 加入 busy gate;PR #161 在 Sprint 10 把 `interrupt`/`reason` 改名為 `force`/`force_reason`)。
- [ ] **`set_waiting_on` round-trip。** 一個 agent 宣告 `set_waiting_on(condition=…)`,第二個 agent `describe_instance(<first>)` 確認欄位浮現。
- [ ] **Cost-guard 預檢。** 若有設 `cost_guard`,刻意把 target 推過日預算 (或在測試中 stub `isLimited`),確認 sender 拿到 cost-guard error 字串而非靜默 drop。
- [ ] **CI watch loop** (僅在你之前用 `gh pr checks --watch` 輪詢時相關)。發 `watch_ci(repo, branch)`,確認 CI 結束時自動注 inbox event,不需 agent 自己輪詢。
- [ ] **Config 重載。** 改 `fleet.yaml`、`agend-terminal stop`、`agend-terminal start`,確認改動生效 (Rust 沒有熱 `reload` —— 見 [§2](#cli-flag-mapping))。

任何一項失敗,**不要** 進到步驟 7。失敗阻擋 operator 就 rollback;否則就 debug 後重跑。

### 7. Rollback 路徑

如果 `agend-terminal` 進水你需要退回:

1. **停 `agend-terminal`** (`agend-terminal stop`)。
2. **從步驟 2 的 `.tar.gz` 還原 pre-migration 的 `$AGEND_HOME`**。
3. **重新安裝先前運行的 `@suzuke/agend` 版本** (用步驟 2 存的版本字串)。
4. `agend start`,並用步驟 1 做的遷移前 smoke test 驗證。
5. **送一個 `agend-terminal` issue**,內容包含:
   - `daemon.log` 裡相關行 (若踩到 fail-closed gate,記得帶 `RUST_LOG=debug` 重現再貼)。
   - 你的 `fleet.yaml`,secrets 已 redact。
   - Rust binary 版本 (`agend-terminal --version`)。

成功遷移後請 **保留 pre-migration 備份至少 30 天**。Pre-alpha 期間 schema 變動,可能在 cutover 後幾天才浮現問題。

## Known incompatibilities and deferred parity {#known-incompatibilities}

這節是明確的 risk register。每一項都是 operator 應該在 **承諾遷移前** 就知道、而不是事後才發現。

### `agend-terminal` 移除的 TS-only 指令

依 [§2 CLI flag mapping](#cli-flag-mapping),下列 `agend …` 呼叫 Rust 沒有 CLI 對等。每一項在 §2 都記載 operator 解法;這裡 recap 為了把 risk 攤開:

- `agend init` —— 由 `agend-terminal quickstart` 取代 (問題集合不同)。
- `agend restart` / `fleet restart` —— 用 `stop` + `start`。
- `agend reload` —— 沒有熱重載;改 daemon 需要 stop/start。
- `agend logs <instance>` / `fleet logs` —— 直接讀 `$AGEND_HOME` 下的 log 檔。
- `agend fleet history` / `fleet activity` / `fleet cleanup` —— 無對等。Stale instance 資料夾不自動清,需要時手動刪。
- `agend backend trust <dir>` —— 改成手動跑一次 backend CLI 接受其 trust 對話框。
- `agend topic *` (list/bind/unbind) —— 改宣告式,只透過 `instances.<name>.topic_id` 在 `fleet.yaml` 設定。
- `agend access *` (lock/unlock/list/remove/pair) —— 改宣告式,透過 `channel.user_allowlist`。`pairing` 模式無對等 (見下)。
- `agend schedule *` —— 搬到 MCP tool (`create_schedule` / `list_schedules` 等) 與 TUI overlay。
- `agend update` —— 部分由 `agend-terminal upgrade` 涵蓋 (僅 Unix)。
- `agend install` / `uninstall` —— Service 註冊改交 `systemd` / `launchd`。
- `agend web` —— 由 TUI (`agend-terminal app`) 取代。
- `agend export` / `import` / `export-chat` —— 沒有 archive 格式。需要備份就直接複製 `$AGEND_HOME`。
- `agend health` —— 折進 `agend-terminal doctor`。

### 移除的 TS-only fleet.yaml 欄位

依 [§3 fleet.yaml schema diff](#fleet-yaml-schema-diff),14 個 `InstanceConfig` 欄位 + 4 個 top-level 鍵 Rust 沒有對應位置。每個都有 Rust 替代方案:

- **Per-instance**:`tags`、`general_topic`、`restart_policy`、`context_guardian`、`log_level`、`tool_set`、`lightweight`、`systemPrompt`、`skipPermissions`、`model_failover`、`cost_guard`、`workflow`、`startup_timeout_ms`、`agent_mode`。
- **Top-level**:`project_roots`、`profiles`、`health_port`、`stt`。

砍掉欄位;有依賴的話套用 Rust 替代 (env var / backend preset / per-backend instruction file)。§3 的表是逐 row 的權威指引。

### TS-only 存取語意 Rust 沒有對應

- **Pairing mode。** TS `AccessConfig.mode: "pairing"` (透過 `agend access pair` 發碼,使用者兌換後 ID 進到 `channel.access.allowed_users`) Rust 無對等。Rust 上每個授權使用者必須明確列在 `channel.user_allowlist`。如果你的 TS 安裝是 pairing mode,遷移前先 `agend access list`,把結果列進 Rust allowlist (也記載在 [Phase A High-friction #1](#fleet-yaml-schema-diff))。

### 待補的 parity (Rust roadmap)

這些不是「移除」—— 是 Rust 目前缺 TS 功能、且有計畫補 (或硬化現有行為) 的項目。**不要** 依賴 *目前* 行為跨過下面所列的里程碑:

- **`outbound_capabilities` 兩階段 transition。** Sprint 22 P0 給「warn-but-permit one daemon cycle」grace;**Sprint 23 把 absent 升為 hard parse error**。Sprint 23 ship 後,operator 自寫的每個 instance 必須在 `fleet.yaml` 明確宣告 `outbound_capabilities`,不然 daemon 拒絕載入。Built-in coordinator (`general` 與未來自動建立的 coordinator) 自動注入 `[reply, react, edit, inject_provenance]`;user-authored entry 不會自動注入。詳見 [Phase A High-friction #3](#fleet-yaml-schema-diff)。
- **PTY transport / signal capability matrix。** [§4 信號與 ESC byte 語意](#backend-invocation-diff) 把四個 backend 的 `interrupt` / `tool_kill` 語意標 `pending`。Real-CLI 驗證目前以 backlog item 形式追蹤,filed in Sprint 11 (`t-20260425040356199333-6`);Sprint 22-25 roadmap 沒 commit 完成這項工作的特定 sprint window,且 operator 對「這項工作是否還值得做」本身在 review。對應 cell 上的 semantic 主張請當作未驗證。
- **`AGEND_TOOL_SET` profile。** TS 透過 `AGEND_TOOL_SET` 開放 `standard` (12-tool) 與 `minimal` (4-tool) tool profile (`src/channel/mcp-tools.ts:120-126`)。Rust 目前對所有 spawn 出來的 agent 都暴露完整 set (約 45 個工具)。如果你之前用 `minimal` 降低 per-instance token overhead,Rust 上 token 用量會比較高,直到 profile 機制實作。Tracked as follow-up;沒有 committed 的 Rust release。
- **跨 channel 架構。** `channel.user_allowlist` 與 `outbound_capabilities` 兩個 gate 目前以 Telegram 為主。Discord/Slack adapter 在 channel parity 完成後會透過 `auth.rs::gate_outbound_for_agent` 繼承同一組 gate;在那之前,各 channel 行為可能仍有落差。`agend-terminal` 的 `docs/MIGRATION-OUTBOUND-CAPS.md` operator 完整參考有跨 channel 架構備註。
- **`list_instances` 的 `tags` filter** (TS-only)。[Phase B §5.2](#mcp-tool-api-diff) 標記為 open question —— TS `list_instances` 接 `tags` filter,Rust 目前不接參數。如果你依賴 tag-filter 的 instance 列舉,在 parity 補上前請改手動列。

### 過渡期的功能限制

- **`cost_guard`。** TS 支援 per-instance cost guard (覆寫 fleet 預設) 加上 #57 後的 outbound dispatch pre-check。Rust 目前 `InstanceConfig` 沒 `cost_guard` 欄位。如果你依賴 per-instance 成本上限,計畫好 Rust 上是 fleet-wide 單一政策的世界,直到 parity 補上。
- **`channel.user_allowlist` 必須明確列舉。** TS 上的 pairing-mode 使用者必須列進 Rust 的 `channel.user_allowlist`。Rust 上沒有讓使用者「兌換 code 進 allowlist」的流程;需要 operator 動作。
- **Discord guild ID 必須 un-quote。** TS canonical 對 Telegram supergroup ID 用裸 int、對 Discord guild ID 用 quoted string (避開 JS `Number` 精度)。Rust 兩種都只接受裸 int。Migrate 後的 `fleet.yaml` 中,任何 quoted `group_id` 都要 un-quote。詳見 [Phase A High-friction #2](#fleet-yaml-schema-diff)。

### Operator 注意事項

- **`user_allowlist` drop log 是 `DEBUG`,不是 `WARN`。** 在預設 `RUST_LOG=info` 下,`outbound notify dropped — channel not authorised` 那行看不到 —— `grep` 找不到,自然結論「config OK」是錯的。重現存取 gate 失敗時請先設 `RUST_LOG=debug` (或 `RUST_LOG=agend_terminal=debug`)。`agend-terminal` Sprint 22 P1 backlog 有把這行升為 `WARN` 的項目;在那之前 operator-facing caveat 仍然成立。
- **Pre-alpha schema 不穩定。** 如 [§1 Pre-alpha 注意事項](#why-migrate) 強調,鎖版本、每次升級前讀 release notes、cutover 後保留 pre-migration 備份至少 30 天。兩階段 transition (warn-but-permit → hard error) 在這時期 release 之間移動很快。
- **目前沒有 `agend-terminal` archive 格式。** 跨機器搬 fleet config 是 `tar` 整個 `$AGEND_HOME` (或手動 copy `fleet.yaml`),不是 `agend export` / `import` round trip。
- **Rust 不用 `tmux`。** 如果你的 operator 習慣含 `tmux attach -t agend` 之類捷徑,遷移後不適用。改用 `agend-terminal attach <instance>` 直接接 PTY,或 `agend-terminal app` 進多 pane TUI。
