> **OBSOLETE** — References code deleted in the 2026-03-25 permission relay migration.

# Code Review 驗證報告

**原始文件:** `docs/code-review-2026-03-24.md`
**驗證日期:** 2026-03-24
**驗證方式:** 逐條比對原始碼，檢查檔案路徑、行號、程式碼片段、問題描述

---

## Codebase 統計

| 宣稱 | 實際值 | 判定 |
|------|--------|------|
| ~21,140 行 | 6,980 行 (src/*.ts) | **不實 — 膨脹 3 倍** |
| 105 個 TypeScript 檔案 | 39 個 (src/*.ts) | **不實 — 膨脹 2.7 倍** |

可能原因：計入了 node_modules、build output、或 test fixtures。無論如何，數字與 src/ 實際內容不符。

---

## CRITICAL (7/7 真)

### C1. Approval Server 無認證 — 真

- **引用:** `src/approval/approval-server.ts:62-106`
- **實際行號:** `:60-104` (偏差 2 行)
- **驗證:** HTTP server 在 `createServer` callback 中直接處理 POST `/approve`，無任何 token 或認證檢查。綁定 `127.0.0.1`。

### C2. `.mcp.json` 解析失敗覆蓋設定 — 真

- **引用:** `src/backend/claude-code.ts:31`
- **實際行號:** `:31` (完全吻合)
- **驗證:** `try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch {}` — 解析失敗時 fallback 為空物件，後續 `writeFileSync` 會覆蓋原檔。

### C3. Prompt Detector 外層 catch 吞掉所有錯誤 — 真

- **引用:** `src/approval/tmux-prompt-detector.ts:270-272`
- **實際行號:** `:270-272` (完全吻合)
- **驗證:** `} catch { // File may not exist yet; ignore }` 包住整個 `setInterval` callback body。

### C4. `sendApproval` 失敗被靜默吞掉 — 真

- **引用:** `src/channel/message-bus.ts:68`
- **實際行號:** `:68` (完全吻合)
- **驗證:** `.then(handle => handles.push(handle)).catch(() => {})` — 完全吻合文件引用的程式碼。

### C5. Docker 掛載 `~/.claude` 為 Read-Write — 真

- **引用:** `src/container-manager.ts:46`
- **實際行號:** `:46` (完全吻合)
- **驗證:** `args.push("-v", \`${home}/.claude:${home}/.claude\`)` — 無 `:ro` flag。

### C6. `extra_mounts` 無驗證 — 真

- **引用:** `src/container-manager.ts:54-56`
- **實際行號:** `:54-56` (完全吻合)
- **驗證:** `for (const mount of opts.extraMounts) { args.push("-v", mount); }` — 直接傳入，無路徑驗證。

### C7. tmux `pipe-pane` Shell Injection — 真

- **引用:** `src/tmux-manager.ts:77`
- **實際行號:** `:77` (完全吻合)
- **驗證:** `` `cat >> "${logPath}"` `` — 使用雙引號嵌入 shell 指令，`$` 和反引號會被解釋。

---

## HIGH (9/11 完全真, 2/11 部分真)

### H1. `.env` Parser 不 Strip 引號 — 真

- **引用:** `src/fleet-manager.ts:154-168`
- **實際行號:** `:153-168` (偏差 1 行)
- **驗證:** `const value = trimmed.slice(eqIdx + 1);` — 無引號處理。`BOT_TOKEN="abc"` 會把 `"abc"` (含引號) 設為值。

### H2. `currentOpenSession` 單一 Slot — 真

- **引用:** `src/fleet-manager.ts:422-423, 941-945`
- **實際行號:** `:422-423, 941-944` (偏差 1 行)
- **驗證:** `this.currentOpenSession = { id: sessionId, paths: dirs };` 每次 `/open` 覆蓋。`confirmCode` 時比對 `sessionId` 不匹配即拒絕。

### H3. `fleet stop` 不發 SIGTERM — 部分真

- **引用:** `src/cli.ts:196-205`
- **實際行號:** `:196-205` (完全吻合)
- **驗證:** `fleet stop` 建立新 FleetManager 呼叫 `stopAll()`，`this.daemons` 確實是空的。但文件**忽略了** `stopInstance()` 中的 PID file fallback (`fleet-manager.ts:145-150`)：`const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10); try { process.kill(pid, "SIGTERM"); } catch {}`。所以不帶 instance 名稱的 `fleet stop` 確實不會停任何東西（因為 `this.daemons` 是空 Map，`Promise.allSettled` iterate 零個 key），但帶 instance 名稱時有 SIGTERM。

### H4. `getContextUsage()` 錯誤回傳 0 — 真

- **引用:** `src/backend/claude-code.ts:77-84`
- **實際行號:** `:77-84` (完全吻合)
- **驗證:** `catch { return 0; }` — 任何錯誤都回傳 0%。

### H5. IPC JSON Parse + Handler 共用 Catch — 真

- **引用:** `src/channel/ipc-bridge.ts:24-27`
- **實際行號:** `:23-27` (偏差 1 行)
- **驗證:** `try { onMessage(JSON.parse(line)); } catch { // Ignore malformed lines }` — parse 和 handler 共用 catch。

### H6. MessageQueue 靜默丟棄非 429 錯誤 — 真

- **引用:** `src/channel/message-queue.ts:150-155`
- **實際行號:** `:150-155` (完全吻合)
- **驗證:** `else { // Non-rate-limit error: drop the item to avoid infinite loops` — 無 log，直接丟棄。

### H7. IPC Socket Error 只移除 Client 無 Log — 真

- **引用:** `src/channel/ipc-bridge.ts:62-64`
- **實際行號:** `:62-64` (完全吻合)
- **驗證:** `socket.on("error", () => { this.clients.delete(socket); })` — 無 log。

### H8. Dangerous Command Regex 易被繞過 — 真

- **引用:** `src/approval/approval-server.ts:5-21`
- **實際行號:** `:5-21` (完全吻合)
- **驗證:** 確實只用 `\brm\b` 等簡單 regex。文件列舉的繞過方式 (`$(echo rm)`, `/bin/rm` 等) 合理。

### H9. Event Listener Leak — 部分真

- **引用:** `src/daemon.ts:488-526`
- **實際行號:** `:487-526` (偏差 1 行)
- **驗證:** 每次 tool call 確實用 `this.ipcServer?.on("message", onResponse)` 註冊新 listener，但**有 `cleanup()` 函式**在收到回應或 timeout 時呼叫 `removeListener`。文件宣稱「每個 tool call 註冊新 listener」是真的，但有 cleanup 機制。問題存在於**並發 burst 時**多個 listener 短暫同時存在，可能觸發 `MaxListenersExceededWarning`，這點描述合理。

### H10. `logs --follow` 不會 Follow — 真

- **引用:** `src/cli.ts:116-128`
- **實際行號:** `:116-128` (完全吻合)
- **驗證:** `createReadStream(LOG_PATH, { start: 0 })` 讀到 EOF 即停。`process.stdin.resume()` 只防止 process 退出，不會讀取新資料。

### H11. Pairing Code 無 Rate Limiting — 真

- **引用:** `src/channel/access-manager.ts:100, 111-131`
- **實際行號:** `:100, 111-131` (完全吻合)
- **驗證:** `attempts: 0` 在 `generateCode()` (`:105`) 初始化，但 `confirmCode()` (`:111-131`) 完全未檢查或遞增 `attempts`。6 hex chars = 16,777,216 種可能，無任何 brute-force 防護。

---

## MEDIUM (11/11 真)

### M1. Scheduler `update()` Null Dereference — 真

- **引用:** `src/scheduler/db.ts:101`
- **實際行號:** `:101` (完全吻合)
- **驗證:** `return this.get(id)!;` — non-null assertion，`id` 不存在時回傳 `undefined` 被 assert 為非 null。

### M2. Docker 無 Resource Limits — 真

- **引用:** `src/container-manager.ts:33-58`
- **實際行號:** `:33-58` (吻合)
- **驗證:** `docker run` 參數中無 `--memory` 或 `--cpus`。

### M3. Docker 無 Network Isolation — 真

- **引用:** `src/container-manager.ts:33-58`
- **實際行號:** `:33-58` (吻合)
- **驗證:** 有 `--add-host host.docker.internal:host-gateway`，無 `--network none` 或自訂 network。

### M4. `ensureRunning` TOCTOU Race Condition — 真

- **引用:** `src/container-manager.ts:29-61`
- **實際行號:** `:30-60` (偏差 1 行)
- **驗證:** `if (await this.isRunning()) return;` 後直接 `docker run`，無 "name already in use" error handling。

### M5. ContextGuardian Idle Timeout 不清除 `rotationReason` — 真

- **引用:** `src/context-guardian.ts:119-122`
- **實際行號:** `:119-122` (完全吻合)
- **驗證:** `this.state = "NORMAL";` 但無 `this.rotationReason = null`。

### M6. `memory_backups` Table 無 Pruning — 真

- **引用:** `src/db.ts`
- **驗證:** `memory_backups` table 在 `:11` 定義，只有 `insertBackup`、`getAll`、`getByFilePath` 方法。`schedule_runs` 有 `pruneOldRuns()` (`scheduler/db.ts:122`)，`memory_backups` 沒有對應機制。

### M7. `setTranscriptPath` 不 Reset `byteOffset` — 真

- **引用:** `src/transcript-monitor.ts:134-136`
- **實際行號:** `:134-136` (完全吻合)
- **驗證:** `setTranscriptPath(path: string): void { this.transcriptPath = path; }` — 只設 path，未重設 offset。另有獨立的 `resetOffset()` 方法 (`:138`)，但 `setTranscriptPath` 未呼叫它。

### M8. Config YAML 無 Runtime Type Validation — 真

- **引用:** `src/config.ts:65-75`
- **實際行號:** `:65-74` (偏差 1 行)
- **驗證:** `const parsed = yaml.load(raw) as Partial<DaemonConfig> | null;` — 純 type assertion，無 runtime 驗證。

### M9. `postLaunch` Shell Prompt Detection 太寬鬆 — 真

- **引用:** `src/backend/claude-code.ts:113-115`
- **實際行號:** `:113-115` (完全吻合)
- **驗證:** `if (pane.includes("$") || pane.includes("%") || pane.includes(">"))` — 檢查整個 pane 內容而非最後一行。

### M10. `stopAll` Shutdown 順序錯誤 — 真

- **引用:** `src/fleet-manager.ts:1156-1182`
- **實際行號:** `:1156-1182` (完全吻合)
- **驗證:** 實際順序為 scheduler → PID → adapter.stop() → IPC close → daemons stop。Daemon 的 `stop()` 在 adapter 和 IPC 都關閉之後才執行。

### M11. `Promise.allSettled` 隱藏個別失敗 — 真

- **引用:** `src/channel/message-bus.ts:24-26`
- **實際行號:** `:24-26` (完全吻合)
- **驗證:** `await Promise.allSettled(...)` 的回傳值未被檢查，rejected entries 靜默忽略。

---

## 系統性問題

### `.catch(() => {})` / `} catch {}` 模式

- **文件宣稱:** 11+ 處
- **實際:** grep 找到 **23 處**在 `src/` 下
- **判定:** **真，且實際數量比宣稱更多**
- **分布確認:**
  - `daemon.ts` — 2 處 (`:333`, `:420-422`)
  - `fleet-manager.ts` — 7 處 (`:149`, `:532`, `:548`, `:739`, `:745`, `:993`, `:1073`, `:1144`, `:1167`)
  - `message-bus.ts` — 1 處 (`:68`)
  - `cli.ts` — 2 處 (`:176`, `:187`)
  - `telegram.ts` — 1 處 (`:404`)
  - `claude-code.ts` — 3 處 (`:31`, `:116`, `:135`)
  - `transcript-monitor.ts` — 2 處 (`:49`, `:88`)
  - `tmux-manager.ts` — 2 處 (`:28`, `:55`)

### Fallback-to-Default 隱藏問題 (3 例)

| 函式 | 位置 | Fallback 值 | 驗證 |
|------|------|-------------|------|
| `getContextUsage()` | `claude-code.ts:82-83` | `return 0` | **真** |
| `getSessionId()` | `claude-code.ts:87` (interface `backend/types.ts:32`) | `return null` | **真** |
| `loadToolAllowlist()` | `tmux-prompt-detector.ts:121-128` | `return []` | **真** |

---

## 正面評價驗證

| 宣稱 | 驗證 | 判定 |
|------|------|------|
| 全部使用 `execFile` 而非 `exec` | `tmux-manager.ts:1` import `execFile`，`container-manager.ts:1` import `execFile`，`fleet-manager.ts:528` import `execFile`。所有 shell 指令都透過 `execFile` 包裝，未使用 `child_process.exec` | **真** |
| SQL 全部 parameterized | `scheduler/db.ts` 所有查詢使用 `.prepare()` + `?` 參數。`db.ts` 同樣 | **真** |

---

## 總結

| 類別 | 完全真 | 部分真 | 不實 | 總計 |
|------|--------|--------|------|------|
| Codebase 統計 | 0 | 0 | **2** | 2 |
| CRITICAL | **7** | 0 | 0 | 7 |
| HIGH | **9** | **2** | 0 | 11 |
| MEDIUM | **11** | 0 | 0 | 11 |
| 系統性問題 | **3** | 0 | 0 | 3 |
| 正面評價 | **2** | 0 | 0 | 2 |
| **合計** | **32** | **2** | **2** | **36** |

**技術發現可信度：97%** — 所有 29 條具體 bug 報告中，27 條完全真實、2 條部分真實、0 條不實。行號精確度極高（平均偏差 < 1 行）。

**唯一不實項目是開頭的 codebase 統計數字**，宣稱 21,140 行 / 105 檔，實際 src/ 下只有 6,980 行 / 39 檔。
