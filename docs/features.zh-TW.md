# 功能 (Features)

## Fleet 模式 — 一個機器人，多個專案

每個 Telegram 論壇主題 (Forum Topic) 都映射到一個獨立的 Claude Code session。建立主題、選擇專案目錄，Claude 就會開始工作。刪除主題，實例 (instance) 就會停止。擴展到您的機器所能處理的任意數量的專案。

## 排程任務 (Scheduled tasks)

Claude 可以透過 MCP 工具建立基於 cron 的排程。排程在 daemon 重啟後仍能保持（由 SQLite 支援）。

```
使用者：「每天早上 9 點，檢查是否有任何需要審核的開放 PR」
Claude：→ create_schedule(cron: "0 9 * * *", message: "檢查需要審核的開放 PR")
```

可用的 MCP 工具：`create_schedule`、`list_schedules`、`update_schedule`、`delete_schedule`

協作 MCP 工具：`list_instances`、`send_to_instance`、`start_instance`、`create_instance`、`delete_instance`

排程可以針對特定實例或建立它們的同一個實例。當排程觸發時，daemon 會將訊息推送給 Claude，就像使用者發送的一樣。

## Context 輪轉 (Context rotation)

監控 Claude 的狀態行 (status line) JSON。當 Context 使用量超過閾值或 session 達到其最大存留時間時，daemon 會執行簡單的重啟：

```
NORMAL → RESTARTING → GRACE
```

1. **觸發 (Trigger)** — Context 超過閾值（預設 80%）或達到 `max_age_hours`（預設 8 小時）
2. **閒置屏障 (Idle barrier)** — 等待最多 5 秒讓當前活動平息（盡力而為，非交接）
3. **快照 (Snapshot)** — daemon 將最近的使用者訊息、工具活動和狀態行數據收集到 `rotation-state.json`
4. **重啟 (Restart)** — 刪除 tmux 視窗，啟動注入了快照到系統提示 (system prompt) 的全新 session
5. **寬限 (Grace)** — 10 分鐘冷卻期以防止快速重新輪轉

不會向 Claude 發送交接提示。恢復 Context 完全來自 daemon 端的快照。

## 點對點 Agent 協作 (Peer-to-peer agent collaboration)

每個實例都是平等的對等節點 (peer)，可以發現、喚醒、建立其他實例並向其發送訊息。不需要調度器 (dispatcher) — 協作源於每個 agent 可用的工具。

**核心 MCP 工具：**

- `list_instances` — 發現所有配置的實例（執行中或已停止），包括狀態、工作目錄和最後活動
- `send_to_instance` — 向另一個實例或外部 session 發送訊息；支援結構化元數據 (`request_kind`、`requires_reply`、`correlation_id`、`task_summary`)
- `start_instance` — 喚醒已停止的實例，以便您可以向其發送訊息
- `create_instance` — 建立帶有主題的新實例（目錄選填；省略時自動建立 `~/.agend/workspaces/<name>`）；支援 `branch` 用於 git worktree 隔離
- `delete_instance` — 移除實例及其主題
- `describe_instance` — 獲取有關特定實例的詳細資訊（描述、模型、最後活動）

**高階協作工具**（優於原始的 `send_to_instance`）：

- `request_information` — 向另一個實例提問並期望回覆 (`request_kind=query`、`requires_reply=true`)
- `delegate_task` — 指派工作給另一個實例並附帶成功標準 (`request_kind=task`、`requires_reply=true`)
- `report_result` — 向請求者返回結果，回應 `correlation_id` 以將回應與其請求連結

**Team 工具**（對 instance 群組操作）：

- `create_team` — 定義具名的 instance 群組
- `list_teams` — 列出所有 team 及其成員
- `update_team` — 新增/移除成員或更新描述
- `delete_team` — 移除 team 定義
- `broadcast(team: "name", ...)` — 向指定 team 的所有成員發送訊息

當一個 instance 發訊息給另一個時，目標的 topic 會顯示通知：`sender → receiver: summary`。General Topic instance 不會收到這些通知，以降低噪音。

如果您對已停止的實例執行 `send_to_instance`，錯誤會提示您先使用 `start_instance()` — agent 會在無需人工介入的情況下自我修正。

### Fleet Context 系統提示 (Fleet context system prompt)

啟動時，每個實例都會自動收到一個 fleet Context 系統提示，告知它：

- 它自己的身份 (`instanceName`) 和工作目錄
- 完整的 fleet 工具列表及其使用方法
- 協作規則：如何處理 `from_instance` 訊息、何時回應 `correlation_id`、範疇意識（絕不假設可以直接存取另一個實例 repo 的檔案）

這意味著實例從第一條訊息開始就了解它們在 fleet 中的角色，無需任何手動配置。

## 任務看板 (Task Board)

管理全 Fleet 的任務。支援建立、認領與完成追蹤。
- `task(action: "create")` — 建立新任務。
- `task(action: "claim")` — 認領任務。
- `task(action: "done")` — 標記任務完成。
- `task(action: "list")` — 查看所有開放任務與進度。

## 身份與人格管理 (Identity & Persona Management)

為實例設定易於辨識的名字與角色。
- `set_display_name` — 設定實例的顯示名稱（如「Astra」、「Kuro」）。
- `set_description` — 設定實例的角色描述（Persona），這會影響實例的行為風格。

## General 主題實例 (General Topic instance)

綁定到 Telegram General 主題的常規實例。在 fleet 啟動時自動建立，它作為不屬於特定專案的任務的自然語言進入點。其行為完全由其專案的 `CLAUDE.md` 定義：

- 簡單任務（網頁搜尋、翻譯、一般問題） — 直接處理
- 專案特定任務 — 使用 `list_instances()` 找到正確的 agent，必要時使用 `start_instance()`，然後使用 `send_to_instance()` 進行委派
- 新專案請求 — 使用 `create_instance()` 設定新的 agent

在 General 主題中使用 `/status` 獲取 fleet 概覽。所有其他專案管理均由 General 實例透過自然語言處理。

## 外部 Session 支援 (External session support)

您可以透過將 `.mcp.json` 指向實例的 IPC socket，將本地的 Claude Code session 連接到 daemon 的頻道工具（reply、send_to_instance 等）：

```json
{
  "mcpServers": {
    "agend-channel": {
      "command": "node",
      "args": ["path/to/dist/channel/mcp-server.js"],
      "env": {
        "AGEND_SOCKET_PATH": "~/.agend/instances/<name>/channel.sock"
      }
    }
  }
}
```

daemon 使用環境變數分層自動將外部 session 與內部 session 隔離：

| Session 類型 | 身份來源 | 範例 |
|---|---|---|
| 內部 (daemon 管理) | 透過 tmux 環境的 `AGEND_INSTANCE_NAME` | `ccplugin` |
| 外部 (自訂名稱) | `.mcp.json` 環境中的 `AGEND_SESSION_NAME` | `dev` |
| 外部 (零配置) | `external-<basename(cwd)>` 回退 | `external-myproject` |

內部 session 由 daemon 將 `AGEND_INSTANCE_NAME` 注入到 tmux shell 環境中。外部 session 沒有這個，因此會回退到 `AGEND_SESSION_NAME`（如果已設置）或基於工作目錄自動生成的名稱。這意味著相同的 `.mcp.json` 會為內部與外部 session 產生不同的身份 — 沒有配置衝突。

外部 session 出現在 `list_instances` 中，並且可以作為 `send_to_instance` 的目標。

## 權限系統 (Permission system)

使用 Claude Code 的原生權限中繼 (permission relay) — 權限請求會作為 inline 按鈕 (Allow/Deny) 轉發到 Telegram。當 Claude 請求使用敏感工具時，daemon 會在 Telegram 中向您顯示，並在繼續之前等待您的回應。

權限提示顯示一個每 30 秒更新一次的倒數計時器。「一律允許 (Always Allow)」按鈕讓您可以為當前 session 核准特定工具的所有未來使用。在您回應後，決定會內聯顯示（「✅ 已核准」/「❌ 已拒絕」）。

## 語音轉錄 (Voice transcription)

Telegram 語音訊息透過 Groq Whisper API 轉錄並以文字形式發送給 Claude。在主題模式和私訊 (DM) 模式下均有效。需要在 `.env` 中設置 `GROQ_API_KEY`。

## 動態實例管理 (Dynamic instance management)

實例透過 General 實例使用 `create_instance` 建立。告訴 General 實例您想在哪個專案上工作 — 它會建立一個 Telegram 主題，綁定專案目錄，並自動啟動 Claude。實例也可以使用 `--branch` 建立，以產生一個 git worktree 用於功能分支隔離。刪除主題會自動取消綁定並停止實例。使用 `delete_instance` 完全移除實例及其主題。

## 成本防護 (Cost guard)

在無人值守執行時防止帳單衝擊。在 `fleet.yaml` 中配置每日支出限制：

```yaml
defaults:
  cost_guard:
    daily_limit_usd: 50
    warn_at_percentage: 80
    timezone: "Asia/Taipei"
```

當實例接近限制時，會在其 Telegram 主題發佈警告。達到限制時，實例會自動暫停並發送通知。暫停的實例會在隔天或手動重啟時恢復。

## Fleet 狀態 (Fleet status)

在 General 主題中使用 `/status` 查看即時概覽：

```
🟢 proj-a — ctx 42%, $3.20 today
🟢 proj-b — ctx 67%, $8.50 today
⏸ proj-c — paused (cost limit)

Fleet: $11.70 / $50.00 daily
```

## 每日摘要 (Daily summary)

每日報告會在可配置的時間（預設 21:00）發佈到 General 主題：

```
📊 Daily Report — 2026-03-26

proj-a: $8.20, 2 restarts
proj-b: $2.10
proj-c: $0.00 ⚠️ 1 hang

Total: $10.30
```

## 懸掛偵測 (Hang detection)

如果實例 15 分鐘（可配置）沒有活動，daemon 會發佈帶有 inline 按鈕的通知：

- **強制重啟 (Force restart)** — 停止並重啟實例
- **繼續等待 (Keep waiting)** — 關閉警報

使用多訊號偵測：同時檢查對話活動和狀態行的新鮮度，以避免在長時間運行的工具呼叫期間產生誤報。

## 頻率限制感知排程 (Rate limit-aware scheduling)

當 5 小時 API 頻率限制超過 85% 時，排程觸發會自動延遲而不是啟動。系統會在實例主題發佈通知。延遲的排程不會丟失 — 它們將在頻率限制低於閾值時的下一個 cron tick 啟動。

## 模型容錯移轉 (Model failover)

當主要模型達到頻率限制時，daemon 會在下一次 Context 輪轉時自動切換到備用模型。在 `fleet.yaml` 中配置回退鏈：

```yaml
instances:
  my-project:
    model_failover: ["opus", "sonnet"]
```

當發生容錯移轉時，daemon 會在 Telegram 通知您，並在頻率限制恢復後切換回主要模型。

## 優雅重啟 (Graceful restart)

`agend fleet restart` 向 fleet manager 發送 SIGUSR2。它等待所有實例進入閒置狀態（10 秒內無對話活動），然後逐一重啟。5 分鐘的逾時可防止在卡住的實例上懸掛。

## 主題圖示 + 閒置封存 (Topic icon + idle archive)

執行中的實例在 Telegram 中會有視覺圖示指示器。當實例停止或崩潰時，圖示會改變。閒置實例會自動封存 — 向封存的主題發送訊息會自動重新開啟它。

## Daemon 端重啟快照 (Daemon-side restart snapshot)

在每次 Context 重啟前，daemon 會儲存一個包含最近使用者訊息、工具活動、Context 使用量和狀態行數據的 `rotation-state.json`。下一個 session 在其系統提示中接收此快照，在不依賴 Claude 撰寫交接報告的情況下提供連續性。

## 服務訊息過濾 (Service message filter)

Telegram 系統事件（主題重新命名、置頂、成員加入等）在到達 Claude 之前會被過濾掉，以節省 Context 視窗 token。

## 健康檢查端點 (Health endpoint)

用於外部監控工具的輕量級 HTTP 端點：

```
GET /health  → { status: "ok", instances: 3, uptime: 86400 }
GET /status  → { instances: [{ name, status, context_pct, cost_today }] }
```

在 `fleet.yaml` 中配置：

```yaml
health_port: 19280  # 頂層，預設 19280，綁定到 127.0.0.1
```

## Webhook 通知 (Webhook notifications)

將 fleet 事件推送到外部端點（Slack、自訂儀表板等）：

```yaml
defaults:
  webhooks:
    - url: https://hooks.slack.com/...
      events: ["restart", "hang", "cost_warn"]
    - url: https://custom.endpoint/agend
      events: ["*"]
```

## Discord 轉接器 (Discord adapter (MVP))

將您的 fleet 連接到 Discord 而非（或同時連接）Telegram。在 `fleet.yaml` 中配置：

```yaml
channel:
  type: discord
  bot_token_env: AGEND_DISCORD_TOKEN
  guild_id: "123456789"
```

## 外部轉接器外掛系統 (External adapter plugin system)

社群轉接器可以透過 npm 安裝並自動載入：

```bash
npm install agend-adapter-slack
```

daemon 會發現符合 `agend-adapter-*` 命名慣例的轉接器。頻道類型從外掛作者的套件進入點導出。
