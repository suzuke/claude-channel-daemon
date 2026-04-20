# 更新日誌 (Changelog)

本專案的所有顯著變更都將記錄在此檔案中。

格式基於 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)。

## [未發佈] (Unreleased)

### 修復 (Fixed)
- **Instance 目錄被外部刪除時健康檢查迴圈會停止** — 先前若 daemon 執行中有人 `rm -rf ~/.agend/instances/<name>`，健康檢查每 ~30s 會不斷嘗試 respawn，產生 `ENOENT … rotation-state.json` / `tmux server died` / `Failed to respawn Claude window` 的連鎖錯誤 spam。現在每次 tick 開頭會檢查 `instanceDir` 是否還存在，不存在就暫停該 instance 的健康檢查。

## [1.23.0] - 2026-04-20

收束 `docs/fix-plan.md` Phase 1–4 安全/可靠性修復計畫。共 36 項修復／重構，分散於 7 個 PR（#33, #38, #39, #40, #41, #42, #43, #44）。

### 安全 (Security)
- **Phase 1 邊界硬化** (PR #33) — 每 instance 獨立 `/agent` token、`/ui/*` 全部 mutation 走 zod 驗證、template 變數消毒、tar entry 驗證、`project_roots` symlink resolve、branch / logPath 防 argument injection、`web.token` 0o600。
- **Telegram apiRoot 白名單** (P3.3, `9a7b16b`) — 防止透過攻擊者控制的 `apiRoot` 外洩 bot token。
- **Webhook HMAC-SHA256 簽章** (P3.1, `e65b97c`) — outbound webhook 簽章；接收端可驗證來源。
- **STT 必須顯式 opt-in** (P3.4, `1fc513e`) — 語音轉文字不再因有 env 就啟用，需 `fleet.yaml` `stt.enabled: true`。
- **`/update` 安全化** (P3.6, `740c202`, `d38a583`) — 空 `allowed_users` 整個拒絕 `/update`；兩段 token 確認（8 hex、60s TTL）；安裝時版本鎖；健康探針失敗自動回滾；supersede 通知。
- **`access-path` 拒絕 instance 名 path traversal** (P4.3, `d5d41b7`) — 白名單 `^[A-Za-z0-9._-]+$`，拒 `..` / `/` / `\` / NUL。
- **`.env` 0o600** (P4.4, `49a4328`) — wizard 寫憑證檔加上嚴格權限 + chmod 兜底。
- **CORS 收緊、支援 Bearer auth** (P3.5, `b180232`) — 拿掉 wildcard CORS；web API 接受 `Authorization: Bearer <token>`。
- **`paths.ts` md5 → sha256** (P4.5, `1f91c3c`) — 消除 FIPS／掃描器告警。custom `AGEND_HOME` 用戶升級後 tmux session/socket 後綴會變一次。

### 修正 (Fixed)
- **Telegram 409 polling 上限** (P3.2, `c67f776`) — retry 上限 30 次，避免無窮 polling。
- **Topic archiver 持久化** (P2.6, `f134a66`, `42d5d1f`) — archived topic 跨重啟保留，atomic write 至 `<dataDir>/archived-topics.json`。
- **IPC 單行上限 10MB → 1MB** (P3.7, `d446384`) — overflow 結構化拒絕,避免 OOM。
- **Tmux pane cache 在 control-mode 重連時清除** (P2.1, `e967bbb`)。
- **TranscriptMonitor 重入鎖** (P2.4, `65be144`) — 防止重疊的 `pollIncrement`。
- **Scheduler 啟動時 catch-up 24h 內漏跑** (P2.3, `01e1e32`, `24d6f8a`)。
- **Cost-guard session rotation 重置 emitted flags** (P2.2, `875a0b2`) — `warnEmitted` / `limitEmitted` 正確重置，rotation 後新 session 不會無聲衝過 daily cap。
- **SSE dead client 驅逐 + socket error 處理** (P2.5, `ae2a810`) — `broadcastSseEvent` 對單一 dead client 寫入失敗不再 break 整個 loop；`req.on("error")` 在 ECONNRESET 清理 client set。
- **拿掉 instance 啟動後多餘的 sleep+reconnect** (P2.7, `872547b`) — `startInstance` await 鏈已保證 IPC 就緒。
- **Cost-guard DST 處理** (P2.8, `3c9ff9f`) — `msUntilMidnight` 改用 `Intl.DateTimeFormat` + 二分搜尋，DST 春令／秋令日不再偏 ±1h。
- **MessageQueue flood-control backoff 重置** (P3.8, `3474c04`) — drop 後 backoff 真正重置，不會卡在 ~30s。

### 變更 (Changed)
- **`fleet-manager.ts` 拆檔** (P4.1, PR #43) — 2842 → 1658 行（-1184）。新增四個模組：
  - `fleet-dashboard-html.ts`（442 行）— dashboard HTML 常數
  - `fleet-instructions.ts`（168 行）— `GENERAL_INSTRUCTIONS` + `ensureGeneralInstructions`
  - `fleet-rpc-handlers.ts`（387 行）— IPC + HTTP CRUD dispatch
  - `fleet-health-server.ts`（326 行）— `startHealthServer` + `getUiStatus` + `extractWebToken`

  皆採 Context-injection：模組宣告 narrow `XxxContext` interface、FleetManager `implements`、外部以 `this` 呼叫純函數。
- **`daemon.handleToolCall` 抽出 helper** (P4.2, `e6a9596`) — 抽出 `dispatchFleetRpc(...)`。`handleToolCall` 182 → ~120 行，daemon.ts 淨 -51 行。
- **`validateTimezone` 單一化** (P4.4, `49a4328`) — `scheduler/scheduler.ts` 移除本地副本，import `config.ts` 的版本。

### 文件 (Docs)
- **`docs/fix-plan.md` Phase 1–4 結案** — 所有 P 項目皆 ✅ 或移至 **Deferred / Future Work**（logger rotation、cost-guard tiebreaker 兩項屬 feature 不屬 fix）。
- **`docs/p4.1-split-plan.md` 歸檔** — 四模組拆檔策略紀錄。
- **`docs/issue-evaluations.md` 新增** — 對 open issue #24（usage-limit notify）、#8（default topic preset）做效益／tradeoff 分析，供未來規劃用。

## [1.22.1] - 2026-04-19

### 修正
- **Discord 附件下載** — `downloadAttachment()` 現在可以正常運作。附件在 `messageCreate` 當下就從 Discord CDN 下載到 `inboxDir`（避開 CDN URL 過期問題），`downloadAttachment()` 改為回傳本地路徑。另外：圖片類附件會被標記為 `photo`（讓 agent 端觸發自動下載）、本地檔名會加上 Discord attachment ID 前綴避免碰撞、同一訊息的多個附件改為並行下載、下載失敗改為 log 而非靜默吞掉，`stop()` 會清理未被消費的暫存檔。關閉 #27。

## [1.22.0] - 2026-04-18

### 新增
- **`agend ls` 顯示 Kiro CLI context 用量** — 使用 Kiro backend 的 instance，清單會額外顯示目前 context window 的使用情形。
- **`agend ls` 顯示系統記憶體用量** — 清單頂端摘要加入主機記憶體壓力資訊，方便 fleet 運維者一眼看出記憶體吃緊的機器。
- **安裝腳本 WSL 偵測** — `install.sh` 偵測到 WSL 環境時會避開 Windows 側的 `node`，解決先前首次安裝因 PATH 誤抓而靜默失敗的問題。

### 變更
- **安裝腳本改用 GitHub Pages 連結** — README 一行安裝改指向 `https://suzuke.github.io/AgEnD/install.sh`（官方 host 版本），不再用 raw GitHub URL。

### 文件
- **一行安裝指令補到 README 與網站首頁** — 先前僅見於 CHANGELOG。
- **README 新增 WSL 安裝說明**。
- **網站 zh-TW hero 調整** — 捨棄商務感的「交付」，改用頁面其他處使用的調度（dispatcher）詞彙。

## [1.21.7] - 2026-04-17

### 變更
- **MCP 工具 schema 統一為 zod** — 所有 outbound 工具現在都在 `src/outbound-schemas.ts` 有對應 zod schema；`src/channel/mcp-tools.ts` 透過 `z.toJSONSchema()` 自動產生 `inputSchema`。移除手寫的 JSON Schema。必填欄位現在拒絕空字串（`minLength: 1`），不再依賴 handler 端的 truthy 檢查。
- **Outbound handler 在入口統一驗證** — `src/outbound-handlers.ts` 的 18 個 handler 先呼叫 `safeParse` 再執行邏輯；先前約 35 處未檢查的 `args.X as string` cast 全部消除。`wrapAsSend` 也接收 schema，`request_information` / `delegate_task` / `report_result` 享有同樣的保證。

## [1.21.6] - 2026-04-17

### 安全
- **Web API 介面強化**（H1、H2、H7）
- **daemon 的認證、路徑安全與資料洩漏修補**（H3、H4、H5、H6）
- **後端命令強化** — `buildCommand()` 加入 model 名稱驗證與 env 值 quoting
- **CLI 輔助函式** — 避免 shell invocation，並從 `ps` 輸出中遮蔽 token
- **Scheduler 強化** — 時區白名單、檔案數量上限、lightweight 模式守衛
- **Kiro MCP wrapper 權限** — `wrapper.sh` 收緊至 `0o700`（僅擁有者）
- **Outbound 錯誤清理** — 回傳給 agent 的工具錯誤先移除 `$HOME` 路徑並截斷至 300 字元

### 修復
- **Discord 過期互動崩潰** — adapter 現在捕捉過期互動錯誤以避免 daemon 崩潰（上游 PR #26）
- **Scheduler 重複觸發** — 原子更新避免兩個 tick 競爭時的重複發動

### 變更
- **Fleet-manager 錯誤可觀測性** — 先前被吞掉的錯誤現在會記錄；adapter 通知提升至較高嚴重度

## [1.21.5] - 2026-04-15

### 新增
- **`send_to_instance` 錯誤狀態警示** — 當目標 instance 被 rate-limited、暫停或處於 crash loop，發送者會在工具回應中收到警告（#24）
- **Codex 週限額偵測** — 偵測「less than N% of your weekly limit」警告並透過 Telegram 通知（action: notify）

### 修復
- **MCP server 透過 ppid 輪詢偵測孤兒** — 主要的孤兒偵測改用 `process.ppid` 輪詢（5 秒間隔）取代 stdin EOF；後者在 macOS 因 libuv/kqueue bug 造成 CPU 空轉而非 `'end'` 事件
- **Fleet 級 tmux server 熔斷器** — 5 分鐘內 2 次以上 tmux server 崩潰會暫停所有 instance 重生 30 秒，防止 thundering herd
- **spawn 失敗時的整棵 process 樹終止** — `killProcessTree()` 對整個 process group（CLI + MCP server）發送 SIGTERM，然後才關閉 tmux window
- **滑動視窗崩潰偵測** — 以 `crashTimestamps` 滑動視窗（5 分鐘內 3 次以上觸發暫停）取代被 backoff > 60s 破壞的 `rapidCrashCount`

## [1.21.4] - 2026-04-14

### 修復
- **崩潰重生時清理孤兒 MCP server** — daemon 讀取 `channel.mcp.pid`，在 spawn 新 CLI 前先清理孤兒 MCP server
- **MCP server 的 stdin EOF 偵測** — 加入 `process.stdin.on('end'/'close'/'error')` 監聽與 PID 檔機制（後於 v1.21.5 被 ppid 輪詢取代）

## [1.21.3] - 2026-04-14

### 修復
- E2E：mock CLI 崩潰應以 exit code 1 結束，而非 0

## [1.21.2] - 2026-04-13

### 修復
- **延遲寫入 prev-instructions 直到 session 建立** — 避免首次 spawn 失敗時 retry 上的變更偵測失敗
- E2E：更新 workflow-template 測試斷言以配合新的標題行為

## [1.21.1] - 2026-04-13

### 修復
- **Kiro CLI 2.0.0 支援** — 更新新版 TUI 的 ready pattern 與啟動對話，修復誤報「找不到」

## [1.21.0] - 2026-04-13

### 新增
- **CLI 模式** — `agent_mode: cli` 設定從 MCP 工具切換為 HTTP 的 agent CLI 端點
- **Agent CLI 端點** — 為 MCP 支援不佳的後端提供 HTTP 替代路徑
- **閒置任務提醒** — 自動對有待辦任務且閒置的 instance 發送提醒

### 修復
- Kiro：啟動時自動關閉 trust-all-tools TUI 確認
- OpenCode：`skipResume` 為 true 時不加上 `--continue`

## [1.20.4] - 2026-04-12

### 新增
- **自動關閉互動式對話** — 後端定義的啟動與執行期對話會自動關閉（trust folders、resume picker、rate limit model 切換）
- **systemPrompt 支援 `file:` 路徑** — 支援逗號分隔的 `file:` 路徑與 YAML 陣列做多檔 prompt 模組化

### 修復
- Claude Code：在啟動對話中加入 session resume prompt
- Instructions：workflow 內容自帶標題時不再出現空的 Development Workflow 標題
- 健康檢查 server 遇到 EADDRINUSE 時關掉舊 process 並重試
- Discord onboarding：10 個 UX 痛點修復
- Kiro：MCP wrapper 中的 env 匯出改為單引號以避免 backtick / dollar 解譯

## [1.20.2] - 2026-04-11

### 新增
- **`agend health`** — 透過 HTTP 端點（`/health`、`/status`）提供 fleet 健康診斷
- **Workflow template 溝通效率規則** — 結構化任務流程、沉默即同意、合併要點

### 修復
- OpenCode `skipResume` 未被遵守 + 重啟通知不一致
- 目錄不是有效的 git worktree 時安全清理

### 變更
- 溝通協定重構 — 以結構化任務流程減少 ack 洗頻

## [1.20.0] - 2026-04-10

### 新增
- **`replace_instance` 工具** — 原子性以新 instance 取代舊 instance，從 daemon 的 ring buffer 收集交接 context
- **ContextGuardian 簡化為純監控** — 移除 max_age 計時器、狀態機與所有重啟觸發器。

### 修復
- 崩潰恢復時若 `--resume` 成功則略過 snapshot 注入
- 刪除 instance 時清理過時的 MCP 項目 + writeConfig

## [1.19.1] - 2026-04-10

### 修復
- **3 個 UX 痛點** — 重啟時重新載入 instructions、單一 instance 重啟時重新載入設定、Web UI 建立 instance 缺欄位

## [1.19.0] - 2026-04-09

### 新增
- **Fleet 範本** — `deploy_template` / `teardown_deployment` / `list_deployments` 支援可重用的 fleet 組態
- **可設定的錯開啟動** — `fleet.yaml` defaults 下的 `startup.concurrency` 與 `startup.stagger_delay_ms`
- **Fleet 狀態與 MCP `list_instances` 的 Backend 欄位**

### 變更
- `agend logs` 整合 — 直接讀取 fleet.log
- `agend fleet status` 與 `agend ls` 合併為單一指令

### 修復
- fleet 啟動時清理孤兒 tmux window
- 避免 fleet stopAll 期間的 quit 命令競爭條件

## [1.18.0] - 2026-04-08

### 新增
- **統一的附加式 system prompt 注入** — 5 種後端全部改用 `--append-system-prompt-file`（Claude Code）、steering 檔（Kiro）或等效機制。Fleet instructions 不再覆蓋內建 prompt。

### 修復
- instance 停止／刪除時一律關閉 tmux window
- OpenCode `opencode.json` 使用 "instructions" 而非 "contextPaths"

## [1.17.5] - 2026-04-08

### 新增
- **崩潰輸出擷取** — 崩潰時擷取 tmux pane 內容供診斷
- **tmux server 崩潰偵測** — 區分 server 級崩潰與單一 window 崩潰

### 修復
- Kiro MCP env 隔離 — 以 wrapper script 取代 process.env 污染
- Kiro MCP transport handshake 失敗 — stdin 競爭條件
- 關閉 tmux window 前透過 quit 指令優雅結束
- 健康檢查以 exit code 區分正常離開（0）與崩潰
- 預先信任 codex 工作區 + 新增 trust 對話 pattern
- `fleet start --instance` 透過 HTTP API 委派給執行中的 daemon

## [1.17.3] - 2026-04-07

### 新增
- **`agend ls` 顯示每個 instance 的記憶體使用量**
- **Channel-aware replies** — inbound meta 帶上 source，並修正格式 passthrough

### 修復
- Codex MCP shell escape + 重啟時注入過時的 snapshot

## [1.17.1] - 2026-04-07

### 新增
- **自訂 AGEND_HOME 的 tmux socket 隔離** — 避免多個 AgEnD 安裝互相衝突

## [1.17.0] - 2026-04-07

### 新增
- **`AGEND_HOME` 環境變數** — 可設定資料目錄（預設：`~/.agend`）

### 修復
- Kiro CLI 重啟崩潰迴圈 — `skipResume` + tmux 清理

## [1.16.2] - 2026-04-07

### 修復
- 崩潰重生的孤兒清理不得阻塞 `spawnClaudeWindow`

## [1.16.1] - 2026-04-07

### 修復
- 避免並行 context 輪轉期間 tmux server 死亡
- P2 code review 改善

## [1.16.0] - 2026-04-07

### 修復
- P0+P1 code review 發現（安全性、錯誤處理、邊界條件）

## [1.15.8] - 2026-04-06

### 修復
- Codex 使用 `resume --last`（依 CWD 範圍，無 SQLite 相依）

## [1.15.6] - 2026-04-06

### 修復
- Kiro resume 改用 boolean `--resume` 旗標

## [1.15.5] - 2026-04-06

### 修復
- 錯誤監控僅掃描最後一個 prompt marker 之後（減少誤判）

## [1.15.3] - 2026-04-06

### 修復
- stop() 清理 + 重啟時 IPC 重連（#14、#12）

## [1.15.1] - 2026-04-06

### 新增
- **自動注入 active decisions** 到 MCP instructions（透過環境變數）
- `/update` topic 指令用於刷新 instance 設定

## [1.15.0] - 2026-04-06

### 新增
- Fleet 事件（輪轉、懸掛、成本警報）的 Webhook 通知
- 用於外部監控的 HTTP 健康檢查端點（`/health`、`/status`）
- 在 Context 輪轉時具有驗證與重試機制的結構化交接範本
- 權限中繼 UX 改進（逾時倒數、持久化的「一律允許」、決定後的回饋）
- 主題圖示自動更新（執行中 / 已停止）+ 閒置封存
- 過濾 Telegram 服務訊息（主題重新命名、置頂等）以節省 token

### 變更
- **Crash recovery 優先嘗試 --resume** — 崩潰重生時先嘗試 `--resume` 恢復完整對話歷史，失敗才 fallback 到全新 session + snapshot 注入

### 修復
- 最小化的 `claude-settings.json` — 允許列表中僅包含 AgEnD MCP 工具，不再覆蓋使用者全域的權限設定

## [1.14.0] - 2026-04-07

### 新增
- **Plugin 系統 + Discord adapter 獨立** — Discord adapter 搬到獨立 `agend-plugin-discord` package；factory.ts 支援 `agend-plugin-{type}` / `agend-adapter-{type}` / 裸名稱慣例；主 package 匯出（`/channel`、`/types`）讓第三方 plugin 可用
- **Web UI Phase 2：完整操控面板** — instance stop/start/restart/delete（name 確認）、建立 instance 表單（directory 可選、backend 自動偵測）、Task board CRUD、排程管理、團隊管理、Fleet 設定編輯器（表單式 + 敏感欄位遮蔽）
- **Web UI 版面：Fleet vs Instance** — Sidebar 加「Fleet」入口顯示 fleet 級 tabs（Tasks、Schedules、Teams、Config）；Instance 只保留 Chat + Detail；跨導航連結
- **Web UI UX 改善** — Toast 通知、載入狀態、Cron 人類可讀描述、加大狀態點、空狀態引導、成本標註、網站一致風格（`#2AABEE` 強調色、Inter + JetBrains Mono 字體）
- **Backend 自動偵測** — `GET /ui/backends` 掃描 PATH；建立 instance 的 dropdown 顯示安裝/未安裝狀態
- **指定 instance 重啟** — `agend fleet restart <instance>` 透過 fleet HTTP API
- **一鍵安裝腳本** — `curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash`
- **project_roots 限制** — `create_instance` 拒絕不在設定 roots 範圍內的目錄

### 修復
- **Web UI 回覆 context** — 首次 web 訊息不再出現「No active chat context」；使用真實 Telegram group_id/topic_id
- **Web↔Telegram 雙向同步** — Web 訊息以 `🌐` 前綴轉發到 Telegram；Telegram 訊息透過 SSE 推送到 Web UI
- **SSE 即時狀態刷新** — 操作按鈕在 stop/start/restart/delete 後即時更新
- **.env 覆蓋** — `.env` 檔案值無條件覆蓋繼承的 shell 環境變數
- **tmux duplicate session race** — `ensureSession()` 處理並行啟動時的競爭條件
- **建立 Instance 表單** — directory 改為可選，topic_name 動態必填

### 變更
- **discord.js 從核心依賴移除** — 僅在安裝 `agend-plugin-discord` 時需要
- **Web API 抽取到 `web-api.ts`** — 縮減 fleet-manager.ts；所有 `/ui/*` 路由集中管理
- **認證統一** — 所有 Web UI 端點（含 restart）都需要 token 認證

## [1.13.0] - 2026-04-06

### 新增
- **Web UI Phase 2：完整操控面板** — 建立/刪除 instance、Task board CRUD（建立、認領、完成）、排程管理（建立、刪除）、團隊管理（成員勾選建立、刪除）、Fleet 設定檢視（唯讀、已清理敏感資訊）
- **Web UI 風格統一** — 對齊網站設計：Telegram 藍 `#2AABEE` 強調色、Inter + JetBrains Mono 字體、深色主題、圓角卡片、Toast 通知、載入狀態
- **一鍵安裝腳本** — `curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash` 一行完成安裝（Node.js via nvm、tmux、agend、後端偵測）
- **project_roots 限制** — `create_instance` 拒絕不在 `project_roots` 範圍內的目錄
- **認證統一** — 所有 Web UI 端點（包含 restart）都需要 token 認證

### 修復
- **Web UI 回覆 context** — 首次從 Web UI 發訊不再出現「No active chat context」錯誤；使用真實 Telegram group_id/topic_id
- **即時狀態刷新** — Instance 操作按鈕在 stop/start/restart/delete 後透過 SSE 即時更新
- **Web↔Telegram 雙向同步** — Web 訊息以 `🌐` 前綴轉發到 Telegram topic；Telegram 訊息透過 SSE 推送到 Web UI

### 文件
- 全面文件盤點：所有文件新增 20+ 遺漏功能
- 網站全面改版為 Spectra 風格深色設計

## [1.12.0] - 2026-04-06

### 新增
- **Web UI 儀表板** — `agend web` 啟動瀏覽器 fleet 監控，SSE 即時更新 + 整合聊天介面，支援 Telegram 雙向同步
- **agend quickstart** — 簡化 4 問題設定精靈，取代 `agend init` 作為推薦的新手入口
- **project_roots 限制** — `create_instance` 驗證工作目錄在設定的 `project_roots` 範圍內
- **HTML 對話匯出** — `agend export-chat` 匯出 fleet 活動為獨立 HTML，支援日期篩選（`--from`、`--to`）
- **Mirror Topic** — `mirror_topic_id` 設定，在專屬 topic 觀察跨 instance 通訊

### 修復
- **平行啟動** — 處理多 instance 同時啟動時的 tmux duplicate session race
- **.env 優先覆蓋** — `.env` 的值正確覆蓋繼承的 shell 環境變數
- **Web UI 聊天同步** — Web UI 與 Telegram 之間的雙向訊息同步

### 文件
- README 大改版：hero section、功能亮點、架構圖、運作原理說明
- Quick Start 改為使用 `agend quickstart`
- 全面文件盤點：features.md、cli.md、configuration.md 更新所有 v1.11.0-v1.12.0 功能

## [1.11.0] - 2026-04-05

### 新增
- **Kiro CLI backend** — 新增 AWS Kiro CLI 支援（`backend: kiro-cli`）。支援 session resume、MCP config、error patterns。模型：auto、claude-sonnet-4.5、claude-haiku-4.5、deepseek-3.2 等
- **內建 workflow 模板** — fleet 協作流程透過 MCP instructions 自動注入。可在 fleet.yaml 的 `workflow` 欄位設定（`"builtin"`、`"file:path"` 或 `false`）
- **Workflow 分層：coordinator vs executor** — General instance 取得完整 coordinator 指南（Choosing Collaborators、Task Sizing、Delegation Principles、Goal & Decision Management）。其他 instance 取得精簡的 executor 版本（Communication Rules、Progress Tracking、Context Protection）
- **`create_instance` 的 systemPrompt 參數** — 建立 instance 時可傳入自訂 system prompt（僅支援 inline 文字）
- **Fleet ready Telegram 通知** — `startAll` 和 `restartInstances` 完成後發送「Fleet ready. N/M instances running.」到 General topic，含失敗 instance 報告
- **E2E 測試框架** — 79+ 測試在 Tart VM 中隔離執行。Mock backend 支援 `pty_output` 指令模擬錯誤。T15 workflow 模板測試、T16 failover cooldown 測試
- **Token overhead 量測** — 測試腳本（`scripts/measure-token-overhead.sh`）與報告。Full profile：+887 tokens（佔 200K context 的 0.44%，$0.003/msg）
- **Codex 用量限制偵測** — 「You've hit your usage limit」error pattern（action: pause）
- **MockBackend error patterns** — `MOCK_RATE_LIMIT` 和 `MOCK_AUTH_ERROR` 供 E2E 測試使用

### 修復
- **Crash recovery snapshot restore** — 在 crash 偵測時寫入 snapshot（不只 context rotation）；以 in-memory `snapshotConsumed` flag 取代 single-consume 刪除，檔案保留供 daemon 重啟恢復
- **Codex session resume** — `CodexBackend.buildCommand()` 現在在 session-id 存在時使用 `codex resume <session-id>`（#11）
- **Rate limit failover 循環** — failover 類型的 PTY error 加入 5 分鐘 cooldown，防止 terminal buffer 殘留文字重複觸發（#10）
- **PTY error monitor hash dedup** — recovery 時記錄 pane hash，同畫面同 error 不重複觸發
- **CLI restart 等待** — bootout/bootstrap 之間的固定 1 秒改為動態 polling（最多 30 秒），修復多 instance 時「Bootstrap failed: Input/output error」
- **CLI attach 互動選單** — fuzzy match 多個結果時顯示編號選單而非報錯
- **CLI logs ANSI 清理** — 增強 `stripAnsi()` 處理 cursor 移動、DEC private modes、carriage returns 等
- **agent 訊息中的 `reply_to_text`** — 用戶回覆的原始訊息內容現在包含在 paste 給 agent 的格式化訊息中
- **General instructions 按 backend 產生** — auto-create 根據 `fleet.defaults.backend` 寫入對應檔案（CLAUDE.md、AGENTS.md、GEMINI.md、.kiro/steering/project.md）
- **General instructions 每次啟動確認** — `ensureGeneralInstructions()` 在每次 `startInstance` 時呼叫，不只 auto-create
- **內建文字英文化** — 所有系統產生的文字從中文改為英文（排程通知、語音訊息標籤、general instructions）
- **General 委派原則** — 改寫為 coordinator 角色：主動委派，以具體條件判斷

### 變更
- Fleet start/restart 通知統一為「Fleet ready. N/M instances running.」格式，送到 General topic
- 移除 `buildDecisionsPrompt()` dead code（v1.9.0 已故意停用）
- 移除 fleet-manager 的 `getActiveDecisionsForProject()`（dead code）

### 文件
- OpenCode MCP instructions 限制（v1.3.10 不讀取 MCP instructions 欄位）
- Kiro CLI MCP instructions 限制（未驗證）
- Token overhead 報告（EN + zh-TW）含可重現的測試腳本

## [1.10.0] - 2026-04-05

_中間版本，改動已包含在 1.11.0。_

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
