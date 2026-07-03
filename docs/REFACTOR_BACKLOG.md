# 重构 Backlog

本文件记录已识别但未实施的代码改造批次。完整审计见 `/Users/kong/.claude/plans/unified-watching-moth.md`。

## 已完成

| 批次 | 主题 | 提交 |
|---|---|---|
| B1 | shared 公共 helper（parse/mention/json-codec/time 收口） | `2cbc866` |
| B3 | master/util/paths.ts + master/util/fs.ts 收口 validateWorkingDir + walkDir | `c329ad2` |
| B2 | db/build-update.ts + issues 表 updated_at 统一 nowBeijing() | `de1abe5` |
| B8 | cli/routes.ts（route/qs/usage/masterFetch）+ init/join 收口 | `7e9a79a` |
| B10 | executor + CLI 日志统一到 shared/logger（stream 选项） | `e6422c8` |
| B4-1 | 拆 shared/protocol.ts → protocol/{enums,types,client-messages,server-messages,guards}.ts（barrel 保留） | （本批） |
| B4-2 | ws-hub/connection.ts 抽 resolveReplyContext helper（部分） | （本批） |
| B7 | db/internal.ts mixin 改造（256 行 declare → interface 声明合并，84 行） | （本批） |
| B9 | api/groups.ts patrol bootstrap + api/issues.ts extract-memory prompt 下沉 service | （本批） |

## 待实施

### B5 — executor 抽 BaseCliExecutor + Transport + 共享组件

**当前问题**：5 个 executor（claude-code/codex/hermes-cli/openclaw/pi）各自重造 6 类基础设施。

**证据**（file:line 见审计报告）：
- `killedByUser`/`timedOut` 双布尔 ×5 处（`openclaw.ts:109-117`、`pi.ts:314-328` 字节级一致）
- `TokenUsage` 映射字面量重复 7 次（claude-code ×2、openclaw ×2、hermes、codex、pi）
- 流式文本合并器 3 套（hermes 500ms flushTimer、pi PiTextBuffer 类、claude-code 手卷 stdoutBuffer）
- `emitStatus` 调用密度 45 次（claude-code 14、hermes 11、openclaw 8、pi 6、codex 6）；hermes 自加 `emitStatusDedup` 包装 — 抽象泄漏
- approval gate 三套机制（codex/hermes JSON-RPC respond、claude-code Unix socket + settings.json + hook 旁路 120 行）
- NDJSON 行解析 try/catch warn 重复 4 处；claude-code 手卷 `stdoutBuffer += data; lastIndexOf("\n")` 而 jsonrpc-transport 已用 readline
- transports 双轨（JSON-RPC 2.0 vs NDJSON/streaming-event-blob），无 `Transport` 接口隐藏
- `index.ts:102-120` 硬编码 `switch (cliTool)` — 加 executor 改三处

**改造方案**：
1. `BaseCliExecutor` 抽象类承载 `runProcess` 装配、`exitReason: "exit" | "user" | "timeout"` 跟踪、`emitStatusDedup`、`mapAnthropicUsage` / `mapCodexUsage` / `mapPiUsage`、`parseNdjsonLine`
2. 抽 `createTextCoalescer(windowMs)` 共享类（hermes/pi/claude-code 共用）
3. 抽 `createApprovalBridge(transport, onApprovalRequest)` 共享决策归一器
4. 抽 `Transport` 接口（`send/notif/onNotification`），jsonrpc 与 ndjson 两实现
5. `index.ts` 改注册表驱动（`Map<cliTool, ExecutorFactory>`）

**预期收益**：5 个 executor 各省 ~150 行重复；新增 CLI 后端只需实现 `handleRecord` 而非重造生命周期。

**风险**：中-高。executor 改动需逐个回归（5 种 cliTool × issue/chat × status/usage/approval/中断）。

**验证**：每个 executor 单独验证 + 端到端冒烟。

---

### B6 — worker.ts 拆 Messenger / TaskRegistry + worktree 回位

**当前问题**：`executor/worker.ts` 958 行单类承担 5 类职责（WS 路由 / worktree 生命周期 / issue 编排 / chat 编排 / 发送胶水），handler ↔ worker reach-through 严重。

**证据**：
- WS 消息路由：14-branch if-chain（`worker.ts:430-643`），无 dispatch 表
- worktree/repo-CWD 生命周期 165 行（`worker.ts:232-397`），应属 `repo-cache.ts`
- issue-header prompt 组装重复 3 处：`worker.ts:685-690`、`worker.ts:720-725`、`worker-issue.ts:47-52` 同字面量
- `handleIssueRepoMsg`（`worker.ts:651-746`）三分支各自解构同一组 12 字段 ×3，body 80% 重叠
- 发送类方法（`worker.ts:835-957`）120 行 WS 胶水，被 `worker-issue.ts`/`worker-chat.ts` 通过 `this.worker.*` 反向调用
- usage 累加器（`worker.ts:130-135, 868-930`）60+ 行 throttle 仅由 `worker-issue.ts:157-162` 调用
- `pendingApprovals` 跨 `worker-issue.ts:132` 写、`worker.ts:486-490` 读、`worker.ts:556-573` 解析 — 无单一 owner
- `activeTasks` key 形态多态（`issueId` vs `chat:${requestId}`），router 知两种

**改造方案**：
1. 抽 `Messenger` 接口（`send/sendUpdate/sendChatChunk/sendChatEnd/reportIssueUsage/flushIssueUsage`），handler 依赖接口而非 `ExecutorWorker` 具体类
2. 抽 `TaskRegistry`（封装 `activeTasks`、`pendingApprovals`、`pendingAppends`，含 `cancel/interrupt/resolveApproval`），消除 worker ↔ handler reach-through
3. 抽 `parseIssueMsg(msg): IssueDispatch` 单点解构 12 字段
4. worktree 逻辑迁回 `repo-cache.ts`（`worker.ts:232-397` 165 行）
5. WS router 改 dispatch 表（`Map<messageType, handler>`）

**预期收益**：worker.ts 958 → ~600 行；handler 可独立测试；新增 issue/chat 路径不必回 worker 加 send 方法。

**风险**：中。`worker.ts` 是 executor 核心，需配套端到端回归（issue assign/continue/append + chat chunked reply + approval + interrupt）。

**验证**：`ExecutorWorker.runIssueExecution — interrupt + queue 续跑` 测试 + 手测 5 种 cliTool。

---

### B4-2 后续 — ws-hub/connection.ts 完整 handlers/ 拆分

**当前状态**：本批仅抽了 `resolveReplyContext` helper（5 行 × 3 处去重）。923 行 god-handler 主体未拆。

**为何未做完整拆分**：审计指出 a2a_reply 三兄弟"80% 重复"，实测后实际重复度只有 ~30 行 —— 三者持久化/分发语义不同（chunk 不入库，reply 入库 + 广播 a2a_message，reply_end 入库 + composedPrompt + a2a_stream_end）。完整合并需要大量 `if (kind === ...)` 内部分支，去重收益不明确。

**完整拆分需要的工作**：
1. 引入 `ConnectionContext` 类型封装 closure 状态（`authenticated`、`agentId`、`connGeneration`、`ws`）
2. 按消息族抽 `ws-hub/handlers/{auth,a2a,issue,session,approval,misc}.ts`
3. 主 `handleConnection` 改为 `Map<messageType, handler>` dispatch 表
4. 每条消息到达时构造 ctx 并 dispatch

**风险**：高。Auth flow（token + JWT + token-rename）、a2a_send dispatch、issue_update lifecycle、session_view/delete/snapshot 都依赖 closure 状态和大量 `this.*` 跨模块调用。任何细节遗漏都会破坏 WS 协议。

**建议**：单独立项。在引入端到端 WS 协议测试后再做，避免靠手测验证。

---

### B9 后续 — DB 层展示策略上移

**当前状态**：本批只做了 API → service 下沉（patrol bootstrap + memory extract prompt）。DB 层的展示策略未动。

**未动的展示策略**：
- `db/issues.ts:285-372` `getIssueEvents`：含 status-only 过滤、head/tail 截断、`progress_truncated` 虚拟事件合成、`[tool:exec]` 孤儿 result 修剪 —— 全是视图层关注
- `db/groups.ts:456-502` `getGroupMessages`：同样 head/tail marker 合成

**为何未动**：分离 DB → 视图层会改变 API 响应形状（`progress_truncated` marker 是合成的，不在 DB 里；消费者 dashboard 与 share.ts 都依赖当前 shape）。需要：
1. DB 层 `getIssueEventsRaw` 返纯行
2. 新增 `transformIssueEvents(rows, opts)` 视图函数（在 master/util/ 或 master/services/）
3. 调用方（`api/issues.ts:566`、`api/share.ts`）改调视图函数
4. 测试覆盖：现有 dashboard 渲染、share visitor 视图、`progress_truncated` chip、`[tool:exec]` 配对 都不能破

**建议**：在 UI 端有完整回归测试时再做。否则保持现状。

---

### B5（原始描述保留）


