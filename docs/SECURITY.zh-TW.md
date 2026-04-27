# 安全考量 (Security Considerations)

> [!WARNING]
> **AgEnD 已進入 maintenance mode**。新功能開發已移至
> **[agend-terminal](https://github.com/suzuke/agend-terminal)**。
>
> `@suzuke/agend` 的安全回報仍然受理 —— 請依本文件描述的流程提交。針對新版程式碼的
> 安全回報請改提交至 `agend-terminal`。

透過 Telegram 遠端執行 Claude Code 與坐在終端機前相比，會改變信任模型。請注意以下事項：

## Telegram 帳號 = Shell 存取權限

`allowed_users` 中的任何使用者都可以指示 Claude 在主機上執行任意 shell 指令。如果您的 Telegram 帳號遭到入侵（session 被盜、社交工程、借用手機），攻擊者實際上就擁有了 shell 存取權限。緩解措施：

- 啟用 Telegram 兩步驟驗證 (2FA)
- 保持最簡的 `allowed_users` 列表
- 盡可能使用 `pairing` 模式而非預先配置使用者 ID
- 在 `claude-settings.json` 中審核 Claude Code 的權限允許/拒絕列表

## 繞過權限 (`skipPermissions`)

`skipPermissions` 配置選項會將 `--dangerously-skip-permissions` 傳遞給 Claude Code，這會停用所有工具使用的權限提示。這意味著 Claude 可以讀取/寫入任何檔案、執行任何指令並發送網路請求，而無需詢問。這是 Claude Code 官方用於自動化場景的旗標，但在遠端 Telegram 上下文中，這意味著**任何操作都沒有人工參與**。僅在您完全信任部署環境時才啟用此功能。

## 允許列表中的 `Bash(*)`

預設情況下（當 `skipPermissions` 為 false 時），agend 在 Claude Code 的權限允許列表中配置了 `Bash(*)`，這樣 shell 指令就不需要逐一核准。拒絕列表封鎖了一些具破壞性的模式（`rm -rf /`、`dd`、`mkfs`），但這是一個黑名單 — 它無法涵蓋所有危險指令。這符合 Claude Code 自己的權限模型，其中 `Bash(*)` 是一個支援進階使用者的配置。

如果您想要更嚴格的控制，請編輯 `claude-settings.json`（在 `~/.agend/instances/<name>/` 中為每個實例生成）中的 `allow` 列表，使用特定模式如 `Bash(npm test)`、`Bash(git *)` 代替 `Bash(*)`。

## IPC Socket

daemon 透過位於 `~/.agend/instances/<name>/channel.sock` 的 Unix socket 與 Claude 的 MCP server 通訊。該 socket 被限制為僅限所有者存取 (`0600`) 並需要共享金鑰握手。這些措施可防止其他本地進程注入訊息，但無法防範同一台機器上遭入侵的使用者帳號。

## 機密資訊儲存

機器人 token 和 API 金鑰以純文字形式儲存在 `~/.agend/.env` 中。`agend export` 指令包含此檔案並發出關於安全傳輸的警告。如果主機是共用的，請考慮使用檔案系統加密。
