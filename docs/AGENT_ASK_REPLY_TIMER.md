# Agent-to-Agent 协作:问→等回复→超时处理

> 群内 Agent A 向 Agent B 提问后的「等回复 + 超时兜底」机制设计文档。
> 本文档收录讨论过程中出现过的几套方案、各自的取舍、以及当前推荐方向。
> 实现进度以代码为准,本文是设计快照。

## 0. 当前实现(2026-07 重构)

`rotom ask <target> "<q>"` 是点对点提问的唯一 CLI 入口,target 形如 `alice`(本地)或 `alice@hostname`(联邦)。提供两种模式:

- **sync(默认)**:阻塞等回复,5min 超时 exit 2,**不升级 Issue**。CLI 端 200ms 轮询 `bridge.status`,scheduler `ask-bridge-check` handler 每 20s 兜底检测 reply。
- **async**:发完即返 `bridgeId`,5min 超时升级 Issue 给 asker(沿用 #reply 路径,见下方章节)。

群永远建在协调 master 上(本地场景本机即协调,联邦场景显式协调 master 持群)。master 自动找/建 `a2a_direct` pair 群作为对话上下文容器,`last_activity_at` 3 天 TTL 续命/过期(scheduler `a2a-direct-ttl-sweep` handler 每小时跑)。

`#reply` 群消息标记保留——群聊上下文里自然冒出来的提问仍可用 `#reply`,跟 CLI `rotom ask` 是两条独立触发,共用 `ask_bridges` 表 + 5min 超时兜底。`#reply` 触发的 bridge 自动是 async 模式。

旧路径(`rotom ask <gid> <target> <q>`、`rotom fed ask`、`rotom group create --a2a-direct`、`rotom group send --need-reply`)全部废弃;`skill/rotom-bus-host` 删除。详见下方章节。

## 1. 问题背景

### 1.1 现状缺口

rotom 群聊里 Agent A 向 Agent B 提问,只有 `rotom group send` 这一个原语,它是 **fire-and-forget**:

- 发完即返回,不阻塞、不等回复
- 对方回复作为新群消息到达,触发 A 的 worker 下一轮处理
- **没有任何 wall-clock 超时机制**
- **没有自动升级到真人的机制**

实际跑下来暴露两个问题:

**问题 1: A 忘了用 wrapper**

最初设计了一个 wrapper 脚本 `scripts/rotom-ask-with-timeout.mjs`,skill 文档教 A 在提问时调用它来起 5min 定时器。但实测中 A(LLM)经常绕过 wrapper 直接 `rotom group send`,定时器没起,超时升级失效。

**问题 2: B 不带 `[回复]` 标记**

wrapper 设计里 B 的回复必须以 `[回复]` 开头,A 的 cancel 逻辑靠这个标记识别。但 B 也是 LLM,不一定听话——实测中 B 经常直接回话不带标记,导致 A 误判「未回复」、5min 后误升级真人。

### 1.2 设计目标

- **A 不用主动起定时器**:系统侧自动建 timer,A 只管发问
- **B 不用配合约定**:B 正常回话即可,不强制 `[回复]` 标记
- **超时兜底**:5min 没回复,自动给 A 一个可执行的下一步(读历史 / 升级真人)
- **群内交付**:所有动作在 rotom 群里完成,不嵌单独 agent
- **脚本式判定**:回复检测用确定性逻辑(SQL 查询),不让 AI 判断"是否回复了"

## 2. 方案演化

讨论中出现过三套方案,复杂度递增、对 B 的约束递减。

### 方案 A:Wrapper 脚本(已实现,但效果不佳)

**思路**:A 在 bash 里调 wrapper 脚本,wrapper 完成「发问 + 起 scheduler 定时器」两步。

```
A 的 bash:
  node scripts/rotom-ask-with-timeout.mjs ask \
    --group <gid> --target <B> --question "<问题>" --escalate-to <真人>

wrapper 内部:
  1. rotom directory 查 B 是否 online;离线立即 @ 真人
  2. rotom group send <group> <B> "@<B> <问题>(回复请以 [回复] 开头)"
  3. rotom schedule add --mode message --in 5m --name "ask-timeout-<B>"
     --prompt "@<真人> 5min 未收到 <B> 回复,请人工介入"
  4. stdout: schedule id

A 收到 B 回复后:
  - 若消息以 [回复] 开头 → 跑 wrapper cancel 子命令 disable 定时器
  - 否则忽略,继续等
```

**实测问题**:
- A 经常不用 wrapper,直接 `rotom group send`(LLM 自主决策,skill 文档约束力不够)
- B 经常不带 `[回复]` 标记,A 收到回复但 cancel 不触发,5min 后误升级
- inline prompt 即使加了 wrapper 提示,A 仍可能绕过

**适用场景**:A 是高度可信的 agent(强 skill 加载、稳定遵循约定),B 同样可信。现实里 LLM agent 达不到这个稳定度。

**当前状态**:代码已落地(`scripts/rotom-ask-with-timeout.mjs`),但实测效果不佳,正在被方案 C 取代。

---

### 方案 B:Master 侧 `rotom ask` + Bridge 表 + Scheduler 扫描 + 自动 cancel(未实现)

**思路**:把 wrapper 的逻辑下沉到 master 侧,A 只需调一个 `rotom ask` 子命令,timer 由系统管理。回复检测从「`[回复]` 标记」改为「B 是否 @ 了 A」。

```
A 调用:
  rotom ask <group> <B> "<问题>" [--timeout 5m] [--escalate-to <真人>]

master 侧:
  1. 发问(走现有 group send,落 group_messages)
  2. INSERT ask_bridges (id, group_id, asker=A, target=B,
     question_msg_id, expires_at=now+5min, status='pending')
  3. 返回 bridge id

scheduler 每 30s tick:
  for bridge in pending_bridges:
    # 查 B 是否在问题之后 @ 过 A
    reply = SELECT * FROM group_messages
            WHERE group_id=bridge.group_id
              AND id > bridge.question_msg_id
              AND sender = bridge.target
              AND mentions JSON contains bridge.asker
            ORDER BY id ASC LIMIT 1

    if reply:
      mark bridge answered (cancel,不升级)
    elif bridge.expires_at < now:
      mark bridge timed_out
      hub.postSystemToGroup("@<真人> 5min 未收到 <B> 回复...")
```

**相比方案 A 的改进**:
- A 只需调一个命令(`rotom ask`),不需要跑 wrapper 脚本
- timer 完全由 master 管理,A 不用主动 cancel
- 回复判定从 `[回复]` 标记改为 `mentions includes A`,B 不用记约定,只要 @ 就行

**残留问题**:
- **B 不 @ 就误升级**:B 回复了但忘 @,timer 检测不到,5min 后误升级真人。这是 @ 检测的固有问题。
- **超时升级是机械动作**:timer 直接 @ 真人,没有 A 的语义判断。B 可能回了部分内容、或回了但没 @,timer 一律升级,真人被打扰。
- **没有"读最近消息再判断"的中间态**:timer 要么 cancel 要么升级,没有给 A 一次"自己看看群里发生了什么"的机会。

**适用场景**:B 严格遵守 @ 约定(强 skill 加载);升级门槛低(真人乐意被误打扰)。

**当前状态**:未实现。设计被方案 C 取代。

---

### 方案 C:Bridge + 超时创建 Issue 复述回复(当前推荐)

**思路**:延续方案 B 的 bridge 表 + scheduler 扫描,但**超时动作不直接升级真人**,而是创建一个 Issue 给 A,Issue 描述里:
- 若 B 有非 @ 回复 → **复述回复内容**,A 基于复述继续任务
- 若 B 完全没回复 → 指示 A 自己去 @ 真人求救

把"是否升级真人"的判断权交还给 A(语义判断),timer 只负责"5min 到了提醒 A 看一眼"。

```
A 调用:
  rotom ask <group> <B> "<问题>" [--timeout 5m] [--escalate-to <真人>]

master 侧:
  1. 发问(走现有 group send,落 group_messages,记 question_msg_id)
  2. INSERT ask_bridges (status='pending', expires_at=now+5min)
  3. 返回 bridge id

A 的 worker 正常收群消息(无抑制):
  - B @ A → master 正常 dispatch 给 A,A 立即处理
  - B 不 @ A → A 不被触发(正常群消息逻辑)

scheduler 每 30s tick:
  for bridge in pending_bridges:
    # 1. 先查 B 是否 @ 过 A → 自动 cancel
    if 存在 group_messages where sender=B AND mentions includes A
                                     AND id > question_msg_id:
      mark bridge answered
      continue

    # 2. 超时未 @ → 创建 Issue 给 A
    if bridge.expires_at < now:
      # 查 B 是否有非 @ 回复
      non_at_reply = SELECT * FROM group_messages
                     WHERE sender=B AND id > question_msg_id
                     ORDER BY id DESC LIMIT 1

      if non_at_reply:
        # 复述回复,创建 Issue
        issue.title = "B 回复了你的问题"
        issue.description = """
          [系统触发:ask-bridge 超时复述]
          你于 <created_at> 在群 <groupName> 问 <B>:
            "<question, 截断 200 字>"

          <B> 在 <reply.created_at> 回复(未 @ 你):
            "<reply.content, 截断 500 字>"

          请基于这条回复继续任务。
          完整历史: rotom group history <groupId> --limit 20
          处理完: rotom issue complete <issueId>
        """
      else:
        # 无任何回复,指示 A 升级
        issue.title = "B 未回复,需升级"
        issue.description = """
          [系统触发:ask-bridge 超时升级]
          你于 <created_at> 在群 <groupName> 问 <B>:
            "<question, 截断 200 字>"

          5min 内 <B> 未回复。请去群里 @ <escalate_to> 求救,说明:
          - 你问的是什么
          - 等了多久
          - 你尝试过什么(如有)

          求救后 rotom issue complete <issueId> 关闭此 Issue。
        """

      issue.assigned_to = A
      issue.created_by = "system:ask-bridge"
      mark bridge timed_out
      hub.pushIssueAssignment(issue.id, A)
```

#### 关键设计决策

**1. @ 是 cancel 信号,但不是唯一回复途径**

- B @ A → master 正常 dispatch 给 A(走现有 chat 路径) + timer 检测到 @ 自动 cancel bridge
- B 不 @ A → A 不被实时触发,但 timer 在 5min 到点时会查到这条回复,复述进 Issue

这样 @ 是"快速通道"(实时响应),非 @ 是"慢速通道"(5min 后系统复述)。

**2. 超时创建 Issue,不发系统 @ 消息**

| 项 | 系统 @ 消息 | Issue(本方案) |
|---|---|---|
| 触发 A 的 worker | ✅(chat 路径) | ✅(issue 分派路径) |
| A 能动盘(写代码) | ❌(chat 只读) | ✅(issue 有 working_dir) |
| 有生命周期 | ❌(消息发完就完) | ✅(可 cancel/complete/追加事件) |
| Dashboard 可跟踪 | ❌(埋在群消息流里) | ✅(看板显式展示) |
| 复用现有机制 | ✅ | ✅(`pushIssueAssignment`) |

Issue 路径更重,但给 A 完整的任务上下文,且 dashboard 可见。

**3. "复述"是 SQL 拷贝,不是 AI 摘要**

`reply.content` 直接 copy 进 Issue description,可能截断到 500 字。不做 LLM 摘要——保持确定性,避免摘要失真。

**4. A 不被抑制**

A 的 worker 在 bridge pending 期间正常收群消息。如果群里其他人发消息 @ A,A 正常响应。bridge 只管 B 的回复检测,不影响 A 的其他交互。

#### 边界 case

**Case 1: B 在 4:59 @ A,timer 在 5:00 tick**

- 4:59 B @ A → master 立即 dispatch 给 A,A 处理回复
- 5:00 timer tick → 查 group_messages 发现有 @ → mark answered,不创建 Issue
- ✅ 正常,A 已处理回复,bridge 闭环

**Case 2: B 在 5:01 @ A,timer 在 5:00 已 tick 过**

- 5:00 timer tick → 查无 @ 回复 → 创建"无回复升级"Issue 给 A
- 5:00:30 scheduler dispatch Issue → A 的 worker 被唤醒处理升级 Issue
- 5:01 B @ A → master 正常 dispatch 给 A → A 的 worker 又被唤醒处理 B 的回复
- ❌ A 被双触发:一个升级 Issue,一个 B 的真实回复

**缓解方案**(待定):
- (a) timer tick 创建 Issue 前再查一次 group_messages(减少 race window,但 30s tick 仍有缝隙)
- (b) bridge timed_out 后,B 的 @ 消息到达时 master 检测到 bridge 状态,不再 dispatch 给 A(抑制 B 的 @,但破坏正常群消息语义)
- (c) A 的 worker 自己处理双触发:看到升级 Issue 后先跑 `rotom group history` 检查 B 是否其实回复了,回复了就忽略升级 Issue

倾向 (c)——A 是 AI,有能力判断,且不破坏群消息语义。Issue description 里可以加一句"先跑 `rotom group history <group> --limit 5` 确认 B 真的没回复"。

**Case 3: B 发了多条非 @ 回复**

取最新一条(`ORDER BY id DESC LIMIT 1`)。假设最新的是最终答复。Issue description 里附完整 history 命令,A 想看全部可以自己跑。

**Case 4: A 在 bridge pending 期间主动 cancel**

A 收到 B 的非 @ 回复,自己判断是回复了,主动 `rotom ask cancel <bridgeId>` 关掉 bridge,timer 不再创建 Issue。

这给 A 一个"我看到了,不用系统介入"的逃生口。

#### 取舍总结

| 维度 | 方案 A(wrapper) | 方案 B(master + @ cancel) | 方案 C(bridge + Issue 复述) |
|---|---|---|---|
| A 主动起 timer | ✅(调 wrapper) | ❌(系统自动) | ❌(系统自动) |
| A 主动 cancel | ✅(调 cancel) | ❌(自动) | 可选(manual cancel) |
| B 需配合约定 | `[回复]` 标记 | @ A | @ A(快速通道);不 @ 也行(慢速通道) |
| 超时动作 | 直接 @ 真人 | 直接 @ 真人 | 创建 Issue 给 A(复述 or 升级指示) |
| 升级决策 | timer(机械) | timer(机械) | A(语义判断) |
| B 不 @ 时的误升级 | 高(标记没带就误判) | 高(@ 没带就误判) | 低(复述进 Issue,A 判断) |
| 复杂度 | 低(脚本) | 中(bridge 表 + scheduler 改) | 中高(bridge 表 + scheduler 改 + Issue 创建路径) |
| Dashboard 可见 | ❌(定时器在 schedule list 里) | ❌ | ✅(Issue 出现在看板) |

## 3. 当前推荐:方案 C

理由:
1. **解决 A 不用主动**:A 调一个 `rotom ask` 就完事,系统自动管 timer
2. **解决 B 不用配合**:不 @ 也能被识别(慢速通道),@ 了实时响应(快速通道)
3. **超时升级有语义判断**:A 读 Issue 描述(含复述)后决定是否真升级,减少误打扰真人
4. **复用现有机制**:不新增 master → worker 私推通道,Issue 走现有分派路径
5. **Dashboard 可见**:Issue 出现在看板,真人能看到 A 被 timer 唤醒过

## 4. 待确认的设计点

### 4.1 `--escalate-to` 参数是否保留

方案 C 里升级是 A 自己 @ 真人,`rotom ask` 命令是否还需要 `--escalate-to` 参数?

- **保留**:Issue 描述里写明 "@ <escalate_to>",A 直接 copy。简单但死板。
- **省略**:A 自己挑群里在线的 `category=真人` agent。灵活但 A 可能挑错或犹豫。

倾向**保留**——`rotom ask` 时 A 知道该任务该找谁,把信息传下去更确定。

### 4.2 双触发(Case 2)的处理

A 的 worker 同时收到"无回复升级 Issue"和"B 的真实 @ 回复"时怎么办?

倾向方案 (c):Issue description 里加一句"先跑 `rotom group history <group> --limit 5` 确认 B 真的没回复,若已回复则忽略本 Issue 直接 complete"。让 A 自己判断。

### 4.3 Issue 创建在哪个 working_dir

Issue 需要 working_dir。bridge 知道 group_id 和 asker,可以走 `resolveGroupAgentWorkingDir(db, group_id, asker)` 派生(现有逻辑)。和 A 自己 `rotom issue create` 的工作目录一致。

### 4.4 多个 pending bridge 限流

A 是否允许同时有多个 pending bridge(向多个 B 提问)?

- **允许**:每个 bridge 独立 5min 计时,互不影响。复杂但灵活。
- **限制 1 个**:A 必须串行提问。简单但限制多。

倾向**允许**——A 是 LLM,可能并行问多个 agent。timer 扫描成本可控(每 30s 一次 SQL)。

### 4.5 bridge 的审计与清理

answered / timed_out / cancelled 的 bridge 记录留多久?

- **永久保留**:便于审计,但表会膨胀
- **7d 后清理**:用 created_at + status 索引,定期 DELETE

倾向**永久保留** + 加 `resolved_at` 索引,需要时手动清理。bridge 记录不大,膨胀可控。

## 5. 实现拆解(方案 C)

### 5.1 数据模型

新表 `ask_bridges`(migration 034):

```sql
CREATE TABLE ask_bridges (
  id              TEXT PRIMARY KEY,         -- uuid
  group_id        TEXT NOT NULL,
  asker           TEXT NOT NULL,            -- Agent A
  target          TEXT NOT NULL,            -- Agent B
  question_msg_id INTEGER NOT NULL,         -- A 发问对应的 group_message id
  escalate_to     TEXT,                     -- 真人 agent 名;NULL = A 自己挑
  timeout_ms      INTEGER NOT NULL,         -- 默认 300000
  created_at      INTEGER NOT NULL,         -- epoch ms
  expires_at      INTEGER NOT NULL,         -- created_at + timeout_ms
  status          TEXT NOT NULL,            -- pending / answered / timed_out / cancelled
  reply_msg_id    INTEGER,                  -- B 的回复 group_message id(若有)
  resolved_at     INTEGER,
  issue_id        TEXT,                     -- 超时创建的 Issue id(若有)
  CHECK (status IN ('pending','answered','timed_out','cancelled'))
);
CREATE INDEX idx_ask_bridges_pending ON ask_bridges(expires_at) WHERE status = 'pending';
CREATE INDEX idx_ask_bridges_lookup ON ask_bridges(group_id, target, status);
```

### 5.2 DB 层

新模块 `src/master/db/ask-bridges.ts`,提供:

- `createAskBridge(input)`
- `getPendingAskBridges(now)` — scheduler 用,只查 pending
- `findAtReplyForBridge(bridge)` — 查 B 是否 @ 过 A
- `findLatestNonAtReplyForBridge(bridge)` — 超时时查 B 的非 @ 回复
- `markBridgeAnswered(id, replyMsgId)`
- `markBridgeTimedOut(id, issueId)`
- `cancelBridge(id)` — A 主动 cancel
- `getBridge(id)` / `listBridges(filter)` — 查询用

### 5.3 Scheduler 扩展

`src/master/scheduler.ts` 的 `tick()` 加一支:

```ts
// 现有:scheduled_tasks
// 新增:ask_bridges
const pendingBridges = db.getPendingAskBridges(now);
for (const bridge of pendingBridges) {
  // 1. 查 @ 回复 → answered
  const atReply = db.findAtReplyForBridge(bridge);
  if (atReply) {
    db.markBridgeAnswered(bridge.id, atReply.id);
    continue;
  }
  // 2. 超时 → 创建 Issue + timed_out
  if (bridge.expires_at < now) {
    const nonAtReply = db.findLatestNonAtReplyForBridge(bridge);
    const issue = createBridgeTimeoutIssue(bridge, nonAtReply);
    db.markBridgeTimedOut(bridge.id, issue.id);
    hub.pushIssueAssignment(issue.id, bridge.asker);
  }
}
```

### 5.4 CLI

新子命令 `src/cli/ask.ts`:

```bash
# 发问 + 建 bridge
rotom ask <groupId> <target> <question...> \
  [--timeout 5m] \
  [--escalate-to <真人>]

# 查询
rotom ask list [--group <gid>] [--status pending]

# 手动 cancel
rotom ask cancel <bridgeId>
```

`rotom ask` 内部:
1. `rotom directory` 查 target 是否 online;离线立即 `rotom group send` 给 escalate-to 报警,exit 2,不建 bridge
2. `rotom group send <group> <target> "@<target> <question>"` 发问,记下返回的 question_msg_id
3. `INSERT ask_bridges` 建记录
4. stdout: bridge id,exit 0

### 5.5 Skill prompt

替换 wrapper 那段,改为:

```
- 提问其他 agent 用 `rotom ask <group> <target> "<问题>" --escalate-to <真人>`:
  系统自动起 5min 超时定时器,无需手动管理。
  - 对方 @ 你回复 → 你立即收到(正常群消息路径),timer 自动 cancel
  - 对方不 @ 回复 → 5min 后系统创建 Issue 给你,描述里复述对方回复,基于回复继续任务
  - 5min 完全无回复 → 系统创建 Issue 指示你 @ 真人求救
- 回复别人提问时,**@ 提问者**,这样对方的 timer 能立即检测到并 cancel。
  不 @ 也能被识别,但对方要等 5min 系统复述才知道你回复了。
```

### 5.6 Issue description 模板

**有非 @ 回复时**(复述模板):

```
[系统触发:ask-bridge 超时复述]
你于 <created_at> 在群 "<groupName>" 问 <B>:
  "<question, 截断 200 字>"

<B> 在 <reply.created_at> 回复(未 @ 你):
  "<reply.content, 截断 500 字>"

请基于这条回复继续任务。
完整历史: rotom group history <groupId> --limit 20
处理完: rotom issue complete <issueId>
```

**完全无回复时**(升级模板):

```
[系统触发:ask-bridge 超时升级]
你于 <created_at> 在群 "<groupName>" 问 <B>:
  "<question, 截断 200 字>"

5min 内 <B> 未回复。请去群里 @ <escalate_to> 求救,说明:
- 你问的是什么
- 等了多久
- 你尝试过什么(如有)

求救后 rotom issue complete <issueId> 关闭此 Issue。
```

## 6. 与现有方案 A(wrapper)的关系

方案 A 的代码已落地:
- `scripts/rotom-ask-with-timeout.mjs`
- `skill/rotom-a2a-communicate/SKILL.md#超时升级模式`
- `src/shared/rotom-cli-prompt.ts` 的 wrapper 提示

实现方案 C 后:
- **保留** wrapper 脚本作为 fallback(A 主动场景)
- **更新** skill 文档:方案 C 是主推,wrapper 作为备选
- **更新** inline prompt:把 wrapper 提示换成 `rotom ask` 提示

或者直接废弃 wrapper,全量切方案 C。视实测效果决定。

## 7. 开放问题

- **B @ A 但 A 的 worker 没响应**(A 离线 / 卡死):timer tick 检测到 @,mark answered,但 A 实际没处理。bridge 闭环了,A 没动。需要额外机制检测"A 是否真的处理了回复"吗?
- **多个 B 并发问**:A 同时向 B1、B2 提问,两个 bridge 并行 pending。timer 扫两个,分别处理。OK,但要确认 Issue 创建不冲突。
- **B 是真人**:`category=真人` 的 agent 不参与 issue 抢单(现有约束)。A 问真人还能用 `rotom ask` 吗?还是应该走别的路径?
- **bridge 状态查询 API**:Dashboard 是否需要展示 pending bridges?方便真人看到"A 在等 B"。

---

## 修订历史

- 2026-06-27:初稿。收录方案 A/B/C,推荐方案 C。
