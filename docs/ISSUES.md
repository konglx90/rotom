# A2A Gateway 问题记录

## 问题 #1: Agent 不能正确转述其他 Agent 的回复

### 问题描述

用户在 Dashboard 通过"公司"给"小寿"发消息时，流程如下：

```
用户 → 公司 → 小寿 → 公司 → 用户
```

期望：公司应该转述小寿的回复，例如："小寿说：你好。"
实际：公司说："好的，我来给小寿发送消息，然后按照要求的格式告诉你他的回复。"

### 复现步骤

1. 在 Dashboard 发送消息给"公司"：
   ```
   通过a2a给"小寿"发送一条消息 你好 收到之后告诉我 dashboard-client 小寿说什么，比如：小寿说：XXX
   ```

2. 观察"公司"的回复，不是转述小寿的内容，而是说"我会..."

### 时间线证据

```
11:52:29 Dashboard → 公司: "收到之后告诉我...小寿说：XXX"
11:52:33 公司 → 小寿: "你好"
11:52:40 小寿 → 公司: "你好。"
11:52:42 公司 → Dashboard: "好的，我来给小寿发送消息，然后按照要求的格式告诉你他的回复。"
```

### 根本原因

`mesh_send` 工具的**异步性质**：

1. LLM 调用 `mesh_send(target="小寿", message="你好")`
2. 工具执行器**立即返回成功**（只是发送了消息）
3. LLM 继续生成回复（此时还没收到小寿的回复）
4. 几秒后小寿的回复到达，但 LLM 已经完成，无法处理

### 当前实现

```typescript
// src/agent/tools.ts (推测)
async mesh_send(target, message) {
  await ws.send({ type: 'a2a_send', ... });
  return { success: true, message: "消息已发送" };
  // ❌ 立即返回，不等待回复
}
```

### 解决方案

#### 方案 A: 修改 mesh_send 为同步等待（推荐）

```typescript
// 添加回复等待机制
const pendingReplies = new Map<string, {
  resolve: (value: any) => void;
  timeout: NodeJS.Timeout;
}>();

async mesh_send(target: string, message: string) {
  const requestId = randomUUID();

  // 1. 注册等待器
  const promise = new Promise((resolve) => {
    pendingReplies.set(requestId, {
      resolve,
      timeout: setTimeout(() => resolve(null), 10000)
    });
  });

  // 2. 发送消息
  ws.send({
    type: 'a2a_send',
    requestId,
    target,
    payload: { message }
  });

  // 3. 等待回复（阻塞）
  const reply = await promise;

  // 4. 返回实际回复
  if (reply) {
    return `${reply.from.name}说：${reply.payload.message}`;
  } else {
    return "消息已发送，但未收到回复";
  }
}

// 在 inbound-dispatcher 中处理回复
function onA2AMessage(message: any) {
  const { requestId, routeType } = message;

  // 如果是回复，并且有待处理的等待器
  if (routeType === 'reply') {
    const pending = pendingReplies.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(message);
      pendingReplies.delete(requestId);
    }
  }
}
```

#### 方案 B: 创建新工具 mesh_send_and_wait

保留原有的 `mesh_send`（异步），新增 `mesh_send_and_wait`（同步等待）：

```typescript
// mesh_send - 异步发送，不等待回复
mesh_send(target, message) {
  // 现有实现
}

// mesh_send_and_wait - 同步发送，等待回复
mesh_send_and_wait(target, message) {
  // 等待实现的同步版本
}
```

#### 方案 C: 使用两轮对话（临时方案）

改变用户的使用方式：

```
第一轮：
用户：给小寿发消息"你好"
公司：[发送] OK

第二轮：
用户：小寿说什么了？
公司：小寿说：你好。
```

### 影响范围

- **影响文件**:
  - `src/agent/tools.ts` - mesh_send 工具实现
  - `src/agent/inbound-dispatcher.ts` - 消息接收处理
  - `src/agent/socket-manager.ts` - WebSocket 消息处理

- **影响功能**:
  - Agent 之间的消息转发
  - 多 Agent 协作场景
  - Dashboard 通过 Agent 中转消息

### 优先级

**高** - 影响核心的多 Agent 协作功能

### 状态

🔴 **待解决**

### 相关数据库记录

```sql
-- 查看问题消息
SELECT
  datetime(timestamp, '+8 hours') as time,
  from_name,
  to_name,
  direction,
  substr(payload, 1, 80) as msg
FROM message_log
WHERE timestamp >= '2026-04-22 03:52:00'
  AND timestamp <= '2026-04-22 03:53:00'
  AND (from_name IN ('dashboard-client', '公司', '小寿')
       OR to_name IN ('dashboard-client', '公司', '小寿'))
ORDER BY timestamp;
```

### 备注

- 用户提示词已经很明确："收到之后告诉我...比如：小寿说：XXX"
- 问题不在于 LLM 理解，而在于工具执行时机
- 需要实现"发送-等待-返回"的同步模式

---

## 问题 #2: Agent 端无法感知群成员关系和查看群消息历史

### 问题描述

Dashboard 已支持群消息功能（创建群、拉 Agent 入群、群内聊天），但 Agent 端无法主动感知以下信息：

1. **群成员关系** — Agent 不知道自己被拉入了哪些群，不知道群里有哪些其他成员
2. **群消息历史** — Agent 无法查看群内的历史消息内容

### 当前状态

- 群消息发送时，消息内容会带上 `[群:群名]` 前缀，Agent 只能被动地从收到的消息中感知群名
- 群成员关系仅存储在 Master 数据库（`groups` + `group_members` 表），未暴露给 Agent
- 群消息历史仅存在于 Dashboard 前端的实时 WebSocket 连接中，未持久化到可查询的 API

### 解决方案

#### 1. Agent 查询所属群列表

新增 REST API 端点：

```
GET /api/agents/:name/groups
```

返回该 Agent 所属的所有群（含群名、成员列表）。

#### 2. Agent 查询群消息历史

新增 REST API 端点：

```
GET /api/groups/:id/messages
```

返回指定群的消息历史（需要后端按群维度持久化和检索消息）。

#### 3. WebSocket 推送群变更（可选增强）

- 在 `auth_ok` 响应中携带 Agent 所属群列表
- 新增 `group_update` 消息类型，群成员变更时实时推送

### 影响范围

- **影响文件**:
  - `src/master/api.ts` — 新增群相关 API
  - `src/master/db.ts` — 按群维度查询消息
  - `src/shared/protocol.ts` — 可选，新增 WebSocket 消息类型
  - `openclaw.plugin.json` — Agent 端插件需适配新的工具/API

- **影响功能**:
  - Agent 主动查询群信息
  - Agent 查看群消息历史
  - 多 Agent 群协作场景

### 优先级

**中** — 不影响核心功能，但影响 Agent 在群场景下的自主协作能力

### 状态

🟡 **待规划**

---

## 问题 #3: 群里 @ Agent,Agent 回复在群历史里出现两次

### 问题描述

在群里 @ 一个由 claudecode/codex 驱动的 Agent(如 `西花-claude`),Agent 回复的同一段文本会以**两条相同的群消息**先后出现在群历史中,时间戳几乎一致。

### 复现现场

```
10:55 西花-claude
工作目录文件数量：
- 排除 node_modules 和 .git：931 个文件
- 包含全部：267,151 个文件

10:55 西花-claude
工作目录文件数量：
- 排除 node_modules 和 .git：931 个文件
- 包含全部：267,151 个文件
```

私聊(DM)场景无重复,只在群 @ 场景下复现。

### 根本原因

群里 @ Agent 时,Agent 的回复会**走两条独立的发送链路**,目前没有去重:

| 步骤 | 谁做的 | 触达群历史的入口 |
| --- | --- | --- |
| 1 | Worker 把 `kind="chat"` 的 prompt 用 `/rotom-a2a-communicate` 包裹,提示词要求 agent 通过 `Bash: rotom group send <gid> <name> "<reply>"` 来回复 | `POST /cli/groups/:gid/send` → `WSHub.sendAsAgent` → `db.addGroupMessage` + 广播 (**第 1 条**)|
| 2 | Worker 把 agent 进程的 stdout 累加为 `fullContent`,调 `sendChatEnd(requestId, fullContent, conversation)` 回给 master | Master 收到 `a2a_reply_end` 后,在 `ws-hub.ts:512-515` 把 `payload.message` 再次入群历史 + 广播 (**第 2 条**)|

也就是说当前所有群里 chat 回复都是"agent 自己用 rotom CLI 发一次 + master 又把 stdout 当回复广播一次"。设计上没人意识到这两条链路会撞车。

### 关键代码位置

- `src/executor/worker.ts:614-635` — `handleChatReply` 用 `kind="chat"` 跑 executor,事后无条件 `sendChatEnd(requestId, fullContent, conversation)`
- `src/master/ws-hub.ts:500-525` — `a2a_reply_end` 分支在群场景下 `addGroupMessage` + `broadcastToGroup`
- `src/master/ws-hub.ts:1255-1306` — `sendAsAgent`(REST `/cli/groups/:gid/send` 的实现)在群场景下 `addGroupMessage` + `sendToAgent`
- `src/executor/executors/claude-code.ts:113-124` / `codex.ts:53-62` — `/rotom-a2a-communicate` wrapper 提示词,要求 agent 通过 Bash 调 `rotom group send`

### 候选解决方案

| 方案 | 改动 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A. Worker 端 group 场景跳过 chunk/end 的内容广播 | `worker.ts:617-635` 在 `conversation?.type === "group"` 时不发 chunk 内容,只发空 `a2a_reply_end` 清掉 master 的 request 映射 | 最干净,符合"agent 已经自己播过"语义 | 要在 master 端处理空 payload 的 reply_end 不入库 |
| B. Master 端 `a2a_reply_end` 在群场景跳过持久化与广播 | `ws-hub.ts:500-525` 改成 `if (conversation?.type === "group") { 只做日志和 state 清理 }` | 改动最小,不需要动 worker | 假设了"群里所有 chat reply 都靠 agent 自己 rotom send",将来若有不靠 CLI 的 agent 实现就会丢消息 |
| C. 改 wrapper 提示词让 agent 只回简短确认 | `claude-code.ts:113-124` / `codex.ts:53-62` | 不改协议 | 软约束,模型不一定听话,治标不治本 |

**倾向方案 B**:目前所有 executor(claudecode、codex、generic-cli)在群场景下都靠 rotom CLI 走 `sendAsAgent`,master 端 `a2a_reply_end` 对群场景就是冗余分支;直接跳过持久化和广播即可,日志和 `sendTimestamps` 清理保留。

### 影响范围

- **影响文件**(若采用方案 B):
  - `src/master/ws-hub.ts` — `a2a_reply_end` 分支群场景跳过入库 + 广播
- **影响功能**:
  - 群里 @ Agent 的回复历史(去重后只剩一条)
  - 私聊 DM 回复不受影响

### 优先级

**中** — 不影响功能可用性,但会造成群历史污染、用户困惑、collaboration round tracking 重复计数等次生问题。

### 状态

🔴 **待修复**
