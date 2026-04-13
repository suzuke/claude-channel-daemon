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

## Crash Recovery

監控 CLI 的狀態行 (status line) JSON 以取得 context 使用量指標（用於儀表板和日誌）。所有 CLI 後端（Claude Code、Codex、Gemini CLI、OpenCode、Kiro CLI）都有內建的 auto-compact 來處理 context 限制 — AgEnD 不會根據 context 使用量或 session 存留時間觸發重啟。

當 CLI 程序崩潰時，daemon 的健康檢查偵測到死掉的 tmux 視窗並：

1. **快照 (Snapshot)** — 收集最近的使用者訊息、工具活動和狀態行數據到 `rotation-state.json`
2. **Resume 嘗試** — 嘗試 `--resume` 恢復完整對話歷史
3. **Fallback** — 如果 resume 失敗，啟動全新 session 並注入快照作為 context
4. **退避 (Backoff)** — 重複崩潰時指數退避，3 次快速崩潰後暫停

## Instance 替換

當 instance 的 context 被污染或卡在迴圈中，使用 `replace_instance` 原子性地替換為全新的 instance：

1. 從 daemon 的 ring buffer 收集交接 context（最近的訊息、事件、工具活動）
2. 停止舊 instance 並保留其設定
3. 使用相同設定建立新 instance，重用 Telegram topic
4. 透過標準訊息傳遞路徑將交接 context 發送給新 instance

## 點對點 Agent 協作 (Peer-to-peer agent collaboration)

每個實例都是平等的對等節點 (peer)，可以發現、喚醒、建立其他實例並向其發送訊息。不需要調度器 (dispatcher) — 協作源於每個 agent 可用的工具。

**核心 MCP 工具：**

- `list_instances` — 發現所有配置的實例（執行中或已停止），包括狀態、工作目錄和最後活動
- `send_to_instance` — 向另一個實例或外部 session 發送訊息；支援結構化元數據 (`request_kind`、`requires_reply`、`correlation_id`、`task_summary`)
- `start_instance` — 喚醒已停止的實例，以便您可以向其發送訊息
- `create_instance` — 建立帶有主題的新實例（目錄選填；省略時自動建立 `~/.agend/workspaces/<name>`）；支援 `branch` 用於 git worktree 隔離
- `delete_instance` — 移除實例及其主題
- `replace_instance` — 替換實例為全新的（交接 + 刪除 + 建立）
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

當主要模型達到頻率限制時，daemon 會在下一次 session 重啟時自動切換到備用模型。在 `fleet.yaml` 中配置回退鏈：

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

將您的 fleet 連接到 Discord 而非（或同時連接）Telegram。

### 設定步驟

1. **安裝 Discord 外掛：**
   ```bash
   npm install -g @suzuke/agend-plugin-discord
   ```

2. **建立 Discord bot**，前往 [Discord Developer Portal](https://discord.com/developers/applications)：
   - 建立新 Application → Bot
   - 啟用 **Privileged Gateway Intents**：Presence Intent、Server Members Intent、Message Content Intent
   - 產生邀請 URL，scope 選 `bot`，權限選 `Send Messages`、`Read Message History`、`Manage Channels`
   - 邀請 bot 到你的伺服器

3. **執行 quickstart**（Discord 推薦方式）：
   ```bash
   agend quickstart    # 選擇 "Discord"
   ```
   > **注意：** `agend init`（進階設定精靈）目前僅支援 Telegram。Discord 請使用 `agend quickstart`。

4. **或手動設定** `fleet.yaml`：
   ```yaml
   channel:
     type: discord
     mode: topic           # 必填 — 不寫的話 bot 會靜默不啟動
     bot_token_env: AGEND_DISCORD_TOKEN
     group_id: "123456789012345678"   # Discord snowflake ID 必須加引號，避免精度丟失
     access:
       mode: locked
       allowed_users:
         - "your_discord_user_id"     # User ID 也要加引號
   ```

5. **設定 bot token**，寫入 `~/.agend/.env`：
   ```
   AGEND_DISCORD_TOKEN=your_bot_token_here
   ```

### 疑難排解

- **Bot 不上線：** 確認 `fleet.yaml` 中有設定 `mode: topic`。沒有的話 adapter 會靜默不啟動。
- **訊息內容是空的：** 到 Discord Developer Portal → Bot → Privileged Gateway Intents 啟用 **Message Content Intent**。
- **ID 精度丟失：** YAML 中的 Discord ID（guild ID、user ID）務必加引號 — 它們是 64-bit snowflake，超過 JavaScript 整數精度。
- **MCP 導致啟動慢：** 如果 backend CLI 因 MCP server 連線而啟動逾時，可在 `fleet.yaml` 增加 timeout：
  ```yaml
  defaults:
    startup_timeout_ms: 60000   # 預設：25000 (25 秒)
  ```
- **`registerBotCommands` ETIMEDOUT：** 這是非致命錯誤 — bot polling 仍會正常啟動。在網路不穩時會發生。
- **`working_directory` 找不到：** v1.19 起目錄會自動建立。如果遇到此錯誤，請更新到最新版本。

## 外部轉接器外掛系統 (External adapter plugin system)

社群轉接器可以透過 npm 安裝並自動載入：

```bash
npm install agend-adapter-slack
```

daemon 會發現符合 `agend-adapter-*` 命名慣例的轉接器。頻道類型從外掛作者的套件進入點導出。

## Kiro CLI 後端 (Kiro CLI backend)

支援 AWS Kiro CLI 作為後端（`backend: kiro-cli`）。支援 session 恢復、MCP 設定，以及模型選擇：`auto`、`claude-sonnet-4.5`、`claude-haiku-4.5`。在 `fleet.yaml` 中與其他後端相同方式配置。

## agend quickstart

簡化的 4 步驟設定精靈，為新使用者設計。自動偵測已安裝的後端、透過 `getUpdates` 輪詢自動發現 Telegram 群組 ID，並產生帶有合理預設值的最小 `fleet.yaml`。取代原本 9 步驟的 `agend init`，成為推薦的初始設定流程。

## Web Dashboard

`agend web` 啟動瀏覽器儀表板，透過 Server-Sent Events (SSE) 即時監控 fleet。內建聊天 UI 與 Telegram 雙向同步 — 從 Web UI 發送的訊息會出現在 Telegram，反之亦然。

## 內建工作流程模板 (Built-in workflow template)

Fleet 協作工作流程透過 MCP instructions 自動注入。`fleet.yaml` 中的 `workflow` 欄位控制此行為：

- `"builtin"`（預設）— 標準協作工作流程
- `"file:./path.md"` — 從檔案載入自訂工作流程
- `false` — 停用工作流程注入

## 工作流程分層：coordinator vs executor (Workflow layering)

General instance 收到完整的 coordinator playbook（選擇協作者、任務規模判斷、委派原則、目標與決策管理）。其他 instance 則收到精簡的 executor 工作流程（溝通規則、進度追蹤、context 保護）。確保 General instance 作為智慧調度者，而 worker instance 專注於執行。

## Crash 感知快照復原 (Crash-aware snapshot restore)

Context 快照現在在偵測到 crash 時也會寫入，不再只限於 context 輪轉。快照檔案持久化到磁碟，並透過記憶體中的消費旗標管理，即使 daemon 重啟也能恢復。Agent 在非預期崩潰後同樣能帶著 context 恢復，而非只有計劃性輪轉。

## 錯誤監控 hash 去重 (Error monitor hash dedup)

PTY 錯誤監控會在恢復時記錄 pane 內容的 hash。如果同一畫面再次出現相同錯誤，會被抑制以防止過期的重複偵測迴圈。消除持久性終端輸出造成的誤報通知。

## 平行啟動 (Parallel startup)

Fleet instance 現在以平行方式啟動，而非循序。包含處理多個 instance 同時產生時可能發生的 tmux 重複 session 競爭條件。

## Fleet 就緒通知 (Fleet ready notification)

`fleet start` 或 `fleet restart` 完成後，General topic 會收到「Fleet ready. N/M instances running.」訊息。如有 instance 啟動失敗，會在通知中列出。

## create_instance systemPrompt 參數 (create_instance systemPrompt parameter)

Agent 可以在透過 `systemPrompt` 參數建立 instance 時傳入自訂系統提示。支援行內文字。提示會透過 MCP instructions 與 fleet context 一起注入。

## project_roots 限制 create_instance 目錄 (project_roots enforcement)

當 `fleet.yaml` 中配置了 `project_roots` 時，`create_instance` 會驗證請求的工作目錄是否在已配置的根目錄範圍內。超出邊界的目錄請求會被拒絕並回傳錯誤。

## reply_to_text 注入 (reply_to_text injection)

當使用者在 Telegram 中回覆先前的訊息時，被引用的文字會包含在傳遞給 agent 的格式化訊息中。讓 agent 了解使用者所指的內容。

## delete_instance 自動清理 team (delete_instance team cleanup)

透過 `delete_instance` 刪除 instance 時，會自動從其所屬的所有 team 中移除。不再需要手動清理 team 成員資格。

## HTML 對話匯出 (HTML Chat Export)

`agend export-chat` 將 fleet 活動匯出為獨立的 HTML 檔案。支援 `--from` 和 `--to` 日期篩選及 `-o` 指定輸出路徑。匯出的檔案包含所有訊息、工具呼叫和跨 instance 通訊，以可讀的聊天格式呈現。

## Mirror Topic

在 `fleet.yaml` 中配置 `mirror_topic_id`，指定一個 Telegram topic 用於觀察跨 instance 通訊。所有 `send_to_instance` 訊息都會即時鏡像到此 topic。這是 daemon 層級的 hook，agent 行為完全不受影響 — agent 不知道自己正在被觀察。

## Codex session 恢復 (Codex session resume)

OpenAI Codex 後端支援 session 恢復。當 session-id 檔案存在時，後端使用 `codex resume <session-id>` 而非重新啟動。同時偵測 "You've hit your usage limit" 作為觸發暫停的錯誤。

## Rate limit failover 冷卻 (Rate limit failover cooldown)

5 分鐘冷卻期防止重複觸發模型容錯移轉。容錯移轉發生後，冷卻視窗內的後續 rate limit 錯誤會被抑制，避免終端緩衝區中殘留錯誤文字造成連鎖容錯移轉。

## CLI UX 改善 (CLI UX improvements)

- `agend fleet restart <name>` — 重啟特定 instance 而非整個 fleet
- `agend attach` — 模糊匹配，遇到歧義時顯示互動式編號選單
- `agend logs` — 獨立的日誌檢視器，支援 ANSI 剝除、`-n/--lines` 和 `-f/--follow` 選項

## .env 優先覆蓋 (.env priority override)

`~/.agend/.env` 中的值現在會正確覆蓋繼承的 shell 環境變數。確保 token 隔離 — `.env` 中設定的 bot token 優先於 shell 環境中可能存在的 `AGEND_BOT_TOKEN`。

## 後端感知 General 指令 (Backend-aware General instructions)

自動建立 General topic instance 時，AgEnD 會根據配置的後端寫入對應的指令檔案：

- Claude Code → `CLAUDE.md`
- Codex → `AGENTS.md`
- Gemini CLI → `GEMINI.md`
- Kiro CLI → `.kiro/steering/project.md`
- OpenCode → 直接使用 MCP instructions

## 內建文字標準化（英文化）(Builtin text standardization)

所有系統生成的文字（排程通知、語音訊息標籤、general instructions、fleet 通知）現在統一為英文。先前部分訊息為中文。
