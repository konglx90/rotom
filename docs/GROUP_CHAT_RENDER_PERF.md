# 群聊渲染性能优化记录

记录 `dashboard/groups/:groupId` 页面（`GroupChatView` → `GroupChatArea`）的渲染性能优化进展、未做项的潜在问题、未来按需启用的判断标准。

---

## 已完成的优化

### P0-1 流式 setState RAF 批处理

`packages/dashboard/src/features/groups/useGroupChatWebSocket.ts`

把 `a2a_stream_chunk` 的 `setMessages` 从"每个 token 直调"改为 `requestAnimationFrame` 批处理：每帧最多 commit 一次,合并多个 streamId 的 delta。流结束（`a2a_stream_end`）时同步 flush 避免最后一段丢失。

收益：把 50-80Hz 的 token 流降到 ≤60Hz setState,主线程不再被打爆。

### P0-2 滚动节流 + 改用 scrollTop

`packages/dashboard/src/features/groups/GroupChatArea.tsx`

`messages` 变化时滚动到底部的逻辑用 RAF 节流,每次变化 cancel 旧 RAF 重 schedule,确保最新一次状态变更一定触发滚动。用 `messagesAreaRef.scrollTop = scrollHeight` 取代 `scrollIntoView({ behavior: 'smooth' })`（高频下 smooth 会反复打断动画,且 0 高度锚点行为不稳）。

收益：layout thrashing 消除,滚动跟手。

### P0-3 groupMembers useMemo

`packages/dashboard/src/features/groups/GroupChatArea.tsx`

`groupMembers` 用 `useMemo([selectedGroup.members])` 锁住引用,避免每次 render 新建数组击穿 `MarkdownContent.memo` 的浅比较。

### P1-1 MessageRow 抽组件 + memo

`packages/dashboard/src/features/groups/MessageRow.tsx`（新建）

把单条消息渲染从 `GroupChatArea` 抽出,`memo` 包裹。父组件传入的 `onShowPrompt` 用 `useCallback` 锁住引用。流式期间历史消息整棵子树（外层 div / Avatar / Badge / StreamingStatus / MarkdownContent）直接跳过协调。

收益：128 条消息流式时,只有最新 1 条走完整渲染,其他 127 条零开销。

---

## 未做项：P1-2 虚拟列表

### 触发条件（什么时候才考虑）

按当前 ~17 节点/消息的密度推算：

| 消息数 | DOM 节点估算 | 状态 |
|---|---|---|
| < 300 条 | < 5000 | 流畅,无需虚拟化 |
| 300-500 条 | 5000-8500 | 滚动开始有轻微 jank |
| 500+ 条 | 8500+ | 明显需要虚拟列表 |
| 1000+ 条 | 17000+ | 必须做 |

实测数据（2026-06-16,`/dashboard/groups/997eaf72-...`,128 条消息）：
- messages 区域 DOM 节点：2224
- body 总节点：2644
- HTML 大小：154 KB
- 内容高度：73 屏

### 不做的影响

P0/P1-1 解决的是 **React 协调阶段**的瓶颈。P1-2 解决的是 **DOM 节点数导致浏览器 layout/paint 慢**——和 React 协调无关。300 条以下完全无收益。

### 引入后的潜在问题清单（维护成本）

#### 1. 折叠/展开状态会丢 ⚠️

`MessageRow` 内部状态会被虚拟化卸载：
- `MarkdownContent.tsx:469` `ThinkingBlock` 的 `useState(false)`
- `MarkdownContent.tsx:488` `ToolCallBlock` 的 `useState(false)`
- `MarkdownContent.tsx:545` `ToolCallGroupBlock` 的 `useState(false)`

虚拟列表卸载不可见的 MessageRow 后,用户之前展开的 thinking / tool_call 下次滚动回来时会重新折叠。

解决：把展开状态从 MarkdownContent 内部提升到外层（按 msg.id 索引的 `Set<string>` 或 Map）—— 这是一次不小的重构,需要改动 `MarkdownContent` 的 API。

#### 2. 流式期间高度持续变化

最新流式消息每个 token 都可能改变高度（换行、新 tool_call 块）。virtualizer 需要 `measureElement` 持续重测,处理不好会出现：
- 内容短暂跳到错误位置（旧高度 + 新内容）
- 滚动到底部逻辑被高度变化打断

#### 3. 动态高度测量的竞态

`measureElement` 异步,React 18 严格模式下多次测量/重渲染时序敏感。

#### 4. 用户面体验回归

- **Ctrl+F 浏览器查找**：找不到被虚拟化掉的 DOM 节点
- **屏幕阅读器**：只读到可见消息
- **打印**：只打印可见消息
- **滚动到老消息**：要维护 id → index 映射

#### 5. MarkdownContent 的 details 元素

`details` 展开/折叠会改变自身高度,每次 toggle 都要通知 virtualizer 重新测量,否则滚动条 size 错乱。

### 推荐方案：按需启用

未来真要做时,建议**按消息数阈值切换**：

```tsx
const VIRTUAL_THRESHOLD = 200  // 经验值,实测可调

{messages.length > VIRTUAL_THRESHOLD ? (
  <VirtualizedMessageList ... />
) : (
  messages.map(msg => <MessageRow key={msg.id} ... />)
)}
```

这样：
- 日常会话（< 200 条）保持全量渲染,避免虚拟列表的隐性成本
- 长会话才走虚拟化路径,接受其复杂性

两条路径共享同一个 `MessageRow` 组件,只是外层 list 容器不同。

### 设计要点（未来实现时）

1. **展开状态外置**：`MessageRow` 接收 `openThinking: Set<string>` / `openToolCalls: Set<string>` 和 toggle callback,内部状态全部去掉
2. **streaming 消息强制保留**：流式中的消息不能被虚拟化卸载（否则 `useState` 丢失 + 流式中断）,要么放在 padding 区,要么用 sticky
3. **滚动到底部用 `virtualizer.scrollToIndex(messages.length - 1)`** 取代当前的 scrollTop
4. **details toggle 后调 `virtualizer.measureElement(el)`** 重新测量该 row
5. **Ctrl+F 兼容**：评估是否需要降级方案,或接受"找不到"作为已知限制

---

## 未做项：P1-3 历史消息分页

`packages/dashboard/src/features/groups/useGroupChatWebSocket.ts:271-287`

进入群组时 `groupsApi.getMessages(selectedGroupId)` 一次性拉全部历史。

**触发条件**：单群组消息数 > 1000 且后端 API 支持分页（`?limit=&before=`）。

**潜在问题**：依赖后端 API 支持,且分页 + WebSocket 流式新消息的合并逻辑比较 tricky（参考当前 `a2a_stream_end` 中 apply 函数的去重逻辑）。

---

## 验证方法

未来评估是否启用 P1-2 时,用以下方式量化：

1. **DOM 节点采集**（Chrome DevTools Console）：
   ```js
   const area = document.querySelector('[class*="messagesArea"]');
   console.log('messages:', area.querySelectorAll('[class*="messageRow"]').length);
   console.log('dom nodes:', area.querySelectorAll('*').length);
   ```

2. **滚动性能**（Chrome DevTools → Performance）：
   - 录制滚动 5 秒
   - 检查单帧时长是否稳定 < 16ms
   - 看 paint/layout 占比

3. **React 协调**（React DevTools Profiler）：
   - 流式期间录制,验证只有最新一条 MessageRow 高亮（其他被 memo 跳过）
