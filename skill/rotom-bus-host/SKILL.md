---
name: rotom-bus-host
description: 你(codex/claude)作为 host 用 rotom CLI 把其他 mesh agent 拉进群,一问一答协作。group create 建群+拉人 → group send --need-reply 提问(自动补 @、master 硬剥回复里的 @asker 防 chatter)→ group new-messages --since 轮询新回复。身份从 ~/.rotom/executor.config.json 解析,--as=<你> 切换。
---

# 手动建群协作(rotom CLI)

你作为已注册的 mesh agent,通过 Bash 调 rotom CLI 把其他 agent 拉进群,围绕需求一问一答。身份来自 `~/.rotom/executor.config.json`,`--as=<你>` 指定(缺省走 `defaultAgent`)。

## 前置:codex 必须提权

rotom CLI 每条命令都是**同步 HTTP**(打 master :28800)。codex 默认 sandbox 拦 127.0.0.1,必须提权才能调通:

- 启动带 `--dangerously-bypass-approvals-and-sandbox`(完全绕过),或
- `--ask-for-approval`(写盘审批,HTTP 放行)

claude 不挂 sandbox,跳过。**第一条命令先 `rotom --as=<你> whoami` 验 HTTP 通**,不通先解决提权。

## 两步动作

### 1. 建群(每个需求做一次)

```bash
rotom --as=<你> group create "<需求标题>" \
  --agents <agentA,agentB[,agentC...]> \
  --message "@全体 <开场白>" \
  --note "## 需求\n[TBD]"
```

- `--agents` 必填:已注册 agent 名,逗号分隔(未注册 → fail,先 `rotom directory` 查)
- 默认自动加载"群内讨论方案设计"guidance 模板;`--no-template` 跳过
- 输出 `id` 即 groupId,后续命令都用它

### 2. 沟通循环(一问一答)

```bash
# 提问(need-reply:自动补 @target,回复里 @你 会被 master 硬剥掉,防 chatter)
rotom --as=<你> group send <gid> <target> "<你的问题>" --need-reply

# 轮询新回复(只看某个时间点之后的消息)
rotom --as=<你> group new-messages <gid> --since "2026-06-30 18:02:04"

# 看完整历史(回顾上下文用)
rotom --as=<你> group history <gid> --limit 20 --clean
```

**`--need-reply` 是核心**:它让 master 自动补 `@target` 到正文(确保对方 worker 起来),并登记 `requestId → asker`。对方回复时,master **硬剥掉 `@<asker>`** 再入库 + 广播——你的 worker 不会被回复触发,不会来回聊。

## 等回复:轮询脚本

发完 `--need-reply` 消息后,执行 `skill/rotom-bus-host/scripts/poll-replies.sh` 等回复。脚本默认 10 轮 × 30s = 5min,正好覆盖 ask-bridge 超时窗口。

```bash
bash skill/rotom-bus-host/scripts/poll-replies.sh <groupId> --as <你>

# 想拉长等或拉短间隔:
bash skill/rotom-bus-host/scripts/poll-replies.sh <groupId> --as <你> --max-rounds 20 --interval 15

# 已经记下 SINCE 时间(轮询起点),直接传:
bash skill/rotom-bus-host/scripts/poll-replies.sh <groupId> --as <你> --since "2026-06-30 18:02:04"
```

**关键点**(都内化进脚本了,不用在 SKILL.md 里现拼):

- **rotom 默认输出 JSON 不是表** —— 内层 `group history` / `group new-messages` 都强制 `--pretty`,否则输出是 `[{"time":"2026-06-29...",...}]`,`awk '{print $1,$2}'` 会抽到 `[{"time":"2026-06-29` 当 SINCE,整个轮询废了。脚本用 `grep -oE 'YYYY-MM-DD HH:MM:SS'` 抽日期(不依赖列位,JSON/表通吃),双保险。
- **空响应别 break** —— `new-messages` 即使无新消息也会输出表头(`time sender content`),直接 `[ -n "$NEW" ]` 会误判为"找到",提前退出。脚本通过 `grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}'` 计数实际数据行(匹配日期开头),表头/空表 = 0 行 → 继续轮询。
- **SINCE 默认值** —— 不传则用群里"最近一条消息的时间"作起点,避免从头拉到历史。
- **退出码** —— 找到数据 = 0;超时 = 2;参数错 = 1;rotom 调用失败 = 3。可以 `&& echo "got reply" || echo "timed out"` 接住。

如果脚本路径不便(比如当前 CWD 不是 repo 根),用绝对路径:

```bash
bash /Users/kong/ai-work/rotom/skill/rotom-bus-host/scripts/poll-replies.sh <groupId> --as <你>
```

## 关键约束

1. **写盘必须挂在 in_progress issue 下**——先 `rotom issue list <gid> --status in_progress`,没有就先建。严禁"先动手再补 issue"(详见 `rotom-a2a-communicate`)
2. **groupId / issueId 从命令输出取,不要编**
3. **群消息异步**——`group send` 发完即返回,对方回复作为新群消息到达。**绝不能编造对方回答**,等 `new-messages` 拉到再说
4. **每轮只发一次 `group send`**——发完立即结束本轮输出

## 反模式

- ❌ 轮询太快(每秒一次)→ 30s 间隔足够
- ❌ 把明确任务塞进群消息 → 用 `issue create --run` 派单
- ❌ 群消息 5+ 轮没收敛 → 升级为 task issue
- ❌ 不带 `--need-reply` 直接 `group send` → 正文没 `@target`,对方 worker SKIP,消息白发(除非你手动在正文里写 `@target`)

## 与 `rotom-a2a-communicate` 的关系

本 skill 只补"建群 + 一问一答"模式的增量。群消息上下文识别、行动判定、写盘兜底话术、#reply 超时升级等通用规则见 `rotom-a2a-communicate`,不重复。
