# claude-channel-daemon

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-compatible-blueviolet.svg)](https://docs.anthropic.com/en/docs/claude-code)

**用手機管理一整個 Claude Code agent 團隊。** 一個 Telegram bot、無限專案——每個 Forum Topic 就是一個獨立的 Claude session，crash 自動恢復，不用顧。

[English](README.md)

> **⚠️ 注意：** daemon 使用 Claude Code 原生的 permission relay——權限請求會以 Telegram inline 按鈕（允許／拒絕）轉發給你。詳見[權限系統](#權限系統)。

## 為什麼要做這個

Claude Code 的官方 Telegram plugin 是 **1 bot = 1 session**。終端機關掉，bot 就斷了。沒有沙盒、沒有排程、不支援多專案。

**claude-channel-daemon** 把 Claude Code 變成一個 always-on 的多專案 AI 工程團隊，全從 Telegram 操控：

| 功能 | 官方 Plugin | claude-channel-daemon |
|------|:-:|:-:|
| 同時跑多個專案 | — | **N 個 session，1 個 bot** |
| 關掉終端機 / SSH 斷線也不怕 | — | **tmux 持久化** |
| Cron 排程任務 | — | **內建** |
| 自動 context 輪替（避免 session 老化）| — | **內建** |
| 權限請求 Telegram 確認 | — | **Inline 按鈕** |
| 語音訊息 → Claude | — | **Groq Whisper** |
| 建 Topic = 自動綁定專案 | — | **內建** |
| 裝成系統服務（launchd/systemd）| — | **一行指令** |
| Crash 自動恢復 | — | **自動重啟** |

## 適合誰

- **獨立開發者**——讓 Claude 全天候同時處理多個 repo
- **小型團隊**——共用一個 bot，每個人各自的 Forum Topic
- **CI/CD 重度使用者**——用 cron 排程讓 Claude 做每日 PR review、deploy 檢查
- **安全意識強的人**——需要工具使用的明確權限審批
- 受夠了為了跟 Claude 說話得一直開著終端機的人

## 跟其他方案比較

| | claude-channel-daemon | Claude Code Telegram Plugin | Cursor / Windsurf | Cline (VS Code) |
|---|:-:|:-:|:-:|:-:|
| 無頭執行（不需要 IDE/終端機）| **有** | 需要終端機 | 沒有 | 沒有 |
| 多專案 Fleet | **有** | 1 個 session | 1 個視窗 | 1 個視窗 |
| 排程任務 | **有** | 沒有 | 沒有 | 沒有 |
| Context 自動輪替 | **有** | 沒有 | N/A | 沒有 |
| 權限審批流程 | **有** | 沒有 | N/A | 有限 |
| 手機優先（Telegram）| **有** | 有 | 沒有 | 沒有 |
| 語音輸入 | **有** | 沒有 | 沒有 | 沒有 |
| 系統服務 | **有** | 沒有 | N/A | N/A |
| Crash 自動恢復 | **有** | 沒有 | N/A | N/A |

## 架構

```
                          ┌─────────────────────────────────────────────────────────┐
                          │                    Fleet Manager                        │
                          │                                                         │
Telegram ◄──long-poll──► │  TelegramAdapter (Grammy)     Scheduler (croner)        │
                          │       │                          │                      │
                          │  threadId 路由表                  │ cron 觸發            │
                          │  #277→proj-a  #672→proj-b        │                      │
                          │       │                          │                      │
                          │  ┌────┴────┐  ┌────┴────┐  ┌────┴────┐                 │
                          │  │Daemon A  │  │Daemon B  │  │Daemon C  │                │
                          │  │Permission│  │Permission│  │Permission│                │
                          │  │Relay     │  │Relay     │  │Relay     │                │
                          │  │Context   │  │Context   │  │Context   │                │
                          │  │Guardian  │  │Guardian  │  │Guardian  │                │
                          │  └────┬─────┘  └────┬─────┘  └────┬─────┘                │
                          │       │              │              │                     │
                          │  ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐               │
                          │  │tmux win  │  │tmux win  │  │tmux win  │               │
                          │  │Claude    │  │Claude    │  │Claude    │               │
                          │  │+MCP srv  │  │+MCP srv  │  │+MCP srv  │               │
                          │  └──────────┘  └──────────┘  └──────────┘               │
                          └─────────────────────────────────────────────────────────┘
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

### 跨 Instance 訊息

Instance 之間可以透過 MCP tools 溝通：

- `send_to_instance` — 傳訊息給另一個執行中的 instance（被動通知）
- `list_instances` — 查看所有執行中的 instance

訊息會同時顯示在發送者和接收者的 Telegram topic 裡。

### 優雅重啟

`ccd fleet restart` 發送 SIGUSR2 給 fleet manager。它會等所有 instance 空閒（10 秒無 transcript 活動）後逐一重啟。5 分鐘超時防止卡住。

### Telegram 指令

Topic 模式下，bot 在 General topic 回應以下指令：

- `/open [關鍵字]` — 瀏覽並綁定現有專案目錄到新 topic
- `/new <名稱>` — 建新專案目錄 + git init + 綁定到 topic
- `/meets "議題"` — 用 Agent Teams 開啟多角度討論
- `/debate "議題"` — 開啟正反方辯論
- `/collab --repo ~/app "任務"` — 用 git worktree 開啟協作開發

### 權限系統

使用 Claude Code 原生的 permission relay——權限請求會以 Telegram inline 按鈕（允許／拒絕）轉發給你。當 Claude 要求使用敏感工具時，daemon 會在 Telegram 上提示你，並等待你的回應後才繼續執行。

### 語音轉文字

Telegram 語音訊息透過 Groq Whisper API 轉文字後送給 Claude。Topic 模式和 DM 模式都支援。需要在 `.env` 設定 `GROQ_API_KEY`。

### 自動 Topic 綁定

Topic 模式下，在 Telegram 建新的 Forum Topic 會觸發互動式目錄瀏覽器。選專案目錄 → instance 自動設定、topic 綁定、Claude 啟動。刪除 topic 會自動解除綁定並停止 instance。

## 開始用

```bash
git clone https://github.com/suzuke/claude-channel-daemon.git
cd claude-channel-daemon
npm install && npm link

# 需要
brew install tmux        # macOS

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
ccd install               裝成系統服務
ccd uninstall             移除系統服務
```

## 設定

Fleet 設定檔在 `~/.claude-channel-daemon/fleet.yaml`：

```yaml
project_roots:
  - ~/Projects

channel:
  type: telegram
  mode: topic           # topic（推薦）或 dm
  bot_token_env: CCD_BOT_TOKEN
  group_id: -100xxxxxxxxxx
  access:
    mode: locked         # locked 或 pairing
    allowed_users:
      - 123456789

defaults:
  context_guardian:
    threshold_percentage: 60
    max_age_hours: 8
  log_level: info

instances:
  my-project:
    working_directory: /path/to/project
    topic_id: 277
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

## 已知限制

- 目前只在 macOS 測過
- 全域 `enabledPlugins` 裡有官方 telegram plugin 會造成 409 polling 衝突（daemon 會自動重試）

## 授權

MIT
