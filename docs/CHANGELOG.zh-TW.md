# 更新日誌 (Changelog)

本專案的所有顯著變更都將記錄在此檔案中。

格式基於 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [未發佈] (Unreleased)

### 新增
- Fleet 事件（輪轉、懸掛、成本警報）的 Webhook 通知
- 用於外部監控的 HTTP 健康檢查端點 (`/health`, `/status`)
- 在 Context 輪轉時具有驗證與重試機制的結構化交接範本
- 權限中繼 UX 改進（逾時倒數、持久化的「一律允許」、決定後的回饋）
- 主題圖示自動更新（執行中/已停止）+ 閒置封存
- 過濾 Telegram 服務訊息（主題重新命名、置頂等）以節省 token

### 修復
- 最小化的 `claude-settings.json` — 允許列表中僅包含 AgEnD MCP 工具，不再覆蓋使用者全域的權限設定

## [1.9.1] - 2026-04-03

### 修復
- Health-check 重新啟動時注入 session snapshot — 崩潰/kill 恢復也能還原 context
- Snapshot 貼入時附加「不要回覆」指令，防止模型嘗試 IPC 回覆導致逾時

## [1.9.0] - 2026-04-03

### 破壞性變更
- **System prompt 注入改為 MCP instructions。** Fleet context、自訂 `systemPrompt`、協作規則現在透過 MCP server instructions 注入，不再使用 CLI 的 `--system-prompt` 等 flag。變更原因：
  - Claude Code：`--system-prompt` 傳了檔案路徑而非檔案內容 — fleet prompt **自始至終都沒有正確注入**
  - Gemini CLI：`GEMINI_SYSTEM_MD` 會覆蓋內建 system prompt 並破壞 skills 功能
  - Codex：`.prompt-generated` 是 dead code — 寫入但 CLI 從未讀取
  - OpenCode：`instructions` 陣列被覆蓋而非追加，破壞專案原有的 instructions
- **對現有設定的影響：**
  - `fleet.yaml` 的 `systemPrompt` 欄位保留 — 改由 MCP instructions 注入
  - 不再產生 `.prompt-generated`、`system-prompt.md`、`.opencode-instructions.md` 檔案
  - 各 CLI 的內建 system prompt 不再被覆蓋或修改
  - Active Decisions 不再預載到 system prompt — 改用 `list_decisions` 工具按需查詢
  - Session snapshot（context rotation 接續）改為第一則 inbound 訊息送入（`[system:session-snapshot]`），不再嵌入 system prompt

## [1.8.5] - 2026-04-03

### 修復
- 統一 log 與通知格式為 `sender → receiver: summary` 風格，適用於所有跨 instance 訊息
- Task/query 通知顯示完整訊息內容；report/update 通知僅顯示摘要

## [1.8.4] - 2026-04-03

### 修復
- 跨 instance 通知格式改為 `sender → receiver: summary` 格式
- General Topic instance 不再收到跨 instance 通知貼文
- 降低跨 instance 通知噪音 — 移除發送方 topic 貼文；目標通知優先使用 `task_summary`

## [1.8.3] - 2026-04-03

### 新增
- **Team 支援** — 具名的 instance 群組，用於精準廣播
  - `create_team` — 建立含成員與描述的 team
  - `list_teams` — 列出所有 team 及其成員
  - `update_team` — 新增/移除成員或更新描述
  - `delete_team` — 刪除 team 定義
  - `broadcast` 新增 `team` 參數，可對指定 team 的所有成員廣播
  - `fleet.yaml` 新增 `teams` 區塊，用於持久化 team 定義

## [1.8.2] - 2026-04-03

### 新增
- `fleet.yaml` 中 `working_directory` 現在為選填 — 未指定時自動建立 `~/.agend/workspaces/<name>`
- `create_instance` 的 `directory` 參數現在為選填（省略時自動建立工作空間）

### 修復
- Topic 模式下，Context-bound routing 現在在 IPC 轉發前執行（修正「chat not found」錯誤）
- Telegram：`thread_id=1` 正確視為 General Topic（不傳送 thread 參數）
- Scheduler 在 instance 啟動前完成初始化，確保 fleet 啟動時能正確載入 decisions

## [1.8.1] - 2026-04-03

### 新增
- `reply`、`react`、`edit_message` 改為 context-bound — 不再需要在 tool call 中指定 `chat_id` 和 `thread_id`；daemon 自動從當前對話 context 填入
- PTY 監控的後端錯誤模式偵測 — 偵測到頻率限制、認證錯誤或崩潰時自動通知
- 自動關閉執行時對話框（如 Codex 頻率限制的模型切換提示）
- 模型容錯移轉 — 達到頻率限制時自動切換備用模型（statusline + PTY 偵測）

### 修復
- PTY 錯誤監控處理後發送恢復通知
- 降低錯誤監控誤報；自動從 context 修正無效的 `chat_id`

## [0.3.7] - 2026-03-27

### 新增
- 用於移除實例的 `delete_instance` MCP 工具
- `create_instance --branch` — 用於功能分支隔離的 git worktree 支援
- 外部轉接器外掛載入 — 透過 `npm install agend-adapter-*` 安裝社群轉接器
- 從套件進入點導出頻道類型，供轉接器作者使用
- Discord 轉接器 (MVP) — 連接、發送/接收訊息、按鈕、反應
- 優雅重啟後 Telegram 主題中的每個實例重啟通知

### 修復
- `start_instance`、`create_instance`、`delete_instance` 已加入權限允許列表
- Worktree 實例名稱使用 `topic_name` 而非目錄基底名稱，以避免 Unix socket 路徑溢位（macOS 104 位元組限制）
- 帶有分支的 `create_instance` 不再對基礎 repo 觸發錯誤的 `already_exists`
- `postLaunch` 穩定性檢查替換為 10 秒寬限期
- 重啟通知使用 `fleetConfig.instances` + IPC 推送
- 解決了 Discord 轉接器的 TypeScript 錯誤

## [0.3.6] - 2026-03-27

### 修復
- 防止實例重啟時產生 MCP server 殭屍進程
- 強化 `postLaunch` 自動確認以應對邊緣案例

## [0.3.5] - 2026-03-26

### 新增
- 透過 `create_instance(model: "sonnet")` 進行各實例的模型選擇
- 實例 `description` 欄位，在 `list_instances` 中提供更好的可發現性
- 每 5 分鐘自動從 `sessionRegistry` 清理過期的外部 session
- AgEnD 到陸頁網站（Astro + Tailwind，英文/繁體中文雙語）
- 用於網站部署的 GitHub Actions 工作流
- README 中的安全考量章節

### 變更
- 簡化模型選擇 — 僅可透過 `create_instance` 配置，而非逐條訊息配置
- 使用單一 `query_sessions_response` 進行 session 清理

### 修復
- 安全強化 — 10 項漏洞修復（路徑遍歷、輸入驗證等）
- 向 Telegram 發送完整的跨實例訊息，而非截斷為 200 字元的預覽
- 移除 IPC 秘密驗證 — socket `chmod 0o600` 已足夠且更簡單

## [0.3.4] - 2026-03-26

### 變更
- 移除斜線指令 (`/open`, `/new`, `/meets`, `/debate`, `/collab`) — General 實例透過 `create_instance` / `start_instance` 處理專案管理
- 移除無用程式碼：`sendTextWithKeyboard`、`spawnEphemeralInstance`、會議頻道方法

## [0.3.3] - 2026-03-25

### 修復
- 修正測試斷言中的 `statusline.sh` → `statusline.js`

## [0.3.2] - 2026-03-25

### 新增
- 帶有動態匯入的頻道轉接器工廠，用於未來的多平台支援
- 意圖導向的轉接器方法：`promptUser`、`notifyAlert`、`createTopic`、`topicExists`
- Telegram 權限提示上的「一律允許」按鈕
- `InstanceConfig` 中的每個實例 `cost_guard` 欄位
- `ChannelAdapter` 上的 `topology` 屬性 (`"topics"` | `"channels"` | `"flat"`)

### 變更
- 頻道抽象化階段 A — 從業務邏輯中移除所有 TelegramAdapter 耦合（fleet-manager, daemon, topic-commands 現在使用通用的 ChannelAdapter 介面）
- CLI 版本從 package.json 讀取而非硬編碼值
- 排程子指令現在有 `.description()` 用於幫助文字

### 修復
- statusline 腳本中的 shell 注入 — 將 bash 替換為 Node.js 腳本
- 設定精靈與配置中的時區驗證 (Intl.DateTimeFormat)
- `max_age_hours` 預設值在設定精靈、配置和 README 中統一為 8 小時
- `pino-pretty` 從 devDependencies 移至 dependencies（修復 `npm install -g`）
- 在重啟時清除 `toolStatusLines` 以防止無限增長
- 為 daemon-entry 中的 `--config` `JSON.parse` 加入 try-catch
- 移除無用程式碼 `resetToolStatus()`
