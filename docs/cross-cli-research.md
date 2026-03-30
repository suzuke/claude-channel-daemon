# CCD 跨 CLI 統一架構研究筆記

日期：2026-03-30

## 目標

移除對 Claude Channel Protocol 的依賴，讓 CCD 能支援 Claude Code、Gemini CLI、OpenCode、Codex 等任何 coding CLI。

## 現狀分析

CCD 的 MCP server (`ccd-channel`) 依賴 Claude Code 專有的 channel protocol：

- **Outbound（agent → Telegram）**：MCP tool call `reply` — **標準 MCP，已通用**
- **Inbound（Telegram → agent）**：`notifications/claude/channel` — **Claude 專有，其他 CLI 不支援**
- **Permission relay**：`notifications/claude/channel/permission` — **Claude 專有**
- **CLI 啟動 flag**：`--dangerously-load-development-channels` — **Claude 專有**

## 各 CLI 的能力比較

| CLI | MCP tools | Server push inbound | Plugin 系統 | Headless mode | Resume session |
|-----|:-:|:-:|:-:|:-:|:-:|
| Claude Code | ✅ | ✅ `claude/channel` | ✅ channels/plugins | ✅ `claude -p --resume $id` | ✅ session ID |
| Gemini CLI | ✅ | ❌ | ❌ | ✅ `gemini --prompt` | ✅ `--resume` |
| OpenCode | ✅ | ❌ | ✅ `tui.prompt.append` | ✅ `opencode run` / SDK | ✅ `--continue` |
| Codex | ✅ | ❌ | ❌ | ✅ `codex --prompt` | ❓ |

## 討論過的方案

### 1. tmux paste-buffer（Scion 的做法）
- Inbound：tmux paste-buffer 貼文字到 CLI prompt
- Outbound：MCP tool call
- **問題**：agent 收到純文字，不知道要用 `reply` tool 回覆到 Telegram。沒有結構化 metadata（chat_id, user 等）。Scion 不做 outbound 到 Telegram 所以不需要解這個問題。
- **結論**：不夠可靠，是 workaround 不是解法

### 2. MCP resource subscription
- 把 inbox 建模成 MCP resource，用 `notifications/resources/updated` 通知 CLI
- **問題**：不確定各 CLI 是否實作了 resource subscription
- **結論**：理論上可行但實際支援不明

### 3. `get_messages` polling tool
- Agent 定期呼叫 MCP tool 拿新訊息
- **問題**：LLM agent 不會「定期」呼叫任何東西，只在回應時才行動
- **結論**：不適用於 LLM agent

### 4. Shell command（`ccd reply`、`ccd msg`）
- Outbound 用 shell command 替代 MCP tool
- **問題**：Inbound 還是要靠 tmux 注入，而且 agent 怎麼知道要用 shell command 回覆
- **結論**：可作為 MCP 的 fallback，但不是主要方案

### 5. Headless mode per-call（`claude -p --resume`）
- 每次收到 Telegram 訊息，spawn 一個 CLI process 處理
- Inbound = function call 參數，Outbound = stdout JSON
- **優點**：跨 CLI 統一、結構化 I/O、不需要 tmux/channel protocol
- **問題**：每次 spawn 新 process，2-5 秒延遲（Node.js 啟動 + MCP 載入 + session 讀取）
- **結論**：可行但延遲太高，尤其 cross-instance messaging

### POC 結果（2026-03-30）

```
測試環境：macOS, Node.js 25.8.0, Claude Code 2.1.81
狀態：rate limited（7-day 100%），無法測試完整 API 流程

啟動延遲 breakdown（3 次平均）：
  Total wall time:  ~2.8s
  API duration:     ~0.4s (rate limited stub)
  Startup overhead: ~2.4s (Node.js + Claude Code init)

JSON output 結構確認：
  ✅ session_id — 可用於 --resume
  ✅ result — 文字回覆
  ✅ is_error — 錯誤偵測
  ✅ duration_ms, total_cost_usd — 監控數據
  ✅ num_turns — 多輪追蹤

MCP 整合確認：
  ✅ --mcp-config 可載入自訂 MCP server
  ✅ --allowedTools 可預先授權 MCP tools
  ✅ MCP server stderr 可捕獲 tool calls
  ❌ 無法測試實際 tool call（rate limited）

Resume 確認：
  ✅ --resume $session_id 接續對話
  ✅ session_id 在 JSON output 中返回

架構驗證：
  ✅ 不需要 tmux
  ✅ 不需要 channel protocol
  ✅ 不需要 IPC socket
  ✅ 結構化 I/O（JSON in/out）
  ❌ 2.4s 固定啟動開銷（不可接受用於 cross-instance messaging）
  ❓ 待測：實際 API call 時的 MCP tool call 捕獲
```

POC 程式碼：`poc-headless.mjs`

### 6. Headless 常駐 process（最有前景）⭐
- 把 CLI 跑成常駐 process，用程式化 API 持續對話
- Claude Code：Agent SDK（TypeScript/Python package）
- OpenCode：`opencode serve` + SDK client
- Gemini CLI：待確認是否有類似 SDK
- **優點**：常駐（無啟動延遲）、跨 CLI、結構化 I/O、支援 MCP
- **待確認**：Agent SDK 是否支援 long-lived session（多次 send 不退出）

## 三選二的限制

在目前的 MCP 標準下（沒有 server push），跨 CLI 統一和 Telegram outbound 存在矛盾：

1. 跨 CLI 統一 + Telegram outbound → 需要 workaround（不可靠）
2. 跨 CLI 統一 + 可靠通訊 → 放棄 Telegram outbound（Scion 模式）
3. Telegram outbound + 可靠通訊 → 保留 channel protocol（現狀）

**Headless 常駐 process 方案可能打破這個限制**——因為 CCD 直接控制 CLI 的 I/O，不需要 CLI 自己知道怎麼回覆到 Telegram。

## 下一步

1. 確認 Claude Code Agent SDK 是否支援 long-lived session（多次 `.send()` 不退出）
2. 確認 Gemini CLI 是否有類似的 SDK/server mode
3. 如果可行，設計 CCD 的 `CliBackend` interface 來抽象不同 CLI 的 headless API
4. 評估是否需要保留 tmux 作為 fallback（用戶想 attach 看 agent 工作時）

## Scion 的做法（參考）

- 通訊：tmux paste-buffer + docker exec（粗糙但通用）
- 隔離：容器（CCD 之前做過又砍掉）
- 權限：`--yolo` / `--dangerously-skip-permissions`（靠容器隔離保安全）
- Agent 間通訊：agent 跑 `scion message <other-agent> "msg"`
- 哲學：「Less is More」— 不做上層功能，讓 model 自己決定怎麼協調

## 今天完成的修復（v0.5.1）

1. 移除 threshold-based context rotation（Claude Code auto-compact 處理）
2. CLI 欄位對齊修復
3. saveFleetConfig 保留 health_port
4. Hang detection 誤報修復（recordInbound 機制）
5. tmux window 重複修復（fleet-level cleanup + setTimeout 替代 setInterval + spawning flag）
6. Crash loop detection（rate limit 時暫停 respawn + Telegram 通知）
7. Rate limit 攔截（100% 時直接回覆用戶）+ 恢復通知
8. 移除 save-state prompt
9. 清理 131 行 dead code（DM mode、memory layer、deprecated fields）
10. 加 /reload Telegram 指令
11. 加 ccd fleet cleanup 命令
12. --reload 偵測 launchd 避免重複 fleet
13. README Commands 段落更新
