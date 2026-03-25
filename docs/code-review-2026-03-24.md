> **OBSOLETE** — Most findings reference code deleted in the 2026-03-25 permission relay migration. See `docs/superpowers/specs/2026-03-25-permission-relay-design.md`.

# Code Review Report — claude-channel-daemon

**日期:** 2026-03-24
**審查範圍:** 全部原始碼 (~21,140 行, 105 個 TypeScript 檔案)
**審查方式:** 4 個專業 agent 並行審查 (core daemon, silent failure hunting, channel/approval, supporting systems)

---

## 摘要

| 嚴重程度 | 數量 | 說明 |
|----------|------|------|
| CRITICAL | 7 | 安全漏洞、資料遺失、功能靜默失效 |
| HIGH | 11 | 功能故障、訊息丟失、繞過風險 |
| MEDIUM | 11 | 邏輯錯誤、資源管理、robustness |

系統性問題：全 codebase 有 11+ 處 `.catch(() => {})` 靜默吞掉錯誤，是最需要全面清理的模式。

---

## CRITICAL — 必須修復

### C1. Approval Server 無認證

**檔案:** `src/approval/approval-server.ts:62-106`

HTTP approval endpoint 綁定在 `127.0.0.1` 但完全沒有認證機制。任何本機 process 都可以直接 POST `/approve` 自動核准危險指令：

```bash
curl -X POST http://127.0.0.1:<port>/approve \
  -d '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}'
```

在共用機器或 host networking 的容器環境中，這是直接的安全漏洞。

**修復建議:** 啟動時產生 random token，透過環境變數傳給 hook command，每個 request 驗證 `Authorization: Bearer <token>` header。

---

### C2. `.mcp.json` 解析失敗會覆蓋使用者設定

**檔案:** `src/backend/claude-code.ts:31`

```typescript
try { mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")); } catch {}
```

如果現有的 `.mcp.json` 損壞（非合法 JSON），silent fallback 為空物件再寫回，會**刪除使用者的所有其他 MCP server 設定**。這是資料遺失。

**修復建議:**
- 如果檔案存在但無法解析，throw error 或至少 log warning
- 覆寫前備份原檔

---

### C3. Prompt Detector 外層 catch 吞掉所有錯誤

**檔案:** `src/approval/tmux-prompt-detector.ts:270-272`

```typescript
} catch {
  // File may not exist yet; ignore
}
```

這個 catch block 包住整個 polling interval callback（行 182-272），涵蓋 prompt detection、classification、approval 等所有邏輯。註解只說「File may not exist」，但實際上吞掉了：

- tmux session 斷線
- 檔案系統權限錯誤
- approval function crash
- regex engine 錯誤
- Buffer allocation 失敗 (OOM)

**影響:** 如果 prompt detection 靜默壞掉，Claude 會無限卡在權限提示，使用者完全不知道。

**修復建議:** 縮小 catch 範圍到只 cover file read 部分，其他錯誤應該 log 出來。

---

### C4. `sendApproval` 失敗被靜默吞掉

**檔案:** `src/channel/message-bus.ts:68`

```typescript
adapter.sendApproval(prompt, (decision) => {
  // ...
}, controller.signal).then(handle => handles.push(handle)).catch(() => {});
```

如果 Telegram API 錯誤導致 approval 訊息發不出去，使用者永遠看不到核准請求。系統會等 120 秒 timeout 後 default deny。使用者經歷的是：Claude 莫名延遲 2 分鐘然後工具被拒。

**修復建議:** log error，如果所有 adapter 都失敗，立即 resolve 並回傳明確錯誤訊息。

---

### C5. Docker 掛載 `~/.claude` 為 Read-Write

**檔案:** `src/container-manager.ts:46`

```typescript
args.push("-v", `${home}/.claude:${home}/.claude`);
```

`~/.claude` 目錄包含 API keys、credentials、session tokens，以 read-write 掛載進 sandbox container。container 內的程式碼可以讀取、修改或竊取 credentials。

**修復建議:** 改為 `:ro` 掛載：

```typescript
args.push("-v", `${home}/.claude:${home}/.claude:ro`);
```

---

### C6. `extra_mounts` 無驗證可掛載任意 Host 路徑

**檔案:** `src/container-manager.ts:54-56`

`extraMounts` 從 YAML 設定直接傳給 Docker `-v`，無任何驗證。惡意或錯誤的 `fleet.yaml` 可以掛載 `/`、`/etc/shadow` 或任何敏感路徑。

**修復建議:** 驗證 mount 路徑必須在 project roots 或 home 目錄下：

```typescript
for (const mount of opts.extraMounts) {
  const hostPath = mount.split(":")[0];
  if (!opts.projectRoots.some(r => hostPath.startsWith(r)) && !hostPath.startsWith(home)) {
    throw new Error(`Extra mount "${mount}" is outside allowed directories`);
  }
  args.push("-v", mount);
}
```

---

### C7. tmux `pipe-pane` Shell Injection

**檔案:** `src/tmux-manager.ts:77`

```typescript
`cat >> "${logPath}"`
```

`logPath` 用雙引號嵌入 shell 指令，特殊字元（`$`、反引號、`\`）會被 shell 解釋。如果 `instanceDir` 包含 `$(...)` 序列，會執行任意指令。

**修復建議:** 使用單引號並 escape：

```typescript
const escaped = logPath.replace(/'/g, "'\\''");
`cat >> '${escaped}'`
```

---

## HIGH — 強烈建議修復

### H1. `.env` Parser 不 Strip 引號

**檔案:** `src/fleet-manager.ts:154-168`

常見的 `.env` 格式如 `BOT_TOKEN="abc123"` 會將值設為 `"abc123"`（包含字面引號），導致 Telegram API 認證靜默失敗。

**修復建議:**

```typescript
const value = trimmed.slice(eqIdx + 1).replace(/^["'](.*)["']$/, '$1');
```

---

### H2. `currentOpenSession` 是單一 Slot — 並發覆蓋

**檔案:** `src/fleet-manager.ts:422-423, 941-945`

`currentOpenSession` 只儲存一個 active `/open` session。兩個使用者同時 `/open` 會互相覆蓋，第一個使用者的 inline keyboard 點擊後 `sessionId` 不匹配被靜默拒絕。

**修復建議:** 改用 `Map<string, { paths: string[] }>` keyed by `sessionId`，加 TTL 清理。

---

### H3. `fleet stop` 不發 SIGTERM — 實際上不停止任何東西

**檔案:** `src/cli.ts:196-205`

`fleet stop` 建立新的 FleetManager 呼叫 `stopAll()`，但 `this.daemons` 是空的（新 instance）。唯一有用的是移除 PID 檔案。對比單一 instance 的 `stop` 有讀 PID 發 SIGTERM。

**修復建議:** 讀取 `fleet.pid` 並發 SIGTERM，與單一 instance `stop` 行為一致。

---

### H4. `getContextUsage()` 錯誤回傳 0 — 停用 Context Rotation

**檔案:** `src/backend/claude-code.ts:77-84`

```typescript
getContextUsage(): number {
  try {
    const sf = join(this.instanceDir, "statusline.json");
    const data = JSON.parse(readFileSync(sf, "utf-8"));
    return data.context_window?.used_percentage ?? 0;
  } catch {
    return 0;
  }
}
```

任何讀取錯誤都回傳 0%，ContextGuardian 永遠認為 context 充裕，**靜默停用 context rotation**。Claude 會跑到硬限制才 crash。

**修復建議:** 回傳 `null` 表示未知，ContextGuardian 應處理 null case（例如連續 N 次 null 觸發 warning）。

---

### H5. IPC JSON Parse + Handler 共用 Catch

**檔案:** `src/channel/ipc-bridge.ts:24-27`

```typescript
try {
  onMessage(JSON.parse(line));
} catch {
  // Ignore malformed lines
}
```

`JSON.parse` 和 `onMessage` 共用同一個 catch。Handler 內的任何 exception 都被當成「malformed JSON」靜默丟棄。

**修復建議:** 分開處理：

```typescript
let msg;
try { msg = JSON.parse(line); } catch { return; /* truly malformed */ }
onMessage(msg); // let handler errors propagate
```

---

### H6. MessageQueue 靜默丟棄非 429 錯誤的訊息

**檔案:** `src/channel/message-queue.ts:150-155`

```typescript
} else {
  // Non-rate-limit error: drop the item to avoid infinite loops
  state.backoffMs = INITIAL_BACKOFF_MS;
  state.backoffUntil = 0;
  await this.sleep(WORKER_BETWEEN_MS);
}
```

400、403、network error 等非 rate-limit 錯誤，訊息直接被丟棄，無任何日誌。使用者的訊息無聲消失。

**修復建議:** 加 error callback 或 event emitter 通知失敗。

---

### H7. IPC Socket Error 只移除 Client 無 Log

**檔案:** `src/channel/ipc-bridge.ts:62-64`

```typescript
socket.on("error", () => {
  this.clients.delete(socket);
});
```

如果 MCP server 的 IPC 連線因錯誤斷開，daemon 靜默失去與 Claude 的通訊能力。後續所有 `broadcast()` 發到 0 個 client。

**修復建議:** log error，考慮 reconnect 機制。

---

### H8. Dangerous Command Regex 易被繞過

**檔案:** `src/approval/approval-server.ts:5-21`

`DANGER_PATTERNS` 用簡單 regex 如 `\brm\b`，可被輕易繞過：

- `$(echo rm)` — command substitution
- `/bin/rm` — full path
- `command rm` — builtin
- `r\m` — backslash escape

**修復建議:** 考慮 allowlist 方式（只自動放行已知安全指令）而非 blocklist。

---

### H9. Event Listener Leak — Tool Call Handler

**檔案:** `src/daemon.ts:488-526`

每個 tool call 在 `this.ipcServer` 上註冊新的 `"message"` listener。並發 burst 會觸發 `MaxListenersExceededWarning`，效能退化。

**修復建議:** 使用 `Map<requestId, resolver>` 模式取代 add/remove listener。

---

### H10. `logs --follow` 不會 Follow

**檔案:** `src/cli.ts:116-128`

`createReadStream` 讀到 EOF 就結束，`process.stdin.resume()` 只是保持 process alive。不是 `tail -f` 行為。

**修復建議:** 使用 `fs.watch` 或 `chokidar` 偵測新資料，或 spawn `tail -f`。

---

### H11. Pairing Code 無 Rate Limiting

**檔案:** `src/channel/access-manager.ts:100, 111-131`

6 hex = 24 bits ≈ 16.7M 種可能。`attempts` 欄位在 `PendingCode` 型別中存在但從未使用。

**修復建議:** 在 `confirmCode` 中遞增並檢查 `attempts`，超過 5 次失敗加 cooldown。

---

## MEDIUM — 建議改善

### M1. Scheduler `update()` Null Dereference

**檔案:** `src/scheduler/db.ts:101`

`this.get(id)!` 使用 non-null assertion，如果 id 不存在會在下游產生 uncaught runtime error。

**修復:** 加 existence check，不存在時 throw explicit error。

---

### M2. Docker 無 Resource Limits

**檔案:** `src/container-manager.ts:33-58`

Container 啟動時沒有 `--memory` 或 `--cpus` 限制。runaway process 可消耗所有 host 資源。

**修復:** 加 `--memory 4g --cpus 2` 或透過 `SandboxConfig` 設定。

---

### M3. Docker 無 Network Isolation

**檔案:** `src/container-manager.ts:33-58`

Container 有 `--add-host host.docker.internal:host-gateway` 但無網路限制。Sandbox 內的程式碼有完整 network access 並可透過 `host.docker.internal` 存取 host。

**修復:** 考慮 `--network none` 或自訂 network。

---

### M4. `ensureRunning` TOCTOU Race Condition

**檔案:** `src/container-manager.ts:29-61`

`isRunning()` 和 `docker run` 之間另一個 process 可能已啟動 container，造成 "name already in use" 錯誤。

**修復:** Catch "name already in use" error，再次檢查 `isRunning()`。

---

### M5. ContextGuardian Idle Timeout 不清除 `rotationReason`

**檔案:** `src/context-guardian.ts:119-122`

Timeout 後 `state` 重設為 `NORMAL` 但 `rotationReason` 未清除，可能導致下次 rotation 報告錯誤原因。

**修復:** 加 `this.rotationReason = null;`

---

### M6. `memory_backups` Table 無 Pruning

**檔案:** `src/db.ts`

不像 `schedule_runs` 有 `pruneOldRuns()`，`memory_backups` 會無限增長。

**修復:** 加 pruning method，保留每個 file 最近 N 筆。

---

### M7. `TranscriptMonitor.setTranscriptPath` 不 Reset `byteOffset`

**檔案:** `src/transcript-monitor.ts:134-136`

換路徑後 offset 不重設，新檔案會從舊 offset 讀取，跳過或讀不到資料。

**修復:** path 改變時重設 `byteOffset = 0`。

---

### M8. Config YAML 無 Runtime Type Validation

**檔案:** `src/config.ts:65-75`

```typescript
const parsed = yaml.load(raw) as Partial<DaemonConfig> | null;
```

YAML cast 為型別但無 runtime 驗證。錯誤型別（如 `threshold_percentage: "high"`）會靜默傳播。

**修復:** 使用 zod 或手動檢查關鍵數值欄位。

---

### M9. `postLaunch` Shell Prompt Detection 太寬鬆

**檔案:** `src/backend/claude-code.ts:113-115`

```typescript
if (pane.includes("$") || pane.includes("%") || pane.includes(">")) {
  return;
}
```

`$`、`%`、`>` 在正常 Claude Code 輸出中頻繁出現，會導致 `postLaunch` 過早 return。

**修復:** 只檢查 pane 最後一行是否匹配 shell prompt pattern。

---

### M10. `stopAll` Shutdown 順序錯誤

**檔案:** `src/fleet-manager.ts:1156-1182`

先停 adapter → 關 IPC → 停 daemon。但 daemon `stop()` 可能要透過 adapter/IPC 發最後訊息。

**修復:** 順序改為：停 daemon → 關 IPC → 停 adapter。

---

### M11. `Promise.allSettled` 在 MessageBus.send 隱藏個別失敗

**檔案:** `src/channel/message-bus.ts:24-26`

發送到所有 adapter 時個別失敗被靜默忽略，caller 無法知道哪些 adapter 失敗。

**修復:** 檢查 `allSettled` 結果，log rejected entries。

---

## 系統性問題

### 1. `.catch(() => {})` 模式 (11+ 處)

這是 codebase 中最危險的模式，分布在：

- `daemon.ts` — tool status 發送 (2處)
- `fleet-manager.ts` — tool status 轉發、cleanup notification (3處)
- `message-bus.ts` — sendApproval (1處)
- 其他零散位置

**建議:** 全面搜尋 `.catch(() => {})` 和 `} catch {}`，至少改為 `.catch(e => log.warn(e))`。

### 2. 過寬的 Catch Block

幾乎每個 `catch` block 都 catch `unknown` 且統一處理。註解常描述一種預期錯誤（「file may not exist」），但實際吞掉數十種非預期錯誤。

**建議:** 縮小 catch 範圍，對非預期錯誤至少 log warning。

### 3. Fallback-to-Default 隱藏真實問題

- `getContextUsage()` 回傳 0 → context rotation 停用
- `getSessionId()` 回傳 null → session resume 失效
- `loadToolAllowlist()` 回傳 `[]` → 已核准工具全部遺失

這些 fallback 看似安全，實際上靜默停用了安全功能。

---

## 做得好的部分

1. **全部使用 `execFile` 而非 `exec`** — 防止大多數 shell injection vector
2. **SQL 全部使用 parameterized queries** — 無 SQL injection
3. **分層架構清晰** — daemon / fleet / channel / backend 關注點分離良好
4. **TypeScript 型別使用得當** — 核心 interface 設計合理
5. **Context rotation 機制** — 概念完善，state machine 設計良好
6. **Approval workflow 設計** — 架構正確，只需加固實作

---

## 建議修復優先順序

1. **C1 + H8** — Approval server 認證 + dangerous command regex（安全）
2. **C2** — `.mcp.json` 覆寫保護（資料遺失）
3. **C5 + C6** — Docker mount 安全（sandbox 邊界）
4. **全面清理 `.catch(() => {})`** — 系統性改善（可觀測性）
5. **C3 + C4** — Prompt detector + sendApproval 錯誤處理（可靠性）
6. **H3 + H4** — fleet stop + getContextUsage（功能正確性）
7. 其餘 HIGH 和 MEDIUM 依需求排序
