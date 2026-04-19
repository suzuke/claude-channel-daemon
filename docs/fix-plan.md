# AgEnD 修正計劃

基於 2026-04-18 ultrareview 的整體 codebase 審查，四階段修復計劃。

**狀態圖例**：⬜ 未開始　🟦 進行中　✅ 完成　⏭️ 略過／推遲

---

## 進度總覽

| Phase | 範圍 | 狀態 | 分支 |
|---|---|---|---|
| Phase 1 | 安全邊界 | ✅ 完成 | `fix/phase-1-security` |
| Phase 2 | 可靠性核心 | ⬜ | - |
| Phase 3 | 外部介面治理 | ⬜ | - |
| Phase 4 | KISS 與測試 hygiene | ⬜ | - |

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

| ID | 項目 | 狀態 |
|---|---|---|
| P2.1 | TmuxControlClient reconnect 清 pane map | ⬜ |
| P2.2 | Cost guard rotation reset emitted flags | ⬜ |
| P2.3 | Scheduler catch-up 機制 | ⬜ |
| P2.4 | TranscriptMonitor 防重入 | ⬜ |
| P2.5 | SSE client 清理 | ⬜ |
| P2.6 | Topic archiver 持久化 | ⬜ |
| P2.7 | 啟動 waitForIdle 取代 setTimeout | ⬜ |
| P2.8 | msUntilMidnight DST 修復 | ⬜ |

詳細修法見原 review 彙整。

---

## Phase 3 — 外部介面治理

| ID | 項目 | 狀態 |
|---|---|---|
| P3.1 | Webhook HMAC + retry 策略 | ⬜ |
| P3.2 | Telegram 409 polling 上限 | ⬜ |
| P3.3 | Telegram apiRoot 白名單 | ⬜ |
| P3.4 | STT 隱私開關（opt-in） | ⬜ |
| P3.5 | CORS 收緊 + Bearer header | ⬜ |
| P3.6 | `/update` 安全化（版本鎖、回滾、二次確認） | ⬜ |
| P3.7 | IPC 單行上限 10MB → 1MB | ⬜ |
| P3.8 | MessageQueue flood control reset | ⬜ |

---

## Phase 4 — KISS 與測試 hygiene

| ID | 項目 | 狀態 |
|---|---|---|
| P4.1 | 拆檔（daemon.ts / fleet-manager.ts / cli.ts） | ⬜ |
| P4.2 | `handleToolCall` 路由抽取 | ⬜ |
| P4.3 | `access-path` 驗證 | ⬜ |
| P4.4 | `.env` 權限 + docs 同步 + validateTimezone 單一化 | ⬜ |
| P4.5 | 小修補集合（cost-guard tiebreaker / logger rotation / MD5→SHA1 / sleep→setTimeout / FNV pane hash / 根目錄清理 / deprecated getter 遷移） | ⬜ |
| P4.6 | 測試 hygiene（搬 e2e / 改 waitFor / 強 assert / 補覆蓋） | ⬜ |

---

## 交付規則

- 每 Phase 一個 feature branch；Phase 內每個 P*.x 一個獨立 commit，安全修復必須可獨立 cherry-pick
- 每個 commit 訊息：`fix(scope): 短描述 (P1.x)`
- 每個 commit 附對應測試；遵守 `CLAUDE.md` — 新功能必須 e2e，修 bug 多數可用 unit 覆蓋
- 完成 Phase 後更新本文件進度表與 **Handover**，PR 送 review

---

## Handover — 給下一個 Session

**當前狀態**（最後更新：2026-04-18，Phase 1 完成）：

- 當前 worktree：`.worktrees/fix-phase-1`（branch `fix/phase-1-security`，領先 main 9 commits）
- Phase 1 ✅ 完成：P1.1–P1.8 全部 commit；`npx tsc --noEmit` 綠、`npx vitest run` 404/405（唯一 fail 為 `tests/context-guardian.test.ts` 的 watchFile 計時 flake，單跑通過，與本 Phase 改動無關）
- 下一個 Phase：Phase 2（可靠性核心）— 開新 worktree `fix/phase-2-reliability`，從 P2.1 TmuxControlClient reconnect 清 pane map 開始
- 待人工確認：Phase 1 需 review / open PR 合回 main；Phase 2 應從合回後的 main 分支出

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
