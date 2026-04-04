# 設定參考

## Fleet 設定檔

位置：`~/.agend/fleet.yaml`。由 `agend init` 建立或手動編輯。

```yaml
project_roots:
  - ~/Projects

channel:
  type: telegram
  mode: topic
  bot_token_env: AGEND_BOT_TOKEN
  group_id: -1001234567890
  access:
    mode: locked
    allowed_users: [123456789]

defaults:
  backend: claude-code
  tool_set: standard
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: Asia/Taipei
  daily_summary:
    enabled: true
    hour: 21

instances:
  my-project:
    working_directory: ~/Projects/my-app
    description: "後端 API 開發者"
    model: opus

teams:
  frontend:
    members: [my-project, another-instance]
    description: "前端開發團隊"

health_port: 19280
```

---

## 頂層欄位

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `project_roots` | string[] | `[]` | 專案目錄列表（供 topic 自動綁定瀏覽） |
| `channel` | object | **必填** | 通訊平台設定 |
| `defaults` | object | `{}` | 所有 instance 的預設設定 |
| `instances` | object | **必填** | Instance 定義（key = instance 名稱） |
| `teams` | object | `{}` | 具名 instance 群組，用於精準廣播 |
| `health_port` | number | `19280` | HTTP 健康檢查/API 伺服器埠 |

---

## channel

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `type` | `"telegram"` \| `"discord"` | **必填** | 通訊平台 |
| `mode` | `"topic"` | `"topic"` | 路由模式（topic = 每個 instance 一個 topic） |
| `bot_token_env` | string | **必填** | 存放 bot token 的環境變數名稱 |
| `group_id` | number | — | Telegram 群組 ID（負數）或 Discord guild ID |
| `access` | object | **必填** | 存取控制 |
| `options` | object | — | 平台特定選項（Discord：`category_name`、`general_channel_id`） |

### channel.access

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `mode` | `"locked"` \| `"pairing"` | `"locked"` | `locked` = 僅白名單。`pairing` = 使用者可透過 `/pair` 指令申請存取（需手動確認 code） |
| `allowed_users` | (number\|string)[] | `[]` | 白名單使用者 ID。支援 number 和 string（跨平台） |
| `max_pending_codes` | number | `3` | 同時可有的配對碼數量上限（pairing 模式） |
| `code_expiry_minutes` | number | `10` | 配對碼過期時間 |

---

## defaults

所有 `instances.<name>` 的欄位都可以在這裡設預設值。額外欄位：

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `cost_guard` | object | 停用 | 全 fleet 花費守衛 |
| `hang_detector` | object | 啟用，15 分鐘 | 卡住偵測 |
| `daily_summary` | object | 啟用，21:00 | 每日花費摘要 |
| `scheduler` | object | — | 排程設定 |
| `webhooks` | object[] | `[]` | Webhook 通知 |

### defaults.cost_guard

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `daily_limit_usd` | number | `0`（停用） | 每日花費上限。`0` = 不限制 |
| `warn_at_percentage` | number | `80` | 達到上限百分比時警告 |
| `timezone` | string | 系統時區 | IANA 時區（例：`Asia/Taipei`） |

### defaults.hang_detector

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `enabled` | boolean | `true` | 啟用卡住偵測 |
| `timeout_minutes` | number | `15` | 無輸出多久後發出警告 |

### defaults.daily_summary

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `enabled` | boolean | `true` | 啟用每日花費摘要 |
| `hour` | number | `21` | 發送時間（0-23） |
| `minute` | number | `0` | 分鐘 |

### defaults.scheduler

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `max_schedules` | number | `100` | 排程數量上限 |
| `default_timezone` | string | `Asia/Taipei` | Cron 排程的預設時區 |
| `retry_count` | number | `3` | 排程投遞失敗時的重試次數 |
| `retry_interval_ms` | number | `30000` | 重試間隔（毫秒） |

### defaults.webhooks[]

| 欄位 | 型別 | 說明 |
|------|------|------|
| `url` | string | Webhook endpoint URL |
| `events` | string[] | 通知事件：`rotation`、`hang`、`cost_warn`、`cost_limit`、`crash_loop` |
| `headers` | object | 選用的 HTTP headers |

---

## teams.\<name\>

具名的 instance 群組，用於精準廣播。可透過 `create_team`、`list_teams`、`update_team`、`delete_team` MCP 工具管理，或直接在 fleet.yaml 中定義。

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `members` | string[] | **必填** | 此 team 的 instance 名稱列表 |
| `description` | string | — | team 用途說明 |

範例：

```yaml
teams:
  backend-squad:
    members: [api-agent, db-agent]
    description: "後端開發團隊"
```

使用 `broadcast(team: "backend-squad", message: "...")` 向所有成員廣播。

---

## instances.\<name\>

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `working_directory` | string | 自動 | 專案目錄路徑。省略時自動建立 `~/.agend/workspaces/<name>` |
| `display_name` | string | — | Agent 顯示名稱（例："Kuro"）。用 `set_display_name` 設定 |
| `description` | string | — | 角色描述。透過 MCP server instructions 注入為 `## Role` |
| `topic_id` | number\|string | 自動 | 頻道 topic/thread ID。建立時自動分配 |
| `general_topic` | boolean | `false` | 標記為 General Topic（接收未路由的訊息） |
| `backend` | string | `"claude-code"` | CLI backend：`claude-code`、`codex`、`gemini-cli`、`opencode`、`kiro-cli` |
| `model` | string | — | 模型。Claude：`sonnet`、`opus`、`haiku`、`opusplan`。Codex：`gpt-4o`。Gemini：`gemini-2.5-pro`。Kiro：`auto`、`claude-sonnet-4.5`、`claude-haiku-4.5` |
| `model_failover` | string[] | — | 被限速時的備用模型（例：`["opus", "sonnet"]`） |
| `tool_set` | string | `"full"` | MCP tool 設定：`full`（全部）、`standard`（10 個）、`minimal`（4 個） |
| `systemPrompt` | string | — | 自訂指令，透過 MCP server instructions 注入。內嵌字串或 `file:./path.md` 從外部檔案載入（路徑相對於 `working_directory`）。不會修改 CLI 的內建 system prompt。範例：`systemPrompt: "file:./prompts/role.md"` |
| `skipPermissions` | boolean | `true` | 跳過 CLI 權限檢查。設 `false` 啟用 |
| `lightweight` | boolean | `false` | 跳過 transcript monitor、context guardian 等非必要子系統 |
| `log_level` | string | `"info"` | `debug`、`info`、`warn`、`error` |
| `restart_policy` | object | 見下方 | 崩潰恢復設定 |
| `context_guardian` | object | 見下方 | Context 輪替設定 |
| `cost_guard` | object | — | 每 instance 花費守衛（覆蓋預設值） |
| `worktree_source` | string | — | 原始 repo 路徑（使用 branch 參數時自動設定） |

### restart_policy

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `max_retries` | number | `10` | 最大重試次數 |
| `backoff` | `"exponential"` \| `"linear"` | `"exponential"` | 重試策略 |
| `reset_after` | number | `300` | 穩定多少秒後重置重試計數 |

### context_guardian

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `grace_period_ms` | number | `600000` | 觸發 rotation 後等待時間（10 分鐘） |
| `max_age_hours` | number | `0`（停用） | 強制 rotation 的小時數。`0` = 依賴 CLI 自動壓縮 |

---

## Fleet context 注入機制

AgEnD 透過 **MCP server instructions** 機制注入 fleet context — 不修改 CLI 本身的 system prompt。這讓各 CLI 的內建行為維持完整，且所有 backend 使用統一的注入路徑。

### Fleet context 透過 MCP instructions

Daemon 啟動 instance 時，會啟動一個 MCP server（`agend`）作為 CLI 的子進程。Daemon 透過環境變數傳遞 instance 資訊給 MCP server：

| 環境變數 | 內容 |
|---------|------|
| `AGEND_INSTANCE_NAME` | Instance 名稱（例：`my-project`） |
| `AGEND_WORKING_DIR` | 工作目錄路徑 |
| `AGEND_DISPLAY_NAME` | Agent 顯示名稱（如有設定） |
| `AGEND_DESCRIPTION` | `description` 欄位的角色描述 |
| `AGEND_CUSTOM_PROMPT` | `systemPrompt` 欄位解析後的內容 |

MCP server 將這些組合成一個 `instructions` 字串，CLI 透過 MCP protocol 讀取。Instructions 包含：

1. **身分** — instance 名稱、工作目錄、顯示名稱、角色
2. **訊息格式** — 區分使用者訊息（`[user:name]`）和跨 instance 訊息（`[from:instance-name]`）
3. **協作規則** — 對使用者用 `reply`，跨 instance 用 `send_to_instance`，scope 意識
4. **工具指引** — reply、react、edit_message、download_attachment 及 fleet 工具的用法
5. **自訂 prompt** — fleet.yaml 的 `systemPrompt` 內容（支援 `file:` prefix）

這個方式的好處：
- CLI 的內建 system prompt **不會被修改**（Claude Code 保留 tool 指引、Gemini 保留 skills 等）
- 專案的 instruction 檔案（CLAUDE.md、AGENTS.md、GEMINI.md）**不受影響**
- 所有 backend（Claude Code、Codex、Gemini CLI、OpenCode、Kiro CLI）使用相同的注入路徑

### Session snapshot（context rotation 接續）

Context rotation 時，daemon 將前一個 session 的 snapshot（近期訊息、tool 活動、context 用量）儲存到 `rotation-state.json`。下次啟動時，snapshot 以 `[system:session-snapshot]` 前綴作為**第一則 inbound 訊息**送入 — 不再嵌入 system prompt。

Snapshot 為一次性消耗：讀取後即刪除，不會在後續重啟時重複注入。

### Decisions

Active decisions（來自 `post_decision`）**不再預載**到 prompt。Agent 使用 `list_decisions` 工具按需查詢。

### fleet.yaml `systemPrompt`

fleet.yaml 的 `systemPrompt` 欄位仍然有效：
- 內嵌字串：`systemPrompt: "你是安全審查員"`
- 檔案參照：`systemPrompt: "file:./prompts/role.md"`（路徑相對於 `working_directory`）

唯一的改變是注入管道：內容現在透過 MCP instructions 傳遞，而非 `--system-prompt` 等 CLI flag。

---

## 密鑰

位置：`~/.agend/.env`

```
AGEND_BOT_TOKEN=123456789:AAH...
GROQ_API_KEY=gsk_...          # 選用，語音轉文字
```

---

## 資料目錄

`~/.agend/`：

| 路徑 | 用途 |
|------|------|
| `fleet.yaml` | Fleet 設定檔 |
| `.env` | Bot token + API keys |
| `daemon.log` | Fleet daemon 日誌 |
| `fleet.pid` | Fleet manager PID |
| `scheduler.db` | 排程 + 決策 + 任務（SQLite） |
| `events.db` | 事件日誌 + 活動日誌（SQLite） |
| `access/access.json` | 存取控制狀態 |
| `instances/<name>/` | 每個 instance 的運行時資料 |
| `instances/<name>/channel.sock` | IPC Unix socket |
| `instances/<name>/statusline.json` | 最新 CLI 狀態 |
| `instances/<name>/rotation-state.json` | Context rotation snapshot（重啟時消耗） |
