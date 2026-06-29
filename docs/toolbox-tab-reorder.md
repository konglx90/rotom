# 工具箱 Tab 顺序调整与默认页切换

> 背景：工具箱页（`/dashboard/toolbox`）当前默认落到「终端」tab，且终端排在第 2 位。日常使用中消息流是更高频的观察入口，决定把终端挪到最后一位，默认页改为消息流。

## 改动范围

仅前端 dashboard，无后端 / DB / 协议变更。

### 1. `packages/dashboard/src/features/toolbox/ToolboxView.tsx`

`TABS` 数组重排，把 `terminal` 挪到末尾：

```ts
const TABS = [
  { to: 'messages', label: '消息流', icon: '📜' },
  { to: 'prompts', label: 'Prompt管理', icon: '📝' },
  { to: 'schedule-patterns', label: '定时任务模板管理', icon: '⏰' },
  { to: 'terminal', label: '终端', icon: '⌨️' },
] as const
```

### 2. `packages/dashboard/src/App.tsx`

toolbox index 路由的默认重定向从 `terminal` 改为 `messages`：

```tsx
<Route path="/dashboard/toolbox" element={<RequireAgent><div className="container-full"><ToolboxView /></div></RequireAgent>}>
  <Route index element={<Navigate to="messages" replace />} />
  <Route path="terminal" element={<TerminalPage />} />
  <Route path="messages" element={<MessagesView />} />
  <Route path="prompts" element={<PromptsManagementTab />} />
  <Route path="schedule-patterns" element={<SchedulePatternsTab />} />
</Route>
```

### 3. 历史兼容重定向（保留不动）

- `App.tsx:87` `/dashboard/messages` → `/dashboard/toolbox/messages`
- `App.tsx:88` `/dashboard/terminal` → `/dashboard/toolbox/terminal`

两条老链接仍可用，本次不动。

## 测试用例（QA 共同讨论版）

| # | 用例 | 预期 |
|---|------|------|
| 1 | 未绑定身份访问 `/dashboard/toolbox` | `RequireAgent` 守卫弹回 `/dashboard/agents`（回归） |
| 2 | 已绑定身份访问 `/dashboard/toolbox`（无子路径） | 自动跳到 `/dashboard/toolbox/messages`，消息流 tab 高亮 |
| 3 | 工具箱页 tab 顺序 | 消息流 → Prompt管理 → 定时任务模板管理 → 终端 |
| 4 | 点击「终端」tab | 路由到 `terminal`，xterm 正常连接、可输入 |
| 5 | 点击「消息流」tab | 列表正常加载、可滚动翻页 |
| 6 | 点击「Prompt管理」「定时任务模板管理」tab | 各自页面正常渲染（回归） |
| 7 | 浏览器前进/后退在 messages / prompts / schedule-patterns / terminal 间切换 | URL 与 tab 高亮同步 |
| 8 | 老链接 `/dashboard/terminal` | 仍跳到 `/dashboard/toolbox/terminal` |
| 9 | 老链接 `/dashboard/messages` | 仍跳到 `/dashboard/toolbox/messages` |
| 10 | 刷新 `/dashboard/toolbox/terminal` | 仍进入终端页，不被默认重定向劫持 |
| 11 | 在 terminal 页点浏览器「返回」到 `/dashboard/toolbox` | 落到 `messages`，而非 `terminal` |
| 12 | 访客模式 `?share=<token>` 打开 `/dashboard/toolbox` | 默认落到消息流，只读 |
| 13 | 切走终端 tab 再切回 | 终端 ws 按既有逻辑重连（路由级 unmount 行为不变，回归） |
| 14 | 从其他一级页（对话/看板/员工管理）点「工具箱」 | 落到 `messages`，符合默认预期 |

## 风险与回滚

- **风险**：低。仅 UI 顺序与一条 `<Navigate>` 目标变更；不触碰终端 ws、消息流数据、Prompt/定时模板逻辑。
- **回归点**：终端 ws 重连行为（用例 13）、老链接兼容（用例 8/9）需回归一遍。
- **回滚**：把 `TABS` 顺序和 `Navigate to="messages"` 还原即可。

## 涉及文件

- `packages/dashboard/src/features/toolbox/ToolboxView.tsx`
- `packages/dashboard/src/App.tsx`
