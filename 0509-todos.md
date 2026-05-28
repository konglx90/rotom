# 2026-05-09 TODOs

## Completed

### 1. Issue list status 不要用轮询

**现状**：Dashboard 的 IssueDetail / IssueList 通过 `setInterval` 定时拉取（20s）获取状态更新，长连接空转、刷新有延迟。

**目标**：改为**推送式**。Master 在 issue 状态/事件变化时主动推给 dashboard，dashboard 侧移除 polling。

**方向**：
- 复用现有 WebSocket（dashboard 已经连 Master）或新开 SSE
- 定义事件：`issue_updated`（status/assigned_to/result 变化）、`issue_event_appended`（新增 issue_event，如 collaboration_turn / round_start / concluded）
- Master 在 `updateIssueStatus` / `addIssueEvent` / `recordCollaborationTurn` / `advanceCollaborationRound` / `completeCollaboration` 等写操作后广播订阅了该 issueId 的 dashboard 连接
- Dashboard 侧 IssueDetail 订阅 `issueId`，收到事件后增量更新本地状态；删除 `setInterval` 分支

**影响范围**：
- `src/master/ws-hub.ts` 或新增 dashboard ws 通道
- `src/master/db.ts`（写操作后回调）
- `packages/dashboard/src/features/groups/IssueDetail.tsx`
- `packages/dashboard/src/features/groups/GroupChatView.tsx`（issue 列表）

---

### 2. Tools CLI 化，方便 Claude Code 使用

**现状**：`src/agent/tools.ts` 里的工具（mesh_send / mesh_group_send / mesh_create_collaboration 等）都是通过 OpenClaw SDK 暴露给 agent 运行时的，外部（比如 Claude Code 终端）无法直接调用。

**目标**：提供一个 CLI 入口，把这些 mesh 操作包成命令行命令，Claude Code 可以直接 Bash 调用。

**方向**：
- 新建 `bin/mesh-cli.ts`，基于 commander 或原生 argv 解析
- 子命令覆盖核心工具：
  - `mesh directory [--online-only] [--domain=x]`
  - `mesh send <target> <message>`
  - `mesh group send <groupId> <target> <message>`
  - `mesh group messages <groupId> [--limit=50]`
  - `mesh group members <groupId>`
  - `mesh issue create <groupId> --title --description [--priority]`
  - `mesh collab create <groupId> --title --goal --participants=a,b [--max-rounds=3]`
  - `mesh collab conclude <issueId> --summary`
- 底层复用 HTTP API（`src/master/api.ts`），或短连 WebSocket 发完即退出
- 需要本地配置：Master 地址、Agent 身份 token（读 `~/.openclaw/...` 或环境变量）
- 输出 JSON，方便 Claude Code pipe 处理

**影响范围**：
- 新增 `bin/mesh-cli.ts` + 在 `package.json` 注册 `"bin"` 入口
- 可能复用 `src/agent/ws-client.ts` 做一次性连接

---

### 3. 链接带上 groupId

**现状**：Dashboard 路由（issue 详情、群聊视图等）可能没把 `groupId` 放在 URL 里，导致链接分享/刷新后无法定位。

**目标**：所有需要群上下文的页面，URL 上带 `groupId`，支持直达与刷新保留状态。

**方向**：
- 梳理所有路由，哪些页面隐含"当前群"：群聊视图、Issue 详情、成员列表……
- 改用 `/groups/:groupId/...` 或 query `?groupId=` 作为主路径
- Issue 详情可用 `/groups/:groupId/issues/:issueId`（同时保留 `/issues/:issueId` 兼容）
- 分享链接（系统消息中引用 issue 的超链接）也需要带上 groupId

**影响范围**：
- `packages/dashboard/src/App.tsx` 或路由配置
- `packages/dashboard/src/features/groups/` 下相关组件
- Master 端生成 issue 链接的地方（如有）

---

## Pending

### 4. 第一负责 agent 的监察机制（协作 issue 推进催促）

**现状**：协作 issue 发起后，`participants[0]` 作为首发言人。如果它发完一轮后忘了 @ 下一人、或下一人没回复、或整个 issue 卡住，没有自动推进机制。

**目标**：给首发言人装上"监察者"角色，发起协作时启动定时器，如果一定时间内 issue 未推进（未进入下一轮 / 未完成），自动催促首发言人。

**方向**：
- 定义"推进"信号：`current_round` 变化、或 `status` 变为 `completed` / `cancelled`
- 创建协作时（`ws-hub.ts` 的 `create_collaboration` 分支）启动一个延时 timer（如 5 分钟）
- timer 到期时：
  - 如果 issue 仍在 `in_progress` 且 `current_round` 未变化 → 通过 `sendToAgent` 给 `participants[0]` 发提醒消息：`"协作 <title> 已 N 分钟未推进，请检查是否需要 @ 下一位或主动结束"`
  - 同时在群里发一条系统消息（可选，避免骚扰）
  - 续约 timer，保持周期性催促，直到推进或被结束
- timer 在 issue 完成/取消时清除
- 需要在进程重启后恢复 timer（从 DB 读取 `in_progress` 协作，按 `updated_at` 距今重新排 timer）

**影响范围**：
- `src/master/ws-hub.ts`（timer 管理、催促逻辑）
- `src/master/db.ts`（可能需要 `getStaleCollaborations(thresholdMs)` 查询）
- 新增字段（可选）：`issues.last_activity_at`，更精确地判断是否卡住
- 催促阈值和最大催促次数做成配置

**开放问题**：
- 催促失败多次后要不要自动 conclude？还是只发给 owner（真人负责人）？
- 监察角色是否一直在首发言人身上，还是跟随最近发言人？（建议：跟随最近发言人，这样更准确——"刚说完话的人"最有责任推进）

---

### 5. GroupChatView 组件拆分重构

**现状**：`packages/dashboard/src/features/groups/GroupChatView.tsx` 超过 1300 行，集成了 WebSocket 连接管理、消息收发、群/DM 路由、Issue 面板、Modal 弹窗、mention 输入等所有逻辑，维护困难。

**目标**：拆分为多个职责单一的子组件/hooks，降低单文件复杂度。

**方向**：
- 抽取 `useGroupChatWebSocket` hook：WebSocket 连接、认证、心跳、重连、消息收发逻辑
- 抽取 `useDirectMessage` hook：DM 会话管理（创建、激活、历史恢复）
- 抽取 `GroupChatSidebar` 组件：一对一列表 + 群列表
- 抽取 `GroupChatMessages` 组件：消息渲染（支持群聊/DM 两种模式）
- 抽取 `GroupChatInput` 组件：输入框 + mention 下拉
- `GroupChatView` 只做组合和路由参数管理

**影响范围**：
- `packages/dashboard/src/features/groups/GroupChatView.tsx`
- 新增 `hooks/` 和子组件文件

---

### 6. 支持 deepseek-TUI 类 Agent 接入

**现状**：当前 mesh 网络主要面向 Claude Code + OpenClaw SDK 的 agent。deepseek-TUI 等终端类 agent 无法直接接入 A2A mesh 通信。

**目标**：让 deepseek-TUI 这类终端 agent 能通过简单方式接入 mesh，收发消息、参与群聊和协作。

**方向**：
- 分析 deepseek-TUI 的通信接口（HTTP API / WebSocket / stdin-stdout）
- 方案 A：为 TUI 类 agent 提供轻量 WebSocket client SDK（纯 JSON 协议，不依赖 OpenClaw）
- 方案 B：利用现有 `rotom` CLI 做桥接，TUI agent 通过 HTTP API 调用 rotom 完成收发
- 需要支持：注册上线、收消息、发消息、群聊、@提及
- 认证方式复用 agent token

**影响范围**：
- `src/agent/ws-client.ts`（可能需要轻量版）
- `src/master/ws-hub.ts`（兼容非 OpenClaw 客户端）
- `bin/` 目录（可能新增桥接工具）

---

### 7. 中间对话框变大，两侧靠边

**目标**：GroupChatView 布局调整——中间对话/聊天区域宽度撑大，左右两侧面板（sidebar、issue 面板等）贴到屏幕边缘，减少空白，提高内容展示密度。
