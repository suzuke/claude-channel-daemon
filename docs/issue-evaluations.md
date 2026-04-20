# Issue Evaluations

存放對 GitHub open issues 的效益／tradeoff 分析。日後若決定動工，可直接從這裡延伸到 feature-roadmap.md 或 fix-plan。

---

## #24 — Notify sender when recipient instance has hit usage limit

**狀態**：未排入計畫（2026-04-20 評估）
**類型**：feature（不屬安全/可靠性 fix）

### 痛點（原 issue 摘要）

- Recipient instance（如 codex backend）在任務途中 hit usage limit 後仍會回覆，但回覆是不完整或捏造的。
- Sender（general）無從得知，要嘛無限等待、要嘛根據假回報行動。
- 當前 workaround：sender 對所有 critical operation 手動驗證。

### 效益

- **正確性 ↑↑**：消除 silent failure；sender 收到結構化 error 後可改路由或停手。
- **多 instance 編排可行性 ↑**：fleet 越大、limit-trip 機率越高；無回饋拉低 multi-backend 組合的可用性上限。
- **實作成本低**：基礎設施齊備：
  - `cost-guard.isLimited(instance)` 已存在（`src/cost-guard.ts:147`）
  - FleetManager 持有 `costGuard`
  - `OutboundContext` 已能接到 fleet config／lifecycle
  - 只差在 `sendToInstance` / `delegateTask` dispatch 前加一道 `isLimited` 檢查 + respond error
  - 粗估 < 50 行 + 2-3 個 unit test

### Tradeoff / 風險

- **Race window**：limit 是事件性檢查；A 已 dispatch 但 recipient 在 1ms 內 trip → 仍可能漏掉。pre-dispatch 處理 90% 場景，剩下需 recipient-side 在 IPC response 標記 `limit_tripped`，但會擴大 scope。
- **Policy 設計題**：trip 後是 (a) reject 並讓 sender 自行 retry／改路由、(b) queue 待 limit reset、(c) overflow 給其他同 backend instance？issue 提到 (a)/(b)，需先決策。**queue 路線**等於要新增 persistence + retry policy + TTL，容易膨脹。
- **跨 backend 不一致**：`isLimited` 目前只看 `daily_limit_usd`；codex 有 daily quota 但 claude-code 是 5h window，目前無感知。解了 issue 也只解了 budget-limit、解不了 backend-specific rate-limit。標題的「usage limit」其實混合兩件事。
- **行為改變**：先前可發出的呼叫現在會回 error；少量行為破壞性，但 sender 的 LLM 對 error response 一般能正確處理。

### 建議 scope（KISS）

- **Phase A**：pre-dispatch 加 `isLimited` 檢查，return 結構化 error（含 `target`, `reason: "daily_limit_reached"`, `reset_at`）。不做 queue。
- **Phase B**（後續）：recipient-side 在 IPC response 標 `limit_tripped: true`，sender 收到後 surface。
- Queue 留給 Phase C，多數需求 Phase A 已解掉。

---

## #8 — Default topic package for new users

**狀態**：未排入計畫（2026-04-20 評估）
**類型**：feature

### 痛點（原 issue 摘要）

- 新用戶第一次用 agend 時，要自行決定開幾個 instance、各自 prompt 怎寫、如何協作。
- 希望 wizard 提供一組「general + planner + builder + reviewer」之類已驗證可協作的預設組合，用戶之後再透過 `post_decisions` 或編 fleet.yaml 微調。

### 效益

- **第一次體驗 ↑**：直接降低 onboarding 門檻。
- **Best-practice 內建**：把分工模式變成預設值，避免新手用一個 instance 包山包海。
- **示範材料**：preset 本身是好的 example，幫助後續編 fleet.yaml 有參考。

### Tradeoff / 風險

- **Maintenance burden**：preset 進 repo 後，每次改 backend／IPC／system prompt schema 都要同步維護；很容易腐爛成 stale 範例。
- **Opinion lock-in**：選哪一組 preset、planner 用什麼 backend、token 預算多少都是強 opinion；用戶 backend／預算／工作流不同，preset 的「最佳實踐」很可能不適用。
- **依賴外部 API key**：每個 preset agent 需要對應 backend 已安裝＋有 key；wizard 必須先檢測再篩可用 preset，否則建出來跑不動更糟。
- **Token 預算**：4 個 instance 同時跑，cost 直接 ×4；對沒注意 budget 的新手會踩雷（剛好跟 #24 互相關聯）。
- **與 fleet.yaml 直編的衝突**：用戶若用 wizard 建 preset 後又手動編，preset upgrade 怎麼處理？需 versioning 或文件講清楚「preset 只是初始種子，之後不追蹤」。
- **實作成本中**：不只新增 YAML template，還要 wizard flow 多一個分支、檢測可用 backend、產生 system prompt、解釋角色——比 #24 複雜不少。

### 建議 scope（KISS）

- 不做「精緻可擴充的 template framework」。
- 提供 1-2 個 hard-coded preset YAML（例：「Solo Coding（general + builder）」、「Planning Team（general + planner + builder + reviewer）」），放 `src/presets/`。
- Wizard 多一個問題：「想要 (1) preset (2) 自己一個 instance」；choose preset 後自動寫 fleet.yaml，**不維護 upgrade path**——明示「之後請直接編 fleet.yaml」。
- 完全不做 backend 自動檢測；preset 設定統一用 wizard 已選的 default backend。

---

## 比較與優先序建議

| 維度 | #24 usage-limit notify | #8 default preset |
|---|---|---|
| 解決痛點明確度 | 高（issue 描述具體 reproducible） | 中（onboarding 抽象痛點） |
| 實作成本 | 小（< 50 行 + 測試） | 中（wizard flow + preset 維護） |
| 行為改變風險 | 低-中（多了 reject 路徑） | 無（純新功能，不動既有 user） |
| 維護負擔 | 低 | 中-高（preset 易腐） |
| 影響範圍 | 所有多 instance 用戶 | 只影響首次 setup |

**推薦優先序**：先做 #24 Phase A（高 ROI、低風險、issue 具體），#8 視社群迴響再決定要不要做 minimal 版。
