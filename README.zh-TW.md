# claude-channel-daemon

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-compatible-blueviolet.svg)](https://docs.anthropic.com/en/docs/claude-code)

**用手機管理一整個 Claude Code agent 團隊。** 一個 Telegram bot、無限專案——每個 Forum Topic 就是一個獨立的 Claude session，crash 自動恢復，不用顧。

[English](README.md)

> **⚠️ 注意：** daemon 使用 Claude Code 原生的 permission relay——權限請求會以 Telegram inline 按鈕（允許／拒絕）轉發給你。詳見[權限系統](#權限系統)。

## 為什麼要做這個

Claude Code 的官方 Telegram plugin 是 **1 bot = 1 session**。終端機關掉，bot 就斷了。沒有排程、不支援多專案。

**claude-channel-daemon** 把 Claude Code 變成一個 always-on 的多專案 AI 工程團隊，全從 Telegram 操控：

| 功能 | 官方 Plugin | claude-channel-daemon |
|------|:-:|:-:|
| 同時跑多個專案 | — | **N 個 session，1 個 bot** |
| 關掉終端機 / SSH 斷線也不怕 | — | **tmux 持久化** |
| Cron 排程任務 | Session 級（3 天到期） | **持久化（SQLite）** |
| 自動 context 輪替（避免 session 老化）| — | **內建** |
| 權限請求 Telegram 確認 | 文字回覆 | **Inline 按鈕** |
| 語音訊息 → Claude | — | **Groq Whisper** |
| 透過 General topic 動態建立 Instance | — | **內建** |
| 裝成系統服務（launchd/systemd）| — | **一行指令** |
| Crash 自動恢復 | — | **自動重啟** |
| 花費上限（每日限額）| 平台級（`--max-budget-usd`） | **每 Instance 每日限額** |
| 從 Telegram 看 Fleet 狀態 | — | **/status 指令** |
| 每日 Fleet 摘要 | — | **排程報告** |
| 卡住偵測 | — | **自動偵測 + 通知** |
| 點對點 Agent 協作 | — | **內建** |

## 適合誰

- **獨立開發者**——讓 Claude 全天候同時處理多個 repo
- **小型團隊**——共用一個 bot，每個人各自的 Forum Topic
- **CI/CD 重度使用者**——用 cron 排程讓 Claude 做每日 PR review、deploy 檢查
- **安全意識強的人**——需要工具使用的明確權限審批
- 受夠了為了跟 Claude 說話得一直開著終端機的人

## 跟其他方案比較

| | claude-channel-daemon | Claude Code Telegram Plugin | Cursor | Cline (VS Code) |
|---|:-:|:-:|:-:|:-:|
| 無頭執行（不需要 IDE/終端機）| **有** | 需要終端機 | 沒有 | 沒有 |
| 多專案 Fleet | **有** | 1 個 session | 1 個視窗 | 1 個視窗 |
| 多頻道（Telegram、Discord）| **有** | 只有 Telegram | N/A | N/A |
| 排程任務 | **持久化** | Session 級 | 沒有 | 沒有 |
| Context 自動輪替 | **有** | 沒有 | N/A | 沒有 |
| 權限審批流程 | **Inline 按鈕** | 文字回覆 | N/A | 有限 |
| 手機優先（Telegram）| **有** | 有 | 沒有 | 沒有 |
| 語音輸入 | **有** | 沒有 | 沒有 | 沒有 |
| 系統服務 | **有** | 沒有 | N/A | N/A |
| 花費控管 | **每 Instance** | 平台級 | N/A | N/A |
| Model Failover | **自動切換** | 沒有 | 沒有 | 沒有 |
| Crash 自動恢復 | **有** | 沒有 | N/A | N/A |

## 架構

```
                          ┌──────────────────────────────────────────────────────────────┐
                          │                       Fleet Manager                          │
                          │                                                              │
Telegram ◄──long-poll──► │  ChannelAdapter          Scheduler (croner)                  │
Discord  ◄──gateway────► │  (Telegram/Discord)         │                                │
                          │       │                     │ cron 觸發                       │
                          │  threadId 路由表             │                                │
                          │  #277→proj-a  #672→proj-b   │                                │
                          │       │                     │    CostGuard   HangDetector    │
                          │  ┌────┴────┐  ┌────┴────┐  ┌────┴────┐    WebhookEmitter    │
                          │  │Daemon A  │  │Daemon B  │  │Daemon C  │                    │
                          │  │Permission│  │Permission│  │Permission│                    │
                          │  │Relay     │  │Relay     │  │Relay     │                    │
                          │  │Context   │  │Context   │  │Context   │                    │
                          │  │Guardian  │  │Guardian  │  │Guardian  │                    │
                          │  └────┬─────┘  └────┬─────┘  └────┬─────┘                    │
                          │       │              │              │                         │
                          │  ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐                   │
                          │  │tmux win  │  │tmux win  │  │tmux win  │                   │
                          │  │Claude    │  │Claude    │  │Claude    │                   │
                          │  │+MCP srv  │  │+MCP srv  │  │+MCP srv  │                   │
                          │  └──────────┘  └──────────┘  └──────────┘                   │
                          └──────────────────────────────────────────────────────────────┘
```

## 核心功能

### Fleet 模式——一個 bot，多個專案

每個 Telegram Forum Topic 對應一個獨立的 Claude Code session。開個 topic、選專案目錄，Claude 就開始工作。刪除 topic，instance 自動停止。你的機器能撐多少個專案就開多少個。

### 排程任務

Claude 可以透過 MCP tools 建立 cron 排程。排程存在 SQLite 裡，daemon 重啟後會自動恢復。

```
使用者：「每天早上 9 點，幫我檢查有沒有需要 review 的 PR」
Claude → create_schedule(cron: "0 9 * * *", message: "檢查需要 review 的 PR")
```

MCP tools：`create_schedule`、`list_schedules`、`update_schedule`、`delete_schedule`

協作 MCP tools：`list_instances`、`send_to_instance`、`start_instance`、`create_instance`、`delete_instance`

排程可以指定目標 instance，或是在建立排程的同一個 instance 上觸發。觸發時，daemon 會像使用者發訊息一樣把內容推送給 Claude。

### Context 輪替

監控 Claude 的 status line JSON。是個 5 狀態的 state machine：

```
NORMAL → PENDING → HANDING_OVER → ROTATING → GRACE
```

- **PENDING** — context 超過門檻（預設 60%），等 Claude 空閒
- **HANDING_OVER** — 送 prompt 讓 Claude 把狀態存到 `memory/handover.md`
- **ROTATING** — 砍 tmux window，用 `--resume` 開新 session
- **GRACE** — 10 分鐘冷卻期，防止快速重複輪替

也會在 `max_age_hours`（預設 8h）後不管 context 用量直接輪替。

### 點對點 Agent 協作

每個 instance 都是對等的 peer，可以發現、喚醒、建立和傳訊給其他 instance。不需要 Dispatcher——協作能力來自每個 agent 都有的 MCP tools。

協作 MCP tools：

- `list_instances` — 查看所有已設定的 instance（執行中或已停止），包含狀態和工作目錄
- `send_to_instance` — 傳訊息給另一個 instance 或外部 session
- `start_instance` — 喚醒已停止的 instance
- `create_instance` — 從專案目錄建立新 instance 和 topic（支援 `--branch` 用 git worktree 隔離 feature branch）
- `delete_instance` — 移除 instance 和其 topic

訊息會顯示在接收者的 Telegram topic 裡。只有 instance 對 instance 的訊息才會在發送者 topic 顯示通知。

對已停止的 instance 發 `send_to_instance` 時，錯誤訊息會提示使用 `start_instance()`——agent 可自行修正，無需人工介入。

### General Topic Instance

一個綁定到 Telegram General Topic 的普通 instance。Fleet 啟動時自動建立，作為自然語言入口，處理不屬於特定專案的任務。行為完全由其專案的 `CLAUDE.md` 定義：

- 簡單任務（網頁搜尋、翻譯、一般問題）——直接處理
- 專案相關任務——用 `list_instances()` 找到對的 agent，需要時 `start_instance()`，再用 `send_to_instance()` 委派
- 建新專案——用 `create_instance()` 建立新 agent

在 General topic 用 `/status` 可看 fleet 概覽。其他專案管理都由 General instance 透過自然語言處理。

### 外部 Session 支援

你可以把本地的 Claude Code session 連到 daemon 的 channel tools（reply、send_to_instance 等），只要在 `.mcp.json` 指向 instance 的 IPC socket：

```json
{
  "mcpServers": {
    "ccd-channel": {
      "command": "node",
      "args": ["path/to/dist/channel/mcp-server.js"],
      "env": {
        "CCD_SOCKET_PATH": "~/.claude-channel-daemon/instances/<name>/channel.sock"
      }
    }
  }
}
```

Daemon 透過 env var 分層自動隔離外部和內部 session：

| Session 類型 | 身份來源 | 範例 |
|---|---|---|
| 內部（daemon 管理）| `CCD_INSTANCE_NAME`（tmux 環境）| `ccplugin` |
| 外部（自訂名稱）| `.mcp.json` 的 `CCD_SESSION_NAME` | `dev` |
| 外部（零設定）| `external-<basename(cwd)>` fallback | `external-myproject` |

內部 session 由 daemon 在 tmux shell 環境注入 `CCD_INSTANCE_NAME`。外部 session 沒有這個變數，所以 fallback 到 `CCD_SESSION_NAME`（有設定時）或用工作目錄自動產生名稱。同一份 `.mcp.json`，內外身份不同，零衝突。

外部 session 會出現在 `list_instances` 中，可被 `send_to_instance` 定向投遞。

### 優雅重啟

`ccd fleet restart` 發送 SIGUSR2 給 fleet manager。它會等所有 instance 空閒（10 秒無 transcript 活動）後逐一重啟。5 分鐘超時防止卡住。

### Telegram 指令

Topic 模式下，bot 在 General topic 回應以下指令：

- `/status` — 查看 Fleet 狀態和花費

專案管理指令（`/open`、`/new`、`/meets`、`/debate`、`/collab`）已在 v0.3.4 移除。現在由 General instance 透過自然語言處理——直接告訴它你需要什麼，它會自動使用 `create_instance`、`start_instance` 或 `send_to_instance`。

### 權限系統

使用 Claude Code 原生的 permission relay——權限請求會以 Telegram inline 按鈕（允許／拒絕）轉發給你。當 Claude 要求使用敏感工具時，daemon 會在 Telegram 上提示你，並等待你的回應後才繼續執行。

### 語音轉文字

Telegram 語音訊息透過 Groq Whisper API 轉文字後送給 Claude。Topic 模式和 DM 模式都支援。需要在 `.env` 設定 `GROQ_API_KEY`。

### 動態 Instance 管理

Instance 透過 General instance 使用 `create_instance` 建立。告訴 General instance 你想處理什麼專案——它會自動建立 Telegram topic、綁定專案目錄、啟動 Claude。也可以用 `--branch` 建立 git worktree 來隔離 feature branch。刪除 topic 會自動解除綁定並停止 instance。用 `delete_instance` 可完全移除 instance 和其 topic。

### 花費上限

防止無人看管時帳單暴增。在 `fleet.yaml` 設定每日花費上限：

```yaml
defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: "Asia/Taipei"
```

當 instance 接近上限時，會在其 Telegram topic 發出警告。達到上限時，instance 自動暫停並發送通知。暫停的 instance 隔天自動恢復，或手動重啟。

### Fleet 狀態

在 General topic 用 `/status` 查看即時概覽：

```
🟢 proj-a — ctx 42%, $3.20 today
🟢 proj-b — ctx 67%, $8.50 today
⏸ proj-c — paused (cost limit)

Fleet: $11.70 / $50.00 daily
```

### 每日摘要

每天在可設定的時間（預設 21:00）在 General topic 發送每日報告：

```
📊 Daily Report — 2026-03-26

proj-a: $8.20, 2 rotations
proj-b: $2.10
proj-c: $0.00 ⚠️ 1 hang

Total: $10.30
```

### 卡住偵測

如果 instance 超過 15 分鐘（可設定）沒有活動，daemon 會發出通知並附帶 inline 按鈕：

- **強制重啟** — 停止並重啟 instance
- **繼續等待** — 取消警報

使用多訊號偵測：同時檢查 transcript 活動和 statusline 更新時間，避免在長時間 tool call 時誤判。

### 速率限制感知排程

當 5 小時 API 速率限制超過 85% 時，排程觸發會自動延遲而非直接執行。延遲時會在 instance 的 topic 發出通知。延遲的排程不會遺失——下次 cron tick 時如果速率限制低於門檻就會觸發。

### Model Failover

當主要 model 遇到速率限制時，daemon 會在下次 context rotation 自動切換到備用 model。在 `fleet.yaml` 設定 failover 鏈：

```yaml
instances:
  my-project:
    model_failover: ["opus", "sonnet"]
```

切換時 daemon 會在 Telegram 通知你，速率限制恢復後會自動切回主要 model。

### Topic Icon + 閒置歸檔

執行中的 instance 會在 Telegram 顯示圖示。停止或 crash 時圖示會改變。閒置的 instance 會自動歸檔——發訊息到已歸檔的 topic 會自動重新開啟。

### 權限倒數 + Always Allow

權限提示現在會顯示倒數計時器，每 30 秒更新一次。「Always Allow」按鈕可以允許當前 session 中同一工具的所有後續使用。決定後會在訊息上顯示結果（「✅ 已允許」/「❌ 已拒絕」）。

### 結構化 Handover

Context rotation 現在使用結構化模板並驗證。Claude 會在 `memory/handover.md` 中以 Active Work、Pending Decisions、Key Context 三個區塊保存狀態。第一次驗證失敗時會自動重試。

### Service Message 過濾

Telegram 系統事件（topic 重新命名、釘選、成員加入等）會在到達 Claude 之前被過濾掉，節省 context window token。

### Health Endpoint

輕量 HTTP endpoint 供外部監控工具使用：

```
GET /health  → { status: "ok", instances: 3, uptime: 86400 }
GET /status  → { instances: [{ name, status, context_pct, cost_today }] }
```

在 `fleet.yaml` 設定：

```yaml
health_port: 19280  # top-level，預設 19280，綁定 127.0.0.1
```

### Webhook 通知

推送 fleet 事件到外部 endpoint（Slack、自訂儀表板等）：

```yaml
defaults:
  webhooks:
    - url: https://hooks.slack.com/...
      events: ["rotation", "hang", "cost_warn"]
    - url: https://custom.endpoint/ccd
      events: ["*"]
```

### Discord Adapter（MVP）

把 fleet 連到 Discord 而不是（或同時）Telegram。在 `fleet.yaml` 設定：

```yaml
channel:
  type: discord
  bot_token_env: CCD_DISCORD_TOKEN
  guild_id: "123456789"
```

### 外部 Adapter Plugin 系統

社群 adapter 可透過 npm 安裝並自動載入：

```bash
npm install ccd-adapter-slack
```

Daemon 會自動發現 `ccd-adapter-*` 命名慣例的 adapter。Channel type 從 package entry point 匯出，供 adapter 作者使用。

## 開始用

```bash
# 前置需求
brew install tmux        # macOS

# 安裝
npm install -g claude-channel-daemon

# 互動式設定
ccd init

# 啟動 fleet
ccd fleet start
```

## 指令

```
ccd init                  互動式設定精靈
ccd fleet start           啟動所有 instance
ccd fleet stop            停止所有 instance
ccd fleet restart         優雅重啟（等空閒後重啟）
ccd fleet status          看 instance 狀態
ccd fleet logs <name>     看 instance log
ccd fleet history         看事件記錄（花費、輪替、卡住）
ccd fleet start <name>    啟動特定 instance
ccd fleet stop <name>     停止特定 instance
ccd schedule list         列出所有排程
ccd schedule add          從 CLI 新增排程
ccd schedule delete <id>  刪除排程
ccd schedule enable <id>  啟用排程
ccd schedule disable <id> 停用排程
ccd schedule history <id> 看排程執行記錄
ccd topic list            列出 topic 綁定
ccd topic bind <n> <tid>  綁定 instance 到 topic
ccd topic unbind <n>      解除 topic 綁定
ccd access lock <n>       鎖定 instance 存取
ccd access unlock <n>     開放 instance 存取
ccd access list <n>       列出允許的使用者
ccd access remove <n> <uid> 移除使用者
ccd access pair <n> <uid> 產生配對碼
ccd export [path]         匯出設定（裝置遷移用）
ccd export --full [path]  匯出設定 + 所有 instance 資料
ccd import <file>         匯入設定檔
ccd install               裝成系統服務
ccd uninstall             移除系統服務
```

## 設定

Fleet 設定檔在 `~/.claude-channel-daemon/fleet.yaml`：

```yaml
project_roots:
  - ~/Projects

channel:
  type: telegram         # telegram 或 discord
  mode: topic           # topic（推薦）或 dm
  bot_token_env: CCD_BOT_TOKEN
  group_id: -100xxxxxxxxxx
  access:
    mode: locked         # locked 或 pairing
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
    threshold_percentage: 60
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
    description: "主要後端服務"
    cost_guard:
      daily_limit_usd: 30
    model: opus
```

密鑰放在 `~/.claude-channel-daemon/.env`：
```
CCD_BOT_TOKEN=123456789:AAH...
GROQ_API_KEY=gsk_...          # 選用，語音轉文字用
```

## 資料目錄

`~/.claude-channel-daemon/`：

| 路徑 | 用途 |
|------|------|
| `fleet.yaml` | Fleet 設定 |
| `.env` | Bot token + API keys |
| `fleet.log` | Fleet log（JSON）|
| `fleet.pid` | Fleet manager PID |
| `scheduler.db` | 排程資料庫（SQLite）|
| `events.db` | 事件記錄（花費快照、輪替、卡住）|
| `instances/<name>/` | 每個 instance 的資料 |
| `instances/<name>/daemon.log` | Instance log |
| `instances/<name>/session-id` | Session UUID，給 `--resume` 用 |
| `instances/<name>/statusline.json` | Claude 最新狀態資料 |
| `instances/<name>/channel.sock` | IPC Unix socket |
| `instances/<name>/claude-settings.json` | 每個 instance 的 Claude 設定 |
| `instances/<name>/memory.db` | 記憶檔 SQLite 備份 |
| `instances/<name>/output.log` | Claude tmux 輸出擷取 |

## 系統需求

- Node.js >= 20
- tmux
- Claude Code CLI（`claude`）
- Telegram bot token（[@BotFather](https://t.me/BotFather)）
- Groq API key（選用，語音轉文字用）

## 安全注意事項

透過 Telegram 遠端操作 Claude Code，與坐在終端機前操作有不同的信任模型。請注意以下風險：

### Telegram 帳號 = Shell 存取權

`allowed_users` 中的任何用戶都能指示 Claude 在主機上執行任意 shell 指令。如果你的 Telegram 帳號被入侵（session 被盜、社交工程、手機借人），攻擊者等同取得 shell 存取權。建議：

- 啟用 Telegram 兩步驟驗證
- `allowed_users` 只放必要的人
- 盡量用 `pairing` 模式取代預設 user ID
- 檢查 `claude-settings.json` 裡的權限 allow/deny list

### 權限繞過（`skipPermissions`）

`skipPermissions` 設定會傳遞 `--dangerously-skip-permissions` 給 Claude Code，停用所有工具使用的權限提示。這代表 Claude 可以讀寫任意檔案、執行任何指令、發送網路請求，完全不需要詢問。這是 Claude Code 官方的自動化旗標，但在遠端 Telegram 情境下代表**所有操作零人工審核**。只有在你完全信任部署環境時才啟用。

### Allow list 中的 `Bash(*)`

預設情況下（`skipPermissions` 關閉時），ccd 在 Claude Code 的權限 allow list 中設定了 `Bash(*)`，使 shell 指令不需要逐一核准。deny list 會阻擋少數破壞性指令（`rm -rf /`、`dd`、`mkfs`），但這是黑名單策略——無法涵蓋所有危險指令。這與 Claude Code 自身的權限模型一致，`Bash(*)` 是官方支援的進階用戶設定。

如果需要更嚴格的控制，可以編輯 `claude-settings.json`（每個 instance 產生在 `~/.claude-channel-daemon/instances/<name>/`），將 `Bash(*)` 改為特定模式如 `Bash(npm test)`、`Bash(git *)`。

### IPC Socket

Daemon 與 Claude 的 MCP server 透過 Unix socket（`~/.claude-channel-daemon/instances/<name>/channel.sock`）通訊。Socket 限制為擁有者唯讀（`0600`）並要求 shared secret 握手認證。這些措施防止其他本地程序注入訊息，但無法防禦同機器上被入侵的用戶帳號。

### 密鑰儲存

Bot token 和 API key 以明文存放在 `~/.claude-channel-daemon/.env`。`ccd export` 會包含此檔案並警告安全傳輸。如果主機為共用環境，建議使用檔案系統加密。

## 已知限制

- 目前只在 macOS 測過
- 全域 `enabledPlugins` 裡有官方 telegram plugin 會造成 409 polling 衝突（daemon 會自動重試）

## 授權

MIT
