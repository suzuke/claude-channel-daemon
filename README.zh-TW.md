# AgEnD

[![npm](https://img.shields.io/npm/v/@suzuke/agend)](https://www.npmjs.com/package/@suzuke/agend)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg)](https://nodejs.org)

**Agent Engineering Daemon** — 用手機管理一整個 AI coding agent 團隊。

一個 Telegram bot，多種 CLI 後端（Claude Code、Gemini CLI、Codex、OpenCode），無限專案。每個 Forum Topic 就是一個獨立的 agent session，crash 自動恢復，不用顧。

[English](README.md)

> **⚠️** 所有 CLI 後端都以 `--dangerously-skip-permissions`（或等效參數）執行。詳見 [Security](SECURITY.md)。

## agend 解決什麼問題

| 沒有 agend | 有 agend |
|---|---|
| 關掉終端機，agent 就斷線 | 系統服務常駐，重開機也不怕 |
| 一個終端機 = 一個專案 | 一個 bot，無限專案同時跑 |
| 長時間 session 累積過時 context | 依 max age 自動輪替 session，保持新鮮 |
| 不知道 agent 半夜在幹嘛 | 每日花費報告 + 卡住偵測通知 |
| 排程任務隨 session 結束消失 | 持久化排程，SQLite 儲存 |
| 某個 model 被限速，全部停擺 | 自動切換備用 model |
| 沒辦法從手機核准工具使用 | Telegram inline 按鈕，倒數計時 + Always Allow |
| Agent 各做各的，無法協作 | 點對點協作，透過 MCP tools |
| 無人看管時帳單暴增 | 每個 instance 每日花費上限，自動暫停 |

## 開始用

```bash
brew install tmux               # macOS（前置需求）
npm install -g @suzuke/agend    # 安裝 AgEnD
agend init                      # 互動式設定（選 backend + channel）
agend fleet start               # 啟動 fleet
```

## 功能

- **Fleet 模式** — 一個 bot、N 個專案，各自獨立的 Telegram Forum Topic
- **持久化排程** — cron 排程任務，重啟不遺失（SQLite 儲存）
- **Context 輪替** — 長時間 session 依 max age 自動重啟，保持 context 新鮮
- **點對點協作** — agent 之間透過 MCP tools 互相發現、喚醒、傳訊
- **General Topic** — 自然語言調度器，把任務路由到對的 agent
- **權限轉發** — Telegram inline 按鈕 Allow/Deny，倒數計時 + Always Allow
- **語音訊息** — Groq Whisper 轉文字，用說的跟 agent 溝通
- **花費上限** — 每個 instance 每日限額，超過自動暫停
- **卡住偵測** — 自動偵測無回應的 session，通知並提供重啟按鈕
- **Model Failover** — 被限速時自動切換備用 model
- **每日摘要** — Fleet 花費報告，發到 Telegram
- **外部 Session** — 本地 Claude Code 透過 IPC 連入 fleet
- **Discord Adapter** — 用 Discord 取代（或同時使用）Telegram
- **Health Endpoint** — HTTP API 供外部監控
- **Webhook 通知** — 推送事件到 Slack 或自訂 endpoint
- **系統服務** — 一行指令裝成 launchd/systemd 服務

## 系統需求

- Node.js >= 20
- tmux
- 以下任一 AI coding CLI（需安裝並完成認證）：

| Backend | 安裝 | 認證 |
|---------|------|------|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude`（OAuth）或 `ANTHROPIC_API_KEY` |
| OpenAI Codex | `npm i -g @openai/codex` | `codex`（ChatGPT 登入）或 `OPENAI_API_KEY` |
| Gemini CLI | `npm i -g @google/gemini-cli` | `gemini`（Google OAuth） |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | `opencode`（設定 provider） |

- Telegram bot token（[@BotFather](https://t.me/BotFather)）或 Discord bot token
- Groq API key（選用，語音轉文字用）

## 文件

- [Features](docs/features.md) — 功能詳細說明
- [CLI Reference](docs/cli.md) — 所有指令與選項
- [Configuration](docs/configuration.zh-TW.md) — fleet.yaml 完整設定參考
- [Security](SECURITY.md) — 信任模型與安全強化

## 已知限制

- 支援 macOS（launchd）和 Linux（systemd），不支援 Windows
- 全域 `enabledPlugins` 裡有官方 Telegram plugin 會造成 409 polling 衝突

## 授權

MIT
