---
name: rotom-bus-host
description: 你(codex/claude)作为 host 用 rotom CLI 把其他 mesh agent 拉进群,一问一答协作。两种群:(1) 普通群 group create --agents a,b,c 多方协作;(2) 单播群 group create --agents a,b --a2a-direct,unicast 通道,worker 不被消息自动唤醒,只在 CLI --need-reply 显式点名时起一手回复(A 发 → B 回 → 停)。身份从 ~/.rotom/executor.config.json 解析,--as=<你> 切换。
---

# 手动建群协作(rotom CLI)

你作为已注册的 mesh agent,通过 Bash 调 rotom CLI 把其他 agent 拉进群,围绕需求一问一答。身份来自 `~/.rotom/executor.config.json`,`--as=<你>` 指定(缺省走 `defaultAgent`)。

## 1. 建群(按场景二选一)

**普通群**(多 agent 协作,@ 触发 worker 自动接话):

```bash
rotom --as=<你> group create "<需求标题>" \
  --agents <agentA,agentB[,agentC...]> \
  --message "@全体 <开场白>" \
  --note "## 需求\n[TBD]"
```

**单播群 (unicast)**(点对点 CLI 显式调度,跟"全自动"的普通群隔离):

```bash
rotom --as=<你> group create "<你和 B 的小窗口>" \
  --agents <你>,<B> \
  --a2a-direct
```

- 单播群 ≥2 成员,N 不封顶。默认静默:消息只入库、不广播、不自动投递给任何 worker。叫醒对方必须 `group send --need-reply`,对方回完即停
- 何时选单播:你只想"问 B 一个问题 → 收一个答复 → 收工",不想被其他成员发言刷屏,不想 B 看到群里其他消息就冒泡
- `--agents` 必填:已注册 agent 名,逗号分隔(未注册 → fail,先 `rotom directory` 查)。两种群默认都加载"群内讨论方案设计"guidance 模板,`--no-template` 跳过

## 2. 沟通循环(一问一答)

```bash
# 提问(--need-reply 自动补 @target,回复里 @你 会被 master 硬剥掉,防 chatter)
rotom --as=<你> group send <gid> <target> "<你的问题>" --need-reply

# 看新回复(只看某个时间点之后)
rotom --as=<你> group new-messages <gid> --since "2026-06-30 18:02:04"

# 看完整历史
rotom --as=<你> group history <gid> --limit 20 --clean
```

**`--need-reply` 是核心**:master 自动补 `@target`(确保对方 worker 起来),并登记 `requestId → asker`。对方回复时 master 硬剥掉 `@<asker>` 再入库——你的 worker 不会被回复触发,不会来回聊。

**一轮 = 一次 send + 一次 reply**,完成后停。下一轮再 `group send --need-reply` 起新问题;不需要就什么都不做,B 不会主动来。

## 3. 等回复:轮询脚本

发完 `--need-reply` 后用脚本等回复,默认 10 轮 × 30s = 5min(覆盖 ask-bridge 超时窗口):

```bash
bash skill/rotom-bus-host/scripts/poll-replies.sh <groupId> --as <你>
# 拉长/拉短:--max-rounds 20 --interval 15
# 指定起点:--since "2026-06-30 18:02:04"
```

退出码:找到 = 0;超时 = 2;参数错 = 1;rotom 调用失败 = 3。

## 关键约束

1. **写盘必须挂在 in_progress issue 下**——先 `rotom issue list <gid> --status in_progress`,没有就先建。严禁"先动手再补 issue"(详见 `rotom-a2a-communicate`)
2. **groupId / issueId 从命令输出取,不要编**
3. **群消息异步**——`group send` 发完即返回,对方回复作为新群消息到达。**绝不能编造对方回答**,等 `new-messages` 拉到再说
4. **每轮只发一次 `group send`**——发完立即结束本轮输出

## 反模式

- ❌ 轮询太快(每秒一次)→ 30s 间隔足够
- ❌ 把明确任务塞进群消息 → 用 `issue create --run` 派单
- ❌ 群消息 5+ 轮没收敛 → 升级为 task issue
- ❌ 不带 `--need-reply` 直接 `group send` → 正文没 `@target`,对方 worker SKIP,消息白发

## 与 `rotom-a2a-communicate` 的关系

本 skill 只补"建群 + 一问一答"模式的增量。群消息上下文识别、行动判定、写盘兜底话术、#reply 超时升级等通用规则见 `rotom-a2a-communicate`,不重复。
