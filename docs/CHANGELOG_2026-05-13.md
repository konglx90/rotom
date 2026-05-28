# 协作体验 7 项改造说明（2026-05-13）

围绕"agent 不会用 rotom"、"消息身份混乱"、"写盘没承载"、"侧栏无法调"四类问题，对 master / agent / dashboard 三端做了一轮改造。本文档记录每项改动落点，便于后续维护与回归。

## 一、后端 `src/`

### 1. `master/ws-hub.ts`
- Issue 完成 / 失败的群内公告，原本以 `conn.name`（执行该 issue 的 agent）作为发送方；现统一改走 `postSystemToGroup`，发送方为 `system`，让 dashboard 能按"系统消息"样式渲染。
- `enrichConversationWithCollaboration` 新增 `activeIssues` 字段：把当前群里 `in_progress` + `open` 状态的非协作 issue（最多 8 条）一并塞进 conversation，供 agent 端 prompt 拼接使用。

### 2. `master/api.ts`
- `GET /api/messages` 接受 `from / to / status / keyword / offset` 过滤参数（原先只支持 `agent / limit / before`）。
- 新增 `GET /api/artifacts/:groupId/diff?path=&base=HEAD`：在产物文件所在目录向上查找 `.git`，找到后执行 `git diff <base> -- <relInRepo>`，返回 unified diff。base 仅允许常规 ref 字符。

### 3. `master/db.ts`
- `listMessages` 同步扩展 `from / to / status / keyword / offset` 过滤条件，并加上 `OFFSET` 实现分页。

### 4. `shared/protocol.ts`
- `ConversationContext` 新增 `activeIssues?: ActiveIssueRef[]` 可选字段；新增导出类型 `ActiveIssueRef`（id/title/status/assignedTo/priority）。

### 5. `shared/group-context.ts`
- `injectGroupContext` 在 `[群消息 context: ...]` 前缀之后追加 `[当前群活跃 issue]` 区段：列出当前活跃 issue 简要信息；空时输出"无"，并附"涉及文件改动请先 `rotom issue create`"提示。
- 新增 `ActiveIssueRef` 接口和 `renderActiveIssues` 渲染函数。

### 6. `skill/rotom-a2a-communicate/SKILL.md`
- "关键规则"补一条第 7 条：**写盘必须挂在 issue 下**。没 issue 只允许 Read/Grep/Glob，需要写盘必须先 `rotom issue create`。
- 新增"行动判定（按消息上下文四象限）"表格：把"群消息无协作 / 群消息有协作 / issue_assigned / 私聊无 issue"四种上下文对应的行为讲清楚。
- 新增"Issue 类型决策"流程 + 反模式清单（不要拿协作 Issue 分配明确任务、不要拿稳交付 Issue 讨论方案、群消息别变成长讨论）。
- 新增"没 issue 时的兜底话术"示例，避免 agent 直接动手或粗暴拒绝。
- frontmatter description 同步更新，提示 SKILL 已包含"写盘需 issue"规则。

## 二、Dashboard `packages/dashboard/src/`

### 1. `features/groups/types.ts`
- `ChatMessage` 新增 `status?: 'pending' | 'delivered' | 'queued' | 'failed'` 与 `statusError?: string`。

### 2. `features/groups/useGroupChatWebSocket.ts`
- 在 `ws.onmessage` 里新增对 `route_result` 类型的处理：按 `requestId` 匹配出对应的发出消息（DM 用全等匹配，群消息用 `${m.id}_` 前缀匹配多目标），把 status 翻成 `delivered / queued / failed`；任一目标已投送则保持 delivered，避免被后续 result 降级。

### 3. `features/groups/GroupChatView.tsx`
- 发送时给 outgoing 消息初始 `status: 'pending'`；目标数为 0 的纯文本消息直接标 `delivered`。
- 新增 `sidebarWidth` 状态：zen 模式默认 0、normal 模式默认 280；按当前模式分别持久化到 `sidebar_width_zen` / `sidebar_width_normal`。
- 移除 `{!zenMode && <Sidebar/>}` 的整块隐藏，改为始终渲染 Sidebar 并由 width 控制可见性。

### 4. `features/groups/GroupChatArea.tsx`
- outgoing 气泡时间戳右侧渲染 status 角标：`⏳ 发送中` / `✓ 已投送` / `📭 已暂存` / `⚠ 失败`，hover 显示 `statusError`。
- `from === 'system'` 时为整行加上 `systemRow` 类、气泡用虚线边框；sender 显示带 `📣 系统` badge，区别于真人 / 稳交付 / 快交付。

### 5. `features/groups/GroupChatSidebar.tsx` + `.module.css`
- Props 新增 `width / onWidthChange / defaultWidth`，由父组件控制宽度；内部用 inline `width` 实现。
- 增加 6px 拖拽条 `.resizer`：mousedown 后接管 `mousemove`，更新宽度（[0, 520] 区间）；mouseup 清理；同时把 body 的 cursor 锁成 `col-resize`、禁选文字。
- 双击拖拽条恢复 `defaultWidth`（zen=0 / normal=280）。
- 当 `width < 40` 时自动隐藏内部内容（保留拖拽条），实现 zen 默认折叠。
- 移除 `.sidebar` 的硬编码宽度。

### 6. `features/groups/ArtifactPanel.tsx` + `.module.css`
- 预览区头部新增"base ref 输入框 + 对比按钮"；button label 随当前 base 实时更新。
- 切换文件时清空旧 diff 状态，避免错位。
- 调用 `artifactsApi.getDiff(groupId, path, base)`，结果分四种渲染：`note`（文件不在 git 仓库）/ `diff` 为空（无差异）/ 普通 diff（按行渲染并按 `+` / `-` / `@@` 上色）。
- 新增 `.diffSection / .diffHeader / .diffNote / .diffEmpty / .diffContent / .diffLine* / .diffBaseInput / .diffBtn / .previewActions` 等样式。

### 7. `features/groups/ChatArea.module.css`
- 新增 `.categoryBadge.system` 虚线徽标样式；`.systemBubble / .systemRow` 浅灰背景 + 虚线边；`.messageStatus` 与 `.status_pending / status_delivered / status_queued / status_failed` 颜色规则。

### 8. `features/messages/MessagesView.tsx` + `.module.css`
- 新建全局消息流页面。
- 顶部过滤器：发送方 / 接收方 / 状态（routed/queued/delivered/failed/no_target/ok）/ 关键字 + 重置按钮。
- 表格列：时间 / from / to / direction / status badge / payload 摘要。
- 单行点击展开下方"消息详情面板"：requestId、from-domain、to-domain、route_type、direction、status、latency、JSON 化的 payload。
- 分页：每页 50 条，`offset` 翻页；`hasMore` 通过取 `PAGE_SIZE+1` 判断。

### 9. `api/messages.ts / api/artifacts.ts / api/types.ts`
- `messagesApi.list` 接受新增过滤参数。
- `artifactsApi.getDiff` 新增；导出 `ArtifactDiff` 类型。
- `Message` 类型补全 `request_id / from_domain / to_domain / direction / status` 字段。

### 10. `App.tsx` 与 `components/layout/Header/Header.tsx`
- App 新增 `/dashboard/messages` 路由。
- Header tabs 数组新增「消息流」入口（位于「消息」与「对话管理」之间）。

## 三、手动验证清单

启动 master + 至少一个 executor worker 后：

1. **Skill / 群上下文**：在群里说"帮我改一下 README"，agent 应回复"请先建 issue"，而不是直接动手；prompt 中的 `[当前群活跃 issue]` 应显示"无"。再 `rotom issue create` 一个任务，重新触发，agent 应进入工作流。
2. **system 身份**：执行 `rotom issue create`，群里应出现一条带"📣 系统" badge、虚线边框的公告，而不是某 agent 名。
3. **已投送指示**：dashboard 在群里 `@离线agent` 发一条 → 角标 `📭 已暂存`；`@在线agent` → `✓ 已投送`；纯文本无 @ → `✓ 已投送`。
4. **/dashboard/messages**：访问新页面，能看到全部消息；`status=failed` 过滤生效；点击单行可展开详情。
5. **Zen 拉宽**：切换到 zen 模式，左侧应有一道 6px 蓝条；拖拽展开 sidebar、双击恢复折叠；刷新页面宽度保留。
6. **Diff**：在产物面板选一个文件，输入 base（默认 HEAD），点"对比 HEAD"，应看到 unified diff 按 +/- 行上色；如文件不在 git 仓库，应显示"目标文件不在 git 仓库中..."提示。

## 四、构建状态

- `npx tsc --noEmit -p tsconfig.json`：无错误
- `cd packages/dashboard && npx vite build`：✓ built in ~900ms（353 modules）
