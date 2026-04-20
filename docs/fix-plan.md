# AgEnD 修正計劃

基於 2026-04-18 ultrareview 的整體 codebase 審查，四階段修復計劃。

**狀態圖例**：⬜ 未開始　🟦 進行中　✅ 完成　⏭️ 略過／推遲

---

## 進度總覽

| Phase | 範圍 | 狀態 | 分支 |
|---|---|---|---|
| Phase 1 | 安全邊界 | ✅ 完成 | `fix/phase-1-security` (merged #33) |
| Phase 2 | 可靠性核心 | 🟦 5/8 | `fix/audit-followups` (P2.6) |
| Phase 3 | 外部介面治理 | 🟦 2/8 | `fix/audit-followups` (P3.2, P3.7) |
| Phase 4 | KISS 與測試 hygiene | 🟦 部分 | - |

---

## Phase 1 — 安全邊界

| ID | 項目 | 狀態 | Commit |
|---|---|---|---|
| P1.1 | `/agent` endpoint 身份驗證（per-instance token） | ✅ | `3d2cdd3` |
| P1.2 | `web.token` 檔權限 0o600 | ✅ | `6efd3a9` |
| P1.3 | `/ui/*` 與 `/agent` 全面 zod 化 | ✅ | `8e7c716` |
| P1.4 | Zip-slip 防護 | ✅ | `5dff398` |
| P1.5 | Service installer template injection | ✅ | `1ba2c16` |
| P1.6 | `project_roots` symlink 繞過 | ✅ | `de67e6d` |
| P1.7 | `confirmPairing` rate-limit 修復 | ✅ | `ee8691a` |
| P1.8 | Branch / tmux 命令注入防護 | ✅ | `c3216ab` |

### P1.1 `/agent` endpoint 身份偽造
- **File**: `src/agent-endpoint.ts`, `src/agent-cli.ts`, `src/fleet-manager.ts`
- **修法**：每 instance 獨立 per-instance token（寫入該 instance tmux env），daemon 以 token 反查 instance，拒絕信任 body 裡的 `instance` 欄位。
- **驗證**：unit test 偽造 `instance` 欄位應回 401/403。
- **風險**：breaking change，影響 agent-cli 協定；需版本 bump 與 upgrade path。

### P1.2 `web.token` 檔案權限 0o600
- **File**: `src/fleet-manager.ts:2116`
- **修法**：`writeFileSync(tokenPath, webToken, { mode: 0o600 })`；啟動時若舊檔權限 > 600 自動 chmod。
- **驗證**：e2e 檢查 `stat -f %Lp` 為 600。

### P1.3 `/ui/*` 與 `/agent` zod 化
- **File**: `src/web-api.ts`
- **修法**：拆 `*PublicArgs`（`.strict()`）vs `*InternalArgs`；web-api 只走 Public；中間件 `parseJsonBody<T>(schema)`。
- **驗證**：未知欄位/錯型別應回 400。

### P1.4 Zip-slip 防護
- **File**: `src/export-import.ts:93`
- **修法**：先 `tar -tzf` 列 entries，檢查 `path.resolve(dataDir, e).startsWith(dataDir+sep)`；加總大小上限 500MB；`--no-absolute-names`。
- **驗證**：惡意 tarball（含 `../../etc/`）應被拒絕。

### P1.5 Service installer template injection
- **File**: `src/service-installer.ts:28-36`、`templates/{launchd.plist,systemd.service}.ejs`
- **修法**：模板 input 前 validate：路徑絕對、無 `\x00-\x1f`、無 `\n`；systemd 欄位改 `<%- %>` + 自訂 escape。
- **驗證**：惡意 `logPath="/tmp/a\nExecStartPost=rm"` 應拒絕。

### P1.6 Symlink 繞過 `project_roots`
- **File**: `src/instance-lifecycle.ts:364-375`
- **修法**：`fs.realpathSync(candidate)` vs `fs.realpathSync(root)` 比對 prefix；root 不存在就拒絕。
- **驗證**：e2e 建立 symlink 測試應拒絕。

### P1.7 `confirmPairing` rate-limit 修復
- **File**: `src/channel/adapters/telegram.ts:670-672`
- **修法**：把 Telegram `ctx.from.id` 傳入 `accessManager.confirmCode(code, String(callerUserId))`。
- **驗證**：同 user 11 次內應被限制。

### P1.8 Branch / tmux 命令注入
- **File**: `src/daemon.ts:1514`、`src/tmux-manager.ts:172-178`
- **修法**：git branch arg 前插 `--` 或 regex 拒絕 `^-`；`pipe-pane` 用 argv 或驗證 `logPath` 子路徑。
- **驗證**：測 `--upload-pack=` / `\n` 注入。

---

## Phase 2 — 可靠性核心

| ID | 項目 | 狀態 | Commit |
|---|---|---|---|
| P2.1 | TmuxControlClient reconnect 清 pane map | ✅ | `e967bbb` |
| P2.2 | Cost guard rotation reset emitted flags | ✅ | `875a0b2` (前次 "pre-existing" 判定錯誤：`trackers.clear()` 只跑在 `resetDaily`，rotation 路徑用 `snapshotAndReset` 不清 emitted flags) |
| P2.3 | Scheduler catch-up 機制 | ✅ | `01e1e32` + `24d6f8a` (review fix) |
| P2.4 | TranscriptMonitor 防重入 | ✅ | `65be144` |
| P2.5 | SSE client 清理 | ✅ | `ae2a810` (前次 "pre-existing" 判定錯誤：原 `req.on("close")` 只清 interval；dead client 寫入 throw 會 break 整個 broadcast loop，且未掛 `req.on("error")` → ECONNRESET 路徑漏清) |
| P2.6 | Topic archiver 持久化 | ✅ | `f134a66` |
| P2.7 | 啟動 waitForIdle 取代 setTimeout | ✅ | `872547b` (前次 "pre-existing" 判定錯誤：`fleet-manager.start():489` 與 `topic-commands.bindAndStart()` 都還有冗餘 `sleep + connectIpcToInstance`；本 commit 為直接刪除而非 `waitForIdle` 替換 — `startInstance` 的 await 鏈已保證 IPC 就緒) |
| P2.8 | msUntilMidnight DST 修復 | ✅ | `3c9ff9f` (前次 "pre-existing" 判定錯誤：`setHours(24,0,0,0)` 是 local-tz 操作，搭配 `toLocaleString` 重解讀，DST 春令日少 1h、秋令日多 1h 都會偏一小時；改用 `Intl.DateTimeFormat` + 二分搜尋找實際換日點) |

詳細修法見原 review 彙整。

---

## Phase 3 — 外部介面治理

| ID | 項目 | 狀態 | Commit |
|---|---|---|---|
| P3.1 | Webhook HMAC + retry 策略 | ✅ | `e65b97c` |
| P3.2 | Telegram 409 polling 上限 | ✅ | `c67f776` |
| P3.3 | Telegram apiRoot 白名單 | ✅ | `9a7b16b` |
| P3.4 | STT 隱私開關（opt-in） | ✅ | `1fc513e` |
| P3.5 | CORS 收緊 + Bearer header | ✅ | `b180232` |
| P3.6 | `/update` 安全化（版本鎖、回滾、二次確認） | ✅ | `740c202` |
| P3.7 | IPC 單行上限 10MB → 1MB | ✅ | `d446384` |
| P3.8 | MessageQueue flood control reset | ✅ | `3474c04` |

---

## Phase 4 — KISS 與測試 hygiene

| ID | 項目 | 狀態 | Commit |
|---|---|---|---|
| P4.1 | 拆檔（daemon.ts / fleet-manager.ts / cli.ts） | ⬜ | fleet-manager 仍 2819 行 |
| P4.2 | `handleToolCall` 路由抽取 | 🟦 部分 | `outboundHandlers` Map + `routeToolCall` 已抽出，但 `daemon.ts:820-1002` 主分流仍是 180 行 if-chain |
| P4.3 | `access-path` 驗證 | ✅ | `d5d41b7` `access-path.ts` 加 `assertSafeInstanceName` 拒 `..`/`/`/`\\`/NUL/empty；topic 模式不受影響 |
| P4.4 | `.env` 權限 + validateTimezone 單一化 | ✅ | `49a4328` scheduler 改 import `config.ts` 的 `validateTimezone`；`quickstart.ts`/`setup-wizard.ts` 寫 `.env` 帶 `mode: 0o600` + chmod 兜底 |
| P4.5 | 小修補集合 | 🟦 部分 | `1f91c3c` `paths.ts` md5 → sha256（避開 FIPS / 掃描器告警，預期會改 custom AGEND_HOME 的 tmux session/socket 後綴一次）；`test-perm-detect.ts` 已確認在 `.gitignore`；logger 仍只在啟動 truncate 一次（長駐 daemon 需排程，暫緩）；cost-guard tiebreaker 規格不明，暫緩 |
| P4.6 | 測試 hygiene | ✅ | e2e 已在 `e2e/tests/`；單元測試使用 `waitFor`；無已知 hygiene 問題 |

---

## 交付規則

- 每 Phase 一個 feature branch；Phase 內每個 P*.x 一個獨立 commit，安全修復必須可獨立 cherry-pick
- 每個 commit 訊息：`fix(scope): 短描述 (P1.x)`
- 每個 commit 附對應測試；遵守 `CLAUDE.md` — 新功能必須 e2e，修 bug 多數可用 unit 覆蓋
- 完成 Phase 後更新本文件進度表與 **Handover**，PR 送 review

---

## Handover — 給下一個 Session

**當前狀態**（最後更新：2026-04-20，audit-followups 三項完成）：

- Phase 1 ✅ 已合回 main（PR #33）
- 當前 worktree：`.worktrees/fix-audit-followups`（branch `fix/audit-followups`，領先 main 3 commits）
- 本輪交付（cross-phase）：
  - `c67f776` P3.2 Telegram 409 polling 上限（30 retries cap + 測試）
  - `f134a66` P2.6 Topic archiver 持久化（`<dataDir>/archived-topics.json` + 4 個測試）
  - `d446384` P3.7 IPC 單行上限 10MB → 1MB（+ overflow 測試）
- 驗證：`npx tsc --noEmit` 綠；`npx vitest run` 411/411 全綠
- 同時於本輪重新驗證 codebase，確認 P2.2 / P2.5 / P2.7 / P2.8 / P4.6 已在過去某時點完成（subagent 初判遺漏，本文件已更新）
- 下一輪建議優先：**P2.1 (pane map)** → **P2.4 (TranscriptMonitor 重入)** → **P2.3 (Scheduler catch-up)** → **P3.5 (CORS + Bearer)** → **P3.3 (apiRoot 白名單)**

---

**更新（2026-04-20，Phase 2 全部完成 + Phase 3 過半）：**

- PR #38 已合（round 2）：
  - `e967bbb` P2.1 TmuxControlClient pane cache reset
  - `65be144` P2.4 TranscriptMonitor 重入鎖
  - `01e1e32` + `24d6f8a` P2.3 Scheduler catch-up
  - `b180232` P3.5 CORS + Bearer
  - `9a7b16b` P3.3 Telegram apiRoot 白名單
- PR #39 開出（round 3，待 review）— 4 commits：`875a0b2` P2.2、`ae2a810` P2.5、`872547b` P2.7、`3c9ff9f` P2.8。`vitest run` 454/454 綠。
- **重要更正**：原表把 P2.2 / P2.5 / P2.7 / P2.8 標為 "pre-existing ✅" 全部是錯的。本輪重新讀程式碼在每一處都找到真實 bug：
  - P2.2 `trackers.clear()` 只跑於 `resetDaily`；rotation 走 `snapshotAndReset`，不清 `warnEmitted/limitEmitted` → 重啟後新 session 會無聲衝過 daily cap。
  - P2.5 `req.on("close")` 只清 interval；`broadcastSseEvent` 對 dead client 寫入 throw 會 break 整個 loop，且未掛 `req.on("error")` → ECONNRESET 漏清 client set。
  - P2.7 `fleet-manager.start():489` 與 `topic-commands.bindAndStart()` 都還有 `setTimeout + 二次 connectIpcToInstance`；`startInstance` 的 await 鏈早已保證 IPC 就緒，純屬冗餘。本輪採刪除而非 `waitForIdle` 替換（KISS）。
  - P2.8 `setHours(24,0,0,0)` 是 local-tz 操作，配合 `toLocaleString` 雙重重解讀，DST 春令日少 1h、秋令日多 1h 都會偏一小時。改用 `Intl.DateTimeFormat` 的 `en-CA` YYYY-MM-DD 觀察 + 二分搜尋找實際換日點，自然處理 23h/24h/25h day length。
- **PR #39 review 追蹤項**（合併前處理）：
  1. P2.7 純刪除無單元測試保護。合併前在乾淨環境跑一次 `agend up` 確認 instances 仍能正確接上 IPC（觀察 `/sysinfo` 顯示 `IPC:✓`）。
  2. SSE 測試的 `FakeClient` 用了 `as unknown as ServerResponse` 型別橋接，非 blocker，未來可抽成共用 mock helper。
- 下一輪建議優先（Phase 3 剩 4 項）：**P3.1 Webhook HMAC** → **P3.4 STT opt-in** → **P3.6 /update 安全化** → **P3.8 MessageQueue flood reset**，然後進 Phase 4。

---

**更新（2026-04-20，Phase 3 全部完成）：**

- PR #40 開出（round 4）— 4 commits 收束 Phase 3 剩餘四項：
  - `e65b97c` P3.1 Webhook HMAC-SHA256 簽章 + 5xx/網路錯誤 retry（4xx 不 retry）+ X-AgEnD-Delivery 冪等 UUID（同一交付重試共用）。新增 `tests/webhook-emitter.test.ts` 7 個測試。
  - `1fc513e` P3.4 STT 隱私 opt-in：原本只要設了 `GROQ_API_KEY` env 就會把語音上傳雲端，現在必須 `fleet.yaml` 顯式 `stt.enabled: true` 且 env 有值才會 download/transcribe。新增 `tests/attachment-handler.test.ts` 6 個測試 + setup-wizard 2 個測試。文件補 `docs/configuration*.md` `stt:` 區塊。
  - `740c202` P3.6 `/update` 安全化：(a) `allowed_users` 為空時整個 `/update` 拒絕；(b) 兩段確認：先 `/update [version]` 註冊 60s 單次有效 6-hex token（只發起者可確認）；(c) 版本鎖定 `npm install -g @suzuke/agend@<ver>`；(d) 安裝後 `agend --version` 健康探針，失敗自動回滾到原版本；(e) `/update cancel` 清待確認。新增 `tests/topic-commands-update.test.ts` 12 個測試。
  - `3474c04` P3.8 MessageQueue flood control 修復：原本 `runWorker` 在 backoff > 10s 後丟掉 status_update，但程式碼只有「已清理，重置 backoff」的死註解、實際沒重置；429 風暴後即使佇列瘦身也仍以 ~30s 重試。改為丟棄後立即把 backoff 重置為 1s 並寫 warn log。
- 驗證：`npx tsc --noEmit` 綠；`npx vitest run` 482/482 全綠。
- Phase 3 全綠，Phase 4 五項待開：P4.1 拆檔（fleet-manager 仍 2819 行）、P4.2 handleToolCall 主分流抽出、P4.3 access-path 驗證、P4.4 .env 權限 + validateTimezone 去重、P4.5 小修補集合。

---

**更新（2026-04-20，Phase 4 round 1：低風險小修）：**

- PR #41 開出（round 1）— 3 commits 收束 Phase 4 中三項較小、可獨立 cherry-pick 的安全/衛生修補：
  - `d5d41b7` P4.3 `access-path.ts` 加 `assertSafeInstanceName` — instance 名做 `^[A-Za-z0-9._-]+$` 白名單，拒 `..`/`/`/`\\`/NUL/empty。topic mode 不變（不嵌 instance）。新增 3 個測試。
  - `49a4328` P4.4 `validateTimezone` 統一 — `scheduler/scheduler.ts` 移除本地副本，改 import `config.ts` 的版本（`(tz, field)` 簽名）；`quickstart.ts` / `setup-wizard.ts` 寫 `.env` 加 `mode: 0o600` + `chmodSync` 兜底（writeFileSync 的 mode 旗在覆寫舊檔時無效）。
  - `1f91c3c` P4.5 `paths.ts:15,27` `createHash("md5")` → `sha256`（取前 6 hex），消除 FIPS / 掃描器告警。**行為改變**：custom AGEND_HOME 的 tmux session/socket 後綴會變一次，daemon 重啟自動同步，孤兒 tmux session 需手動清。預設 AGEND_HOME 不受影響（用字面量 `agend`）。
- 驗證：`npx tsc --noEmit` 綠；`npx vitest run` 486/486 全綠（+4 新測試）。
- 暫緩項：
  - **P4.5 logger rotation** — 現行 `truncateLogIfNeeded` 只在啟動跑一次，長駐 daemon 的 log 仍會無上限增長。需要在 `createLogger` 後排個 `setInterval`（或 hook 到既有 scheduler）週期觸發，屬於小型 feature，留給下一輪。
  - **P4.5 cost-guard tiebreaker** — 規格不明（fix-plan 只說「無 cost-guard tiebreaker」），程式碼也無對應 TODO。需要原作者澄清 tie 是指什麼場景才動。
- 下一輪建議優先：**P4.1 拆檔**（fleet-manager.ts 仍 2819 行，Discord & Telegram 邏輯多處重複，拆出 `instance-lifecycle.ts`/`webhook-router.ts`/`channel-loader.ts` 應可砍 600-800 行）+ **P4.2 handleToolCall 路由表化**（`daemon.ts:820-1002` 180 行 if-chain → 改成 dispatcher map）。兩項都是大型 refactor，建議獨立 PR 各自可 review。

### Phase 1 commits（按時間由新到舊）

```
3d2cdd3 fix(agent): require per-instance token on /agent endpoint (P1.1)
8e7c716 fix(web):   strict zod validation for all /ui/* mutation endpoints (P1.3)
1ba2c16 fix(service): validate template vars to prevent directive injection (P1.5)
5dff398 fix(import): validate tar entries before extraction (P1.4)
de67e6d fix(security): resolve symlinks when enforcing project_roots (P1.6)
c3216ab fix(cmd):     harden branch and logPath against argument injection (P1.8)
ee8691a fix(access):  forward callerUserId from confirmPairing for rate-limit (P1.7)
6efd3a9 fix(web):     set web.token file permission to 0o600 (P1.2)
0a1a935 docs: add fix plan from ultrareview
```

### 接手 Prompt（複製貼上到新 session）

```
我要接手 AgEnD 專案的安全/可靠性修復工作。請先讀 docs/fix-plan.md 了解完整計劃與當前進度。

背景：
- 專案：/Users/suzuke/Documents/Hack/agend
- 計劃文件：docs/fix-plan.md
- Phase 1（安全邊界）已於 2026-04-18 完成，branch：fix/phase-1-security（9 commits），等待 PR / merge
- 下一個 Phase：Phase 2（可靠性核心），從 P2.1 開始

請：
1. 若 Phase 1 還沒合回 main：先讓我確認是否 open PR，再決定要不要等 merge
2. 新開 worktree：git worktree add .worktrees/fix-phase-2 -b fix/phase-2-reliability
3. cd .worktrees/fix-phase-2 && ln -s ../../node_modules node_modules（測試需要）
4. 讀 docs/fix-plan.md 的 Phase 2 區塊，依序從 P2.1 ⬜ 開始
5. 每完成一個 P*.x：
   - npx tsc --noEmit 必綠
   - npx vitest run 必綠（忽略既有的 context-guardian watchFile flake）
   - commit（訊息格式 `fix(scope): 短描述 (P2.x)`）
   - 更新 docs/fix-plan.md 的狀態與 commit hash
6. 完成整個 Phase 後：
   - 更新本文件 Handover 區塊（含下一 Phase 的接手 prompt）
   - 提示我 review & open PR

遵守 CLAUDE.md 規範（KISS、E2E tests only in VM、不直接改 main）。
```
