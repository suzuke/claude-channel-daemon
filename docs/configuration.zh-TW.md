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
    tags: [backend, api]
    model: opus

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
| `mode` | `"locked"` | `"locked"` | 存取模式。`locked` = 僅白名單 |
| `allowed_users` | (number\|string)[] | `[]` | 白名單使用者 ID。支援 number 和 string（跨平台） |

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

---

## instances.\<name\>

| 欄位 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `working_directory` | string | **必填** | 專案目錄路徑 |
| `display_name` | string | — | Agent 顯示名稱（例："Kuro"）。用 `set_display_name` 設定 |
| `description` | string | — | 角色描述。會注入 system prompt 作為 `## Role` |
| `tags` | string[] | `[]` | 標籤，用於 `broadcast` 和 `list_instances` 過濾 |
| `topic_id` | number\|string | 自動 | 頻道 topic/thread ID。建立時自動分配 |
| `general_topic` | boolean | `false` | 標記為 General Topic（接收未路由的訊息） |
| `backend` | string | `"claude-code"` | CLI backend：`claude-code`、`codex`、`gemini-cli`、`opencode` |
| `model` | string | — | 模型。Claude：`sonnet`、`opus`、`haiku`、`opusplan`。Codex：`gpt-4o`。Gemini：`gemini-2.5-pro` |
| `model_failover` | string[] | — | 被限速時的備用模型（例：`["opus", "sonnet"]`） |
| `tool_set` | string | `"full"` | MCP tool 設定：`full`（全部）、`standard`（10 個）、`minimal`（4 個） |
| `systemPrompt` | string | — | 自訂 system prompt。支援 `file:./path.md` 引用外部檔案 |
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
| `instances/<name>/.prompt-generated` | 自動產生的 system prompt（勿直接編輯） |
