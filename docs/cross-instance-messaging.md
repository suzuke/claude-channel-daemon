# Cross-Instance Messaging

Instance 之間以及外部 Claude Code session 與 daemon instance 之間的通訊機制。

## MCP Tools

### `list_instances`

列出所有可用的 instance（不含自己）。

```
→ list_instances()
← { instances: ["ccplugin", "blog-t1385", "codereview-t1415"] }
```

### `send_to_instance`

發送訊息給指定 instance。訊息以 `fleet_inbound` 形式到達對方的 channel，對方自行決定是否回覆。

```
→ send_to_instance({ instance_name: "ccplugin", message: "幫我 review 這個 diff" })
← { sent: true, target: "ccplugin" }
```

## 訊息流程

```
發送方 Claude                     Fleet Manager              接收方 Claude
     │                                 │                           │
     │  send_to_instance               │                           │
     │  (tool_call via MCP)            │                           │
     │ ───────────────────────────────►│                           │
     │                                 │                           │
     │                                 │  fleet_inbound            │
     │                                 │  (IPC to target daemon)   │
     │                                 │──────────────────────────►│
     │                                 │                           │
     │                                 │  Telegram: ← sender: msg  │
     │                                 │  (posted to target topic) │
     │                                 │                           │
     │  Telegram: → target: msg        │                           │
     │  (posted to sender topic)       │                           │
     │                                 │                           │
     │  { sent: true }                 │                           │
     │◄───────────────────────────────│                           │
```

## Telegram 可見性

每條跨 instance 訊息都會同時 post 到雙方的 Telegram topic：

- 發送方 topic：`→ targetName: 訊息預覽`
- 接收方 topic：`← senderName: 訊息預覽`

訊息超過 200 字會自動截斷。

## 外部 Session 雙向通訊

外部 Claude Code session（不是 daemon 管理的 instance）也能與 daemon instances 通訊。

### 前置條件

1. `.mcp.json` 指向 daemon instance 的 IPC socket：

```json
{
  "mcpServers": {
    "ccd-channel": {
      "command": "node",
      "args": ["<project>/dist/channel/mcp-server.js"],
      "env": {
        "CCD_SOCKET_PATH": "~/.claude-channel-daemon/instances/<name>/channel.sock"
      }
    }
  }
}
```

2. 啟動時帶 `--dangerously-load-development-channels` flag：

```bash
claude --dangerously-load-development-channels server:ccd-channel
```

### 為什麼需要這個 flag？

| | 沒有 flag | 有 flag |
|---|---|---|
| `send_to_instance` | ✅ 可以發送 | ✅ 可以發送 |
| `list_instances` | ✅ 可以查詢 | ✅ 可以查詢 |
| 接收回覆 | ❌ 靜默丟棄 | ✅ 顯示為 `<channel>` block |

MCP tools 本身不需要 channel flag — 它們是標準的 tool call/response。但**接收方回覆時**，訊息以 MCP notification（`notifications/claude/channel`）形式推送。Claude Code 只在啟用 development channels 時才處理這類 notification。

### 安全風險

低。`--dangerously-load-development-channels` 允許 MCP server 注入 channel notification 到 Claude 的對話中。但在此場景下：

- IPC socket 是 local Unix socket，僅限當前使用者存取
- MCP server 是自己的程式碼
- Daemon instances 本身已經在用這個 flag

## IPC 實作細節

### fleetRequestId 避免 broadcast collision

Cross-instance tools 用 `fleetRequestId`（而非 `requestId`）廣播到 fleet manager。這是因為 daemon 的 `ipcServer.broadcast()` 會送到所有 IPC client（包括 MCP server），如果用 `requestId`，MCP server 會提前 resolve pending request。

```typescript
// daemon.ts — 發送 cross-instance tool call
const fleetReqId = `xmsg_${requestId}`;
this.ipcServer.broadcast({
  type: "fleet_outbound",
  tool,
  args,
  fleetRequestId: fleetReqId,  // 不用 requestId
});
```

```typescript
// fleet-manager.ts — 回覆時帶 fleetRequestId
ipc.send({ type: "fleet_outbound_response", fleetRequestId, result, error });
```

### cross-instance 訊息的 meta

```typescript
{
  chat_id: "cross-instance",
  message_id: `xmsg-${Date.now()}`,
  user: `instance:${senderName}`,
  user_id: `instance:${senderName}`,
  from_instance: senderName,
}
```

`from_instance` 欄位可用來識別訊息來源是其他 instance 而非人類使用者。

## Graceful Restart

開發 daemon 功能時，修改 code 後需要重啟 daemon 才能生效。

### `ccd fleet restart`

發送 SIGUSR2 給 fleet manager process，觸發 graceful restart：

1. 等待所有 instance idle（10 秒無 transcript activity）
2. Stop 所有 instances
3. 重新載入 fleet config
4. Start 所有 instances
5. 重建 IPC connections

Fleet manager process 本身不會重啟 — adapter、scheduler 保持運作。

```bash
npm run build && ccd fleet restart
```

Telegram group 會收到通知：
- `🔄 Graceful restart initiated — waiting for all instances to idle...`
- `✅ Graceful restart complete — 8 instances running`

### 注意事項

- Fleet manager 的 SIGUSR2 handler 需要在 fleet manager 啟動後才生效。第一次部署新的 restart 功能時，仍需手動 `ccd fleet stop && ccd fleet start`。
- Restart 後所有 instance 的 Claude session 重新開始（使用 `--resume` 恢復 session state）。
- 如果某個 instance 長時間不 idle（例如正在跑長任務），restart 會一直等待。

## 外部 Session 協同開發模式

外部 Claude Code session 可以透過跨 instance 通訊與 daemon instances 協同開發：

```
外部 Session                                    Daemon Instances
     │                                               │
     │  1. 修改 daemon 程式碼                          │
     │  2. npm run build                              │
     │  3. ccd fleet restart                          │
     │     (等 idle → stop → start)                    │
     │                                               │
     │  4. send_to_instance("ccplugin",               │
     │     "restart 後功能正常嗎？")                     │
     │ ──────────────────────────────────────────────►│
     │                                               │
     │◄──────────────────────────────────────────────│
     │  5. 收到 channel notification:                  │
     │     "restart OK"                               │
     │                                               │
     │  6. 繼續開發下一個功能...                         │
```

### 啟動方式

```bash
claude --dangerously-load-development-channels server:ccd-channel
```

### 能力

- 修改 daemon code 並 build
- 用 `ccd fleet restart` 重啟 daemon
- 用 `send_to_instance` 請 daemon instance 驗證功能
- 收到 daemon instance 的回覆（channel notification）
- 全程不離開 terminal session
