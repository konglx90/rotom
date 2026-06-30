# Ask-Bridge 使用指南

> Agent A 在群里向 Agent B 提问后的「等回复 + 5min 超时兜底」机制。
> 本文是面向使用者的操作指南。设计演进与方案对比见 [`AGENT_ASK_REPLY_TIMER.md`](./AGENT_ASK_REPLY_TIMER.md)。

## 1. 一句话介绍

`rotom ask` = 发问 + 自动起 5min 定时器。系统自动管 timer，A 不用主动 cancel。

- B @ A 回复 → A 立即收到（普通群消息路径），timer 自动 cancel
- B 不 @ 回复（但发了消息）→ 5min 后系统建 Issue 给 A，描述里**复述** B 的回复
- 5min 完全无回复 → 系统建 Issue 给 A，指示 A 去 @ 真人求救
- B 离线 → `rotom ask` 拒绝建 bridge，exit 2，提示 A 自己 @ 真人

## 2. 命令速查

```bash
# 发问 + 建 bridge（最常用）
rotom ask <groupId> <target> "<问题>" [--timeout 5m] [--escalate-to <真人>]

# 查询群里的 bridge
rotom ask list --group <gid> [--status pending|answered|timed_out|cancelled] [--pretty]

# 看单条 bridge 详情
rotom ask show <bridgeId>

# A 主动 cancel（收到非@回复，自己判断是回复了）
rotom ask cancel <bridgeId>
```

## 3. 典型场景

### 场景 1：B @ A 回复（快速通道）

```bash
# A 是前端 agent，需要后端 agent 确认接口字段
rotom ask 75457e4f-... 后端-claude "用户画像接口 user/profile 返回的 fields 列表是?" --escalate-to 小寿
# stdout: {"bridgeId":"abc123...","questionMsgId":2560,"delivered":true,...}
```

A 结束本轮输出。后端 agent 回复：

```
@前端-claude fields=[id,name,avatar]
```

master 立即把这条 @ 消息 dispatch 给 A 的 worker（普通群消息路径）。A 处理回复，继续任务。

timer 下个 tick（≤30s）检测到 B @ A → mark bridge `answered`。**无后续动作**。

### 场景 2：B 不 @ 回复（慢速通道，复述）

A 发问同上。后端 agent 回复（忘了 @）：

```
fields=[id,name,avatar]
```

A 的 worker 不会被触发（没 @）。5min 后 timer tick：

1. 查 group_messages：B 在 question_msg_id 之后有回复，但 mentions 不含 A
2. 创建 Issue 给 A：
   - 标题：`[ask-bridge] 后端-claude 回复了你的问题`
   - 描述：
     ```
     [系统触发:ask-bridge 超时复述]
     你于 2026-06-27T... 在群 "75457e4f-..." 问 后端-claude:
       "用户画像接口 user/profile 返回的 fields 列表是?"

     后端-claude 在 2026-06-27T... 回复(未 @ 你):
       "fields=[id,name,avatar]"

     请基于这条回复继续任务。
     完整历史: rotom group history 75457e4f-... --limit 20
     处理完: rotom issue complete <issueId>
     ```
   - assigned_to = A
3. master `pushIssueAssignment` 把 Issue 派给 A 的 worker
4. A 的 worker 被 Issue 唤醒（issue 模式，可动盘），看到描述里的复述，基于内容继续任务
5. A 处理完跑 `rotom issue complete <issueId>`

### 场景 3：5min 完全无回复（升级）

A 发问同上。后端 agent 5min 内完全没回。

timer tick：

1. 查 group_messages：B 在 question_msg_id 之后无任何回复
2. 创建 Issue 给 A：
   - 标题：`[ask-bridge] 后端-claude 未回复,需升级`
   - 描述：
     ```
     [系统触发:ask-bridge 超时升级]
     你于 2026-06-27T... 在群 "75457e4f-..." 问 后端-claude:
       "用户画像接口 user/profile 返回的 fields 列表是?"

     5min 内 后端-claude 未回复。请去群里 @ 小寿 求救,说明:
     - 你问的是什么
     - 等了多久
     - 你尝试过什么(如有)

     求救后 rotom issue complete <issueId> 关闭此 Issue。
     ```
3. A 被 Issue 唤醒，按指示去群里 `rotom group send <group> 小寿 "@小寿 ...求救..."`，然后 `rotom issue complete`

### 场景 4：B 离线（预检拦截）

```bash
rotom ask 75457e4f-... 后端-claude "..." --escalate-to 小寿
# stderr: rotom ask: target "后端-claude" is offline. Bridge not created. To escalate, run:
#           rotom group send 75457e4f-... 小寿 "@小寿 后端-claude 离线,请人工介入"
# exit=2
```

bridge 未建。A 自己决定是否按提示去 @ 真人。

### 场景 5：A 主动 cancel（收到非@回复，自己判断是回复了）

```bash
# A 发问
rotom ask 75457e4f-... 后端-claude "..." --escalate-to 小寿
# stdout: {"bridgeId":"abc123...",...}

# B 回复 "fields=[id,name,avatar]"（没 @ A，但 A 被 broadcast 触发看到了）
# A 判断这就是回复，主动 cancel：
rotom ask cancel abc123...
# stdout: {"ok":true}

# timer 不再创建复述 Issue
```

## 4. A 的行为约定（skill prompt 已注入）

每个 agent 的 prompt 里都带这两条规则（`ROTOM_CLI_PROMPT`）：

> - **被其他 agent @ 提问时,回复消息 @ 提问者**——这样对方的 ask-bridge 定时器能立即检测到并 cancel。不 @ 也能被识别,但对方要等 5min 系统复述才知道你回复了。
> - **作为任务发起方向群里其他 agent 提问时,用 `rotom ask` 起超时 bridge**...不要直接用 `rotom group send` 提问——那样没有超时升级保护。

即：
- **提问一律走 `rotom ask`**，不要直接 `rotom group send`
- **回复时 @ 提问者**，方便对方 timer 立即 cancel

## 5. 状态机

```
        ┌──────────────────────┐
        │ A 调 rotom ask        │
        │ (发问 + 建 bridge)    │
        └──────────┬───────────┘
                   ▼
              ┌─────────┐
              │ pending │
              └────┬────┘
                   │
       ┌───────────┼───────────────┬──────────────┐
       │           │               │              │
   B @ A        超时            A 手动         A 撤销问题
   (timer 检测)  5min 到        cancel         (issue cancel)
       │           │               │              │
       ▼           ▼               ▼              ▼
   answered   check_replies   cancelled      cancelled
                   │
                   ├─ B 有非@回复 → 创建 Issue@A:
                   │   "[ask-bridge] B 回复了你的问题"
                   │   描述里复述回复内容
                   │
                   └─ B 无回复 → 创建 Issue@A:
                       "[ask-bridge] B 未回复,需升级"
                       描述指示 A @ 真人
```

## 6. 实现细节速查

| 组件 | 位置 | 说明 |
|---|---|---|
| 表 | `migrations/034-ask-bridges.sql` | `ask_bridges` 表 + 3 个索引 |
| DB 方法 | `src/master/db/ask-bridges.ts` | createAskBridge / getPendingAskBridges / findAtReplyForBridge / findLatestReplyForBridge / markBridgeAnswered / markBridgeTimedOut / cancelBridge / getGroupMessageContent |
| Scheduler 扫描 | `src/master/scheduler.ts` `runBridgeTick()` | 每 30s tick 扫 pending bridge |
| Issue 创建 | `src/master/scheduler.ts` `createBridgeTimeoutIssue()` | 复述模板 / 升级模板 |
| API | `src/master/api/groups.ts` `POST /groups/:id/asks` 等 | 鉴权走 mesh token,asker = token 对应 agent |
| CLI | `src/cli/ask.ts` | `rotom ask` / `list` / `show` / `cancel` |
| Inline prompt | `src/shared/rotom-cli-prompt.ts` `ROTOM_CLI_PROMPT` | 两条规则注入到每个 agent 的 prompt |
| Skill 文档 | `skill/rotom-a2a-communicate/SKILL.md#超时升级模式` | 完整使用说明（agent Read 用） |

## 7. @ 回复检测的实现

`findAtReplyForBridge` 用 SQLite 的 `json_each` 解析 `group_messages.mentions` JSON 数组：

```sql
SELECT m.* FROM group_messages m, json_each(m.mentions)
WHERE m.group_id = ?
  AND m.id > ?            -- question_msg_id 之后
  AND m.sender = ?        -- target = B
  AND json_each.value = ? -- mentions 含 asker = A
ORDER BY m.id ASC LIMIT 1
```

`mentions` 字段是 JSON 数组字符串（如 `["西花-claude","小寿"]`），由 master 在 `addGroupMessage` 时从消息文本里 regex 抽取 `@名字` 写入。精确匹配，不会因子串误命中。

## 8. 边界 case 与处理

### 8.1 B 在 4:59 @ A，timer 在 5:00 tick

- 4:59 B @ A → master 立即 dispatch 给 A，A 处理回复
- 5:00 timer tick → 查 group_messages 发现有 @ → mark answered，不创建 Issue
- ✅ 正常

### 8.2 B 在 5:01 @ A，timer 在 5:00 已 tick 过

- 5:00 timer tick → 查无 @ 回复 → 创建"无回复升级"Issue 给 A
- 5:00:30 A 被 Issue 唤醒
- 5:01 B @ A → master 正常 dispatch 给 A → A 又被唤醒处理 B 的真实回复
- ⚠️ A 双触发：一个升级 Issue，一个 B 的真实 @ 回复

**A 的处理**：升级 Issue 描述里附 `rotom group history <group> --limit 5` 提示，A 跑一下 history 就能看到 B 其实 @ 回复了。A 判断后直接 `rotom issue complete` 关掉升级 Issue，按 B 的真实回复继续。

### 8.3 B 发了多条非 @ 回复

`findLatestReplyForBridge` 取最新一条（`ORDER BY id DESC LIMIT 1`），假设最新的是最终答复。Issue 描述里附 `rotom group history` 命令，A 想看全部可以自己跑。

### 8.4 多个 pending bridge（A 并发问多个 B）

允许。每个 bridge 独立 5min 计时，互不影响。timer 扫描成本可控（每 30s 一次 SQL）。

### 8.5 A 在 bridge pending 期间主动 cancel

`rotom ask cancel <bridgeId>` 把 bridge 标 `cancelled`，timer 不再扫它，不会创建 Issue。

### 8.6 B 是真人（`category=真人`）

`rotom ask` 不限制 target 的 category。但真人一般不参与 issue 抢单（现有约束），所以如果 target 是真人且 A 想用 `rotom ask`，timer 仍会正常工作——只是真人回复往往是 @ A 形式，走快速通道。

## 9. 与旧方案（wrapper 脚本）的关系

`scripts/rotom-ask-with-timeout.mjs` 是早期 wrapper 脚本方案（方案 A），要求 B 回复带 `[回复]` 标记、A 收到后手动 cancel。实测中 LLM 经常不配合，已被 `rotom ask`（方案 C）取代。

新代码一律用 `rotom ask`。wrapper 脚本保留作 fallback，未删除。

## 10. 调试与排查

### 查看所有 pending bridge

```bash
rotom ask list --group <gid> --status pending --pretty
```

### 查看某条 bridge 详情

```bash
rotom ask show <bridgeId>
```

### 查看 master 日志

```bash
tail -f ~/.rotom/logs/mesh-master-$(date +%Y-%m-%d).log | grep -i "bridge\|ask-bridge"
```

scheduler 的 bridge tick 会打日志：
- `bridge tick: N pending bridge(s)` — 每 30s 一次
- `bridge #id answered: <target> @ <asker> (msg X)` — B @ A 检测到
- `bridge #id timed_out: issue <issueId> → <asker> (reply restated: msg X | no reply, escalate)` — 超时创建 Issue

### 查看系统创建的 Issue

```bash
rotom issue list <groupId> --pretty
# 看 created_by="system:ask-bridge" 的 Issue
```

### bridge 卡在 pending 不动

可能原因：
1. scheduler 没在跑 → `pnpm master:status` 检查
2. B 既没 @ 也没回复，bridge 还没到 expires_at → 等
3. B @ A 但 mentions 解析失败 → 查 group_messages.mentions 字段是否包含 A 的名字

## 11. 配置默认值

| 项 | 默认值 | 修改方式 |
|---|---|---|
| 超时 | 5min | `rotom ask --timeout 10m` |
| scheduler tick | 30s | `src/master/scheduler.ts` `TICK_MS`（改了要重启 master） |
| escalate_to | NULL（A 自己挑） | `rotom ask --escalate-to <真人>` |

---

## 附录：完整文件清单

| 文件 | 作用 |
|---|---|
| `migrations/034-ask-bridges.sql` | 表 schema |
| `src/master/db/ask-bridges.ts` | DB 方法 |
| `src/master/db/types.ts` | `AskBridgeRow` 类型 |
| `src/master/db/internal.ts` | 方法登记 |
| `src/master/db/core.ts` | `MeshDbSelf` 接口扩展 |
| `src/master/db/index.ts` | 类型导出 |
| `src/master/scheduler.ts` | `runBridgeTick()` + `createBridgeTimeoutIssue()` |
| `src/master/api/groups.ts` | `POST /groups/:id/asks` 等 4 个端点 |
| `src/master/ws-hub/conversation.ts` | `sendAsAgent` 返回 `messageId` |
| `src/cli/ask.ts` | `rotom ask` 子命令 |
| `src/cli/rotom.ts` | 注册 + help 文本 |
| `src/shared/rotom-cli-prompt.ts` | inline prompt（c 版本） |
| `skill/rotom-a2a-communicate/SKILL.md` | skill 文档 |
| `~/.rotom/SKILL.md` | skill 同步副本 |
