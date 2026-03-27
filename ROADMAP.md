# Roadmap

## 1. Channel Abstraction — 能力模型決策

目前 CCD 只支援 Telegram，fleet 架構依賴 Telegram 的 forum topic 做 instance 路由。其他平台（Discord 用 channel、有些平台沒有類似概念）接入時需要決定如何處理差異。

**待決定：**

- **Topic-required** — 只支援有 topic/channel 概念的平台
- **Capability-based** — adapter 宣告能力，有 topic 就用，沒有就 fallback
- **Lowest common denominator** — 全部退化成 1 對 1 訊息模型

決策影響 ChannelAdapter interface 設計和 fleet-manager routing 邏輯。

**前置工作已完成：** Phase A 移除了 business logic 對 TelegramAdapter 的直接耦合，ChannelAdapter interface 已清理乾淨。

## 2. Discord Adapter

能力模型決策後，實作 `DiscordAdapter implements ChannelAdapter`：

- Discord bot 連線、收發訊息
- Discord channel 對應到 CCD instance（類似 Telegram topic → instance 路由）
- 處理 Discord 特有功能（embed、reaction、thread）

這是驗證 channel abstraction 設計的第一個實際案例。

## 3. Message Queue Stress Test

`message-queue.ts` 負責合併、限速、排隊所有送出的訊息。現有 unit test 只測邏輯正確性，缺乏：

- 短時間灌入大量訊息時的記憶體和延遲表現
- 多 queue 同時高併發
- 429 backoff 連續觸發下的穩定性

需要寫專門的 load test 確認生產環境下的穩定性。

## 4. Context Rotation E2E Test

Claude 對話超過 context window 時，CCD 自動做 context rotation（handover summary → 重啟 session）。`context-guardian.ts` 狀態機有完整 unit test，但缺乏：

- 實際 daemon 運行中觸發 rotation 的 integration test
- Rotation 過程中訊息不丟失的驗證
- Summary 正確傳遞給新 session
- 多 instance 同時 rotate 的互不干擾

## 5. Container-Claude（長期）

目前每個 instance 直接在 host 上跑 `claude` CLI。長期目標是把 Claude 跑在獨立容器裡：

- 隔離 instance 之間的檔案系統存取
- 用 `setup-token` 免互動式登入
- 提升安全性（instance 不能碰其他 instance 的檔案）

先前的 Docker sandbox 方案因複雜度過高已廢棄，需要重新設計。
