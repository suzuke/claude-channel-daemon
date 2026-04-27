# CLI 參考 (CLI Reference)

> [!WARNING]
> **AgEnD 已進入 maintenance mode**。新功能開發已移至
> **[agend-terminal](https://github.com/suzuke/agend-terminal)** —— 一個以 Rust 重寫的版本,
> 具備原生 PTY multiplexing、跨平台支援 (macOS / Linux / Windows),以及內建的多 pane TUI。
> 所有新功能都將在該版本推出。
>
> 本文件僅為現有 `@suzuke/agend` 安裝的使用者保留。

## Telegram 指令 (General 主題)

| 指令 | 描述 |
|---------|-------------|
| `/status` | 顯示 Fleet 狀態、Context % 和成本 |
| `/restart` | 在進程內重啟所有實例（不結束進程） |
| `/upgrade` | 結束進程以套用新代碼（需 launchd/systemd 自動重啟） |
| `/sysinfo` | 顯示詳細的系統診斷資訊（版本、負載、IPC 狀態） |

所有其他操作（建立/刪除/啟動實例、委派任務）均由 General 實例透過自然語言處理。

## 服務管理 (Service Management)

這些指令用於管理 AgEnD Daemon 進程。

```bash
agend start                     # 啟動 AgEnD 服務（需先安裝）
agend stop                      # 停止 AgEnD 服務
agend restart                   # 重啟 AgEnD 服務
agend update                    # 更新 AgEnD 到最新版本並重啟服務
agend reload                    # 熱讀取配置（重新讀取 fleet.yaml，啟動新實例）
```

## Fleet 管理 (Fleet Management)

```bash
agend fleet start               # 啟動所有實例（手動模式）
agend fleet stop                # 停止所有實例
agend fleet restart             # 優雅重啟（等待閒置，相同代碼）
agend fleet restart --reload    # 使用新代碼重啟（自殺並等待系統重啟）
agend fleet status              # 顯示實例狀態概覽
agend fleet logs <name>         # 顯示特定實例日誌
agend fleet history             # 顯示事件歷史（成本、輪轉、懸掛）
agend fleet activity            # 顯示活動日誌（協作、工具呼叫、訊息）
agend fleet activity --format mermaid # 以 Mermaid 序列圖格式輸出活動
agend fleet cleanup             # 移除孤兒實例目錄
```

## 後端診斷 (Backend Diagnostics)

```bash
agend backend doctor [backend]  # 檢查後端環境（代碼、驗證、tmux、TERM）
agend backend trust <backend>   # 預先核准工作目錄（避免 Gemini CLI 的信任對話框）
```

## 排程 (Schedules)

```bash
agend schedule list             # 列出所有排程
agend schedule add              # 新增排程
agend schedule delete <id>      # 刪除排程
agend schedule enable <id>      # 啟用排程
agend schedule disable <id>     # 停用排程
agend schedule history <id>     # 顯示排程執行紀錄
```

## 主題綁定 (Topic Bindings)

```bash
agend topic list                # 列出實例與 Telegram 主題的綁定關係
agend topic bind <name> <tid>   # 手動將實例綁定到特定主題 ID
agend topic unbind <name>       # 解除實例的主題綁定
```

## 存取控制 (Access Control)

```bash
agend access list <name>        # 列出實例允許的使用者
agend access add <name> <uid>   # 新增允許的使用者
agend access remove <name> <uid> # 移除使用者
agend access lock <name>        # 鎖定實例存取（僅限白名單）
agend access unlock <name>      # 解鎖實例存取（開啟配對模式）
```

## 設定與安裝 (Setup & Installation)

```bash
agend init                      # 互動式設定精靈
agend install                   # 安裝為系統服務 (launchd/systemd)
agend install --activate        # 安裝並立即啟動服務
agend uninstall                 # 移除系統服務
agend export [path]             # 匯出配置以用於遷移
agend import <file>             # 從匯出檔案匯入配置
```
