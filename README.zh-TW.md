<p align="center">
  <h1 align="center">AgEnD</h1>
  <p align="center">
    <strong>用手機管理一整個 AI coding agent 團隊。</strong>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@suzuke/agend"><img src="https://img.shields.io/npm/v/@suzuke/agend" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg" alt="Node.js >= 20"></a>
  </p>
</p>

> [!WARNING]
> **AgEnD 已進入維護模式。** 新功能開發已轉移到
> **[agend-terminal](https://github.com/suzuke/agend-terminal)** — 用 Rust 重寫，
> 原生 PTY 多工、跨平台支援（macOS / Linux / Windows）、內建多 pane TUI。所有新功能
> 都會在那邊推出。
>
> 本套件仍會收到安全性修正和 backend CLI 相容性更新，但不再加新功能。既有的
> `@suzuke/agend` 安裝不會壞。
>
> `agend-terminal` 目前是 pre-alpha — 建議等到 1.0 再遷移，或現在就試（請接受 API
> 會變）。

AgEnD（**Agent Engineering Daemon**）把你的 Telegram 或 Discord 變成 AI coding agent 的指揮中心。一個 bot，多種 CLI 後端，無限專案 — 每個都是獨立 session，crash 自動恢復，不用顧。

<p align="center">
  <code>你 → Telegram/Discord → AgEnD → AI Agent 團隊 → 結果回到你的手機</code>
</p>

[English](README.md) · [功能文件](docs/features.md) · [CLI 參考](docs/cli.md)

---

## 為什麼用 AgEnD？

| 沒有 AgEnD | 有 AgEnD |
|---|---|
| 關掉終端機，agent 就斷線 | 系統服務常駐，重開機也不怕 |
| 一個終端機 = 一個專案 | 一個 bot，無限專案同時跑 |
| 長時間 session 累積過時 context | 依 max age 自動輪替 session，保持新鮮 |
| 不知道 agent 半夜在幹嘛 | 每日花費報告 + 卡住偵測通知 |
| Agent 各做各的，無法協作 | 點對點協作，透過 MCP tools |
| 無人看管時帳單暴增 | 每個 instance 每日花費上限，自動暫停 |

## 功能亮點

🚀 **Fleet 管理** — 一個 bot、N 個專案。每個 Telegram Forum Topic 就是獨立的 agent session。

🔄 **多後端支援** — Claude Code、Gemini CLI、Codex、OpenCode、Kiro CLI，自由切換或混用。

🤝 **Agent 協作** — Agent 之間透過 MCP tools 互相發現、喚醒、傳訊。General Topic 用自然語言把任務路由到對的 agent。

📱 **手機操控** — 從 Telegram inline 按鈕核准工具使用、重啟 session、管理整個 fleet。

🛡️ **自主又安全** — 花費上限、卡住偵測、model failover、context 輪替，fleet 不用顧也能穩穩跑。

⏰ **持久化排程** — cron 排程任務，SQLite 儲存，重啟不遺失。

🎤 **語音訊息** — 用 Groq Whisper 轉文字，用說的跟 agent 溝通。

📄 **HTML 對話匯出** — 把任何 agent session 匯出成獨立 HTML 檔，方便分享或存檔。

🪞 **Mirror Topic** — 跨 instance 可見性。從另一個 topic 即時觀看其他 agent 的工作。

🖥️ **Web Dashboard** — 瀏覽器即時 fleet 監控，SSE 更新 + 整合聊天介面。

🔌 **可擴充** — Discord adapter、webhook 通知、health endpoint、外部 session 透過 IPC 連入。

## 開始用

一行安裝（macOS / Linux — 自動裝 Node.js（經 nvm）+ tmux + agend，完成後跑 quickstart）：

```bash
curl -fsSL https://suzuke.github.io/AgEnD/install.sh | bash
```

或手動安裝：

```bash
npm install -g @suzuke/agend    # 1. 安裝
agend quickstart                # 2. 設定 — bot token、backend，搞定
agend fleet start               # 3. 啟動 fleet 🎉
```

打開 Telegram，傳訊息給你的 bot，開始用手機寫 code。

## 運作原理

```mermaid
graph LR
  You["你<br/>(手機 / 電腦)"] <-->|訊息| Channel["Telegram / Discord<br/>/ Web UI"]
  Channel <-->|路由| Daemon["AgEnD Daemon"]

  subgraph Fleet
    Daemon --> General["General<br/>Dispatcher"]
    Daemon --> A["Instance A<br/>Claude Code<br/>專案 X"]
    Daemon --> B["Instance B<br/>Gemini CLI<br/>專案 Y"]
    A <-.->|MCP Tools| B
    General -.->|路由任務| A
    General -.->|路由任務| B
  end
```

1. **你傳訊息**給 Telegram/Discord bot
2. 傳到 **General Topic** 的訊息會被解讀並路由到對的 agent。傳到特定 topic 的訊息則直接送到該 instance。
3. **Agent instance** 在獨立的 tmux session 跑，各有自己的專案和 CLI 後端
4. **Agent 之間協作** — 透過 MCP tools 委派任務、分享 context、回報結果
5. **結果回傳**到你的聊天室。權限請求以 inline 按鈕呈現。

## 支援的後端

| Backend | 安裝 | 認證 |
|---------|------|------|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude`（OAuth）或 `ANTHROPIC_API_KEY` |
| OpenAI Codex | `npm i -g @openai/codex` | `codex`（ChatGPT 登入）或 `OPENAI_API_KEY` |
| Gemini CLI | `npm i -g @google/gemini-cli` | `gemini`（Google OAuth） |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | `opencode`（設定 provider） |
| Kiro CLI | `brew install --cask kiro-cli` | `kiro-cli login`（AWS Builder ID） |

## 系統需求

- Node.js >= 20
- tmux
- 以下任一 AI coding CLI（需安裝並完成認證）
- Telegram bot token（[@BotFather](https://t.me/BotFather)）或 Discord bot token
- Groq API key（選用，語音轉文字用）

> **⚠️** 所有 CLI 後端都以 `--dangerously-skip-permissions`（或等效參數）執行。詳見 [Security](SECURITY.md)。

## 文件

- [Features](docs/features.md) — 功能詳細說明
- [CLI Reference](docs/cli.md) — 所有指令與選項
- [Configuration](docs/configuration.zh-TW.md) — fleet.yaml 完整設定參考
- [Security](SECURITY.md) — 信任模型與安全強化

## 已知限制

- 支援 macOS（launchd）和 Linux（systemd），不支援 Windows
- 全域 `enabledPlugins` 裡有官方 Telegram plugin 會造成 409 polling 衝突
- OpenCode 和 Kiro CLI 不讀取 MCP server 的 `instructions` 欄位 — fleet context 和 workflow template 不會注入到這些 backend 的 system prompt。等待上游修復。

## 授權

MIT
