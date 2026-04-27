# AgEnD 發展藍圖

> [!WARNING]
> **AgEnD 已進入 maintenance mode**。新功能開發已移至
> **[agend-terminal](https://github.com/suzuke/agend-terminal)** —— 一個以 Rust 重寫的版本,
> 具備原生 PTY multiplexing、跨平台支援 (macOS / Linux / Windows),以及內建的多 pane TUI。
> 所有新功能都將在該版本推出。
>
> 本藍圖紀錄的是 `@suzuke/agend` 在 v1.12.0 時的規劃狀態,僅作歷史參考。後續方向以
> `agend-terminal` 為準。

> 最後更新：2026-04-06 (v1.12.0)
> 由多代理共識產出：Claude Code, Codex, Gemini CLI, OpenCode, Kiro CLI

## 已完成 (v1.0–v1.3)

- [x] 多後端支援 (Claude Code, Codex, Gemini CLI, OpenCode, Kiro CLI)
- [x] 多頻道支援 (Telegram, Discord)
- [x] Fleet 編排（持久化專案 instance）
- [x] 跨 instance 委派 (`send_to_instance`, `delegate_task`, `report_result`)
- [x] Cron 排程（SQLite 持久化，重啟後存活）
- [x] 成本防護與每日限制
- [x] Context 輪轉（自動刷新過期 session）
- [x] `/sysinfo` fleet 診斷
- [x] `safeHandler` 非同步錯誤邊界
- [x] FleetManager 模組化 (`RoutingEngine`, `InstanceLifecycle`, `TopicArchiver`, `StatuslineWatcher`, `OutboundHandlers`)
- [x] IPC socket 強化 (umask TOCTOU 修復)
- [x] 平台無關核心（所有 Telegram/Discord 邏輯都在 adapter 中）

## 已完成 (v1.4-v1.12)

- [x] Shared Decisions — SQLite 跨 instance 知識共享（fleet/project scope）
- [x] Task Board — 任務追蹤，支援依賴關係、優先級、claim/done 生命週期
- [x] Activity Visualization — Activity Log (SQLite) + Web UI（Mermaid、Network Graph、Agent Board、Replay）
- [x] Tool Profiles — full/standard/minimal MCP 工具集，降低 token 開銷
- [x] Broadcast tool — fleet 全域或 tag 過濾廣播
- [x] Tags — instance 標籤，用於 broadcast/list_instances 過濾
- [x] Display names — agent 透過 set_display_name MCP 工具自行命名
- [x] checkout_repo — 跨 repo 存取，讓 agent 可以存取其他專案
- [x] Backend error pattern detection — PTY 監控，per-backend 錯誤偵測，自動通知 + failover
- [x] Model failover — rate limit 時自動切換備用模型（statusline + PTY 偵測）
- [x] Gemini system prompt 注入（`GEMINI_SYSTEM_MD` 環境變數）
- [x] launchd (macOS) + systemd (Linux) 服務支援，`agend install/start/stop/restart`
- [x] System prompt UX — `file:` prefix、`system-prompt.md` 慣例、透過 `description` 設定角色
- [x] Hot reload — `SIGHUP` 觸發完整 config reconcile（新增/移除/重啟 instance）
- [x] `agend update` — 透過 npm 自我更新，可選 daemon 重啟
- [x] Backend doctor/trust — `agend backend doctor` 診斷、`agend backend trust` Gemini 信任
- [x] 完整繁體中文文件（features、CLI、configuration、roadmap、security、changelog）
- [x] fleet.yaml 設定參考（中英文）
- [x] Hang detection 搭配 Telegram 重啟按鈕
- [x] 每日成本摘要報告
- [x] Webhook 通知（Slack、自訂端點）
- [x] Health endpoint 供外部監控
- [x] Context-bound reply/react/edit_message — tool call 中不需 chat_id/thread_id，daemon 自動從當前 context 填入
- [x] Teams — 具名 instance 群組，支援 `create_team`/`list_teams`/`update_team`/`delete_team`；`broadcast(team:)` 精準廣播
- [x] 自動建立 `working_directory` — fleet.yaml 中省略時使用 `~/.agend/workspaces/<name>`
- [x] `create_instance` directory 選填 — 省略時自動建立工作空間
- [x] 跨 instance 通知改善 — 降低噪音、`sender → receiver: summary` 格式、過濾 General Topic
- [x] MCP instructions 注入 — fleet context 透過 MCP server instructions 注入，取代 CLI flags（v1.9.0）
- [x] Kiro CLI backend — AWS Kiro CLI 支援，含 session resume 與 MCP config（v1.11.0）
- [x] 內建 workflow 模板 — coordinator/executor 分層，透過 MCP instructions 注入（v1.11.0）
- [x] Crash-aware snapshot restore — crash 時寫入 snapshot，跨 daemon 重啟持久化（v1.11.0）
- [x] Fleet ready 通知 — 「N/M instances running」發送到 General topic（v1.11.0）
- [x] E2E 測試框架 — 79+ 測試在 Tart VM 中執行（v1.11.0）
- [x] Web UI 儀表板 — SSE 即時監控，整合聊天介面（v1.12.0）
- [x] agend quickstart — 簡化 4 問題新手引導精靈（v1.12.0）
- [x] HTML 對話匯出 — `agend export-chat` 支援日期篩選（v1.12.0）
- [x] Mirror Topic — 透過專屬 topic 觀察跨 instance 通訊（v1.12.0）
- [x] project_roots 限制 — create_instance 工作目錄邊界驗證（v1.12.0）

---

## 下一步：可觀測性

**目標：** 讓 fleet 運作可見，且不改變 agent 行為。

---

## 第一階段：可觀測性與儀表板

**目標：** 不離開瀏覽器就能看到 fleet 運作狀態。

### 1.1 REST API 擴展
將現有的健康檢查伺服器擴展為完整的 fleet API：
- `GET /api/fleet` — `getSysInfo()` JSON
- `GET /api/instances/:name` — instance 詳情、日誌、成本
- `GET /api/events` — `EventLog` 查詢（成本快照、輪轉、hang）
- `GET /api/cost/timeline` — 成本趨勢數據
- `POST /api/instances/:name/restart` — 觸發重啟

**工作量：** 約 200 行。數據已存在於 `EventLog` (SQLite) 和 `getSysInfo()` 中。

### ~~1.2 成本分析儀表板 (MVP)~~ → 部分完成
- [x] Activity Log 含成本追蹤 (SQLite)
- [x] Web UI：Agent Board、Network Graph、Replay
- [ ] 每個 instance 的成本趨勢圖 (Chart.js)
- [x] 透過 SSE 即時更新

### ~~1.3 任務時間軸與錯誤檢視器~~ → 部分完成
- [x] Activity Log 涵蓋任務指派/完成
- [x] Backend error detection 含事件紀錄
- [ ] 排程執行歷史檢視器

---

## 第二階段：工程工作流整合

**目標：** 讓 AgEnD 成為實際工程工作流的一部分，不僅是聊天工具。

### 2.1 GitHub / GitLab 整合
- 從 issue、PR 或 webhook 觸發 agent 任務
- 將結果作為 PR 評論或 issue 更新回報
- 排程 repo 維護（每晚分類、依賴更新）

### 2.2 CI/CD Hooks
- Fleet as Code — 透過 git 管理 instance config
- 透過 PR merge 部署/更新 instance
- Agent 輔助 review 的 pre-commit hook

### ~~2.3 對話歷史與持久化~~ → 部分完成
- [x] Activity Log 記錄所有跨 instance 訊息
- [x] Context rotation v3 snapshot 延續關鍵 context
- [ ] 完整進站/出站訊息紀錄
- [ ] 可搜尋的對話歷史

---

## 第三階段：外掛與擴充系統

**目標：** 讓社群不需 fork 就能擴展 AgEnD。

### 3.1 外掛架構
- 掃描 `~/.agend/plugins/` 中的 npm 套件
- Backend、channel、tool 外掛的動態 `import()`
- 標準介面已存在：`CliBackend`、`ChannelAdapter`、`outboundHandlers` Map

### 3.2 自訂工具外掛
- 透過外掛註冊額外 MCP 工具
- Tool Profiles 已支援自訂集合 — 延伸到外掛提供的工具

### 3.3 策略與權限
- 每個 instance 的環境/沙盒控制
- 高風險操作的人工核准流程
- 團隊角色存取控制

---

## 第四階段：生態系統擴展

**目標：** 跨頻道、後端和使用情境擴大覆蓋。

### 4.1 更多頻道
- **Slack**（透過 Bolt SDK 約 300-400 行）— 企業採用
- **Web Chat** (WebSocket server) — 自託管控制面板
- `ChannelAdapter` 抽象已驗證；新 adapter 不動核心程式碼

### 4.2 更多後端
- **Aider**（約 50-80 行）— 最受歡迎的開源 coding agent
- ~~**Kiro** (AWS)~~ — 已完成（v1.11.0）
- **自訂 CLI** — 說明如何為任何工具實作 `CliBackend`

### 4.3 智慧後端路由
- 依任務類型自動選擇後端（快速修復 → 快速模型，架構 → 強力模型）
- 比較各後端的成本/延遲/成功率
- 基於歷史表現的路由建議

---

## 第五階段：進階運作（長期）

### 5.1 Agent 群集協調
- 自動任務分解與委派
- Agent 對 Agent 招募（coding agent → 安全掃描 agent → review agent）
- 帶有結果聚合的平行執行

### ~~5.2 全 Fleet 知識中心~~ → 部分完成
- [x] Shared Decisions（架構決策、慣例、偏好）
- [x] Task Board 跨 instance 工作追蹤
- [ ] 基於 RAG 的專案文件檢索
- [ ] 從過去任務結果中學習

### ~~5.3 自癒 Fleet~~ → 部分完成
- [x] Rate limit 時自動重啟 + model failover
- [x] PTY error detection 自動通知
- [x] Crash loop 偵測與 respawn 暫停
- [ ] Rate limit 預測與先發制人的後端切換
- [ ] 成本/延遲模式異常偵測

### 5.4 Control Plane / Data Plane 分離
- Data Plane（本地）：daemon 在程式碼和機密附近運行
- Control Plane（選用雲端）：跨機器發現、全域排程、統一監控

---

## AgEnD-RS（實驗性）

**目標：** Rust 重寫，追求效能、單一執行檔發佈、原生終端多工。

- Fork [Zellij](https://github.com/zellij-org/zellij) terminal multiplexer
- Feature flag 模組（`#[cfg(feature = "agend")]`）— 最小化 Zellij 改動（約 25 行）
- 模組：config、fleet、monitor、mcp（24 工具）、telegram、routing、daemon、db、ipc、backend、lifecycle
- 狀態：Phase 7 完成（核心模組），Phase 8 進行中（端對端整合）

---

## 明確延後

| 方向 | 理由 |
|------|------|
| Agent 市集 | 生態系統尚不成熟；需先有外掛系統 |
| 多機器分佈式 Fleet | 架構改動過大；先專注單機卓越 |
| LINE 頻道 | API 複雜，全域市場有限 |
| 原生桌面應用 | 開發成本高；Web UI 已能滿足需求 |
| 成本分析深入 | 準確性存疑；待 statusline 數據驗證後再做 |

---

## 產品定位

> **AgEnD 不是另一個 coding agent。它是讓 coding agent 作為團隊運作的維運層。**

- 後端無關：適用於任何 coding CLI
- 頻道原生：Telegram/Discord 作為 human-in-the-loop 控制平面
- 持久化 instance：每個專案/repo 一個 instance，非拋棄式聊天
- Fleet 協調：跨專案和後端進行委派、排程、監控和控制
