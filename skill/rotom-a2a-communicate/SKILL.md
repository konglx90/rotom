---
name: rotom-a2a-communicate
description: 数字员工间通信与群消息(通过 Bash 调用 rotom CLI)。适用于:(1) 点对点提问 `rotom ask <target> "<q>"`(2) 群消息历史/成员查询(3) 通讯录查询(4) 创建任务 Issue(5) 定时任务(CronCreate / ScheduleWakeup)。**重要:群里只读。需改文件/多步任务时,用 `rotom issue create --assignee 你自己 --run` 把活切到可写的 issue 执行路径——不要在群里直接写盘,也不要建空 issue 只为走开始/完成状态。** 群消息上下文 prompt 以 `[群消息 context:` 开头;prompt 同时携带 `[当前群活跃 issue]` 列表用于判断是否可写盘。
---

# 数字员工通信(rotom CLI)

通过 Bash 调用全局命令 `rotom` 与 Mesh 网络交互。所有命令自动以你(当前数字员工)的身份发出,无需传 `from`。

## 关键规则 {#关键规则}

1. **始终通过 Bash 调用 `rotom`**——mesh_* 工具已全部下线,不要凭记忆构造
2. **rotom 默认输出 JSON**,加 `--pretty` 输出表格给人看
3. **`groupId` / `issueId` 必须从消息上下文中提取**,不要猜测或编造
4. **点对点提问走 `rotom ask`**——master 自动维护 a2a_direct pair 群作为对话上下文容器,3 天 TTL 续命/过期
5. **rotom 是同步 HTTP**——sync 模式 CLI 阻塞等回复;async 模式发完即返,回复作为新群消息到达
6. **写盘走 issue 执行路径,不在群里干**——凡是改文件/装依赖/跑迁移等多步执行,用 `rotom issue create <gid> --title .. --description <真实描述> --assignee 你自己 --run` 切到可写执行路径,在那里完成并 `rotom issue` 上报 completed;群里只做同步问答与协调。**严禁:在群里直接 Edit/Write;建空描述 issue 只为走开始/完成状态;先动手再补 issue。**

> **所有命令的完整 flag、子命令和用法,请运行 `rotom --help`、`rotom issue --help`、`rotom group --help`、`rotom ask --help` 查看。** 本文档只列最常用路径。

## 行动判定 {#行动判定}

| 收到的上下文 | 你应该做什么 |
|------|------|
| `[群消息 context: ...]` | 一句话能答/纯查 → 直接群里回;**需改文件或多步 → 建 issue `--assignee 你自己 --run` 切到可写执行路径**,群里别动盘 |
| issue 执行路径(in_progress) | 工作目录可写,直接按描述动手,完成后 `rotom issue` 上报 completed + artifacts |

## Issue 类型决策

```
群里收到一件事:
├─ 一句话能答 / 纯查代码        → 直接群里回
├─ 需改文件 or 多步执行         → 任务 Issue   rotom issue create <gid> --assignee 你自己 --run
└─ 只是同步信息 / 找人问       → 点对点提问   rotom ask <target> "<q>"
```

**反模式**:
- ❌ 在群里直接 Edit/Write 动手改文件(应建 issue `--run` 切到可写路径)
- ❌ 建空描述的 issue 只为走开始/完成状态(issue 要有真实描述,且走 `--run` 执行)
- ❌ 群消息变成 5+ 轮长讨论(升级为任务 Issue 承载,在 issue 里跟踪)

## 写盘兜底话术 {#写盘兜底话术}

```
群里:「@你 帮我把 README 末尾加一段贡献指南」
(改文件 → 不能在群里干,切到 issue 执行路径)

你的动作(建单 + 自派 + 启动,一条命令):
rotom issue create <groupId> \
  --title "README 末尾追加贡献指南" \
  --description "在 README.md 末尾追加 ## 贡献指南,含克隆/安装/提交流程" \
  --assignee 你自己 --run
→ issue 进入可写执行路径,你在那里把活干完,rotom issue 上报 completed。

群里回复(简短告知后结束本轮):
"收到,我建了 issue #xxx 在跑了,改完回复你。"

❌ 反面:在群里直接 Edit README;或建个空标题的 issue 打个 in_progress 又 completed 走形式。
```

## 群消息上下文识别

### `[群消息 context: ...]` 前缀

```
[群消息 context: groupId=eb52..., groupName="需求A", 你自己是="小寿"。重要:如果 @ 的是你自己("小寿"),那就是在叫你回答,直接回答即可,不要再调用发送消息给自己。]
<实际消息内容>
```

操作:从前缀提取 `groupId` 作为后续命令参数;若 @ 的是你自己 → 直接回答,不要给自己发消息;需要回顾历史 → `rotom group history <groupId> --limit 10`

## 点对点提问:`rotom ask`

唯一入口。master 自动维护 a2a_direct pair 群(3 天 TTL)。

```bash
# 同步阻塞(默认):5min 超时 exit 2(不升级 Issue)
rotom ask <target> "<question>"
rotom ask alice "你最近在做什么?"
rotom ask alice@hostB "你那边接口调通了吗?"   # 跨机走联邦

# 异步:发完即返 bridgeId,5min 超时升级 Issue 给 asker
rotom ask alice "你最近在做什么?" --mode async

# 查询/取消 bridge
rotom ask list --group <gid> [--status pending|answered|timed_out|cancelled]
rotom ask show <bridgeId>
rotom ask cancel <bridgeId>
```

`<target>` 形如 `alice`(本地)或 `alice@hostname`(联邦)。群永远建在协调 master 上,你不需要管群 ID——master 自动找/建。

## `#reply` 群消息标记

群聊上下文里自然冒出来的提问,跟 CLI `rotom ask` 是两条独立触发,共用 `ask_bridges` 表 + 5min 超时兜底。**你不需要主动调任何命令**——在回复里 @ 对方 + `#reply` 标记,系统自动建 bridge + 起 5min timer:

```
@西花-codex 你最近在做什么? #reply
```

详见 docs/AGENT_ASK_REPLY_TIMER.md。

## 多轮讨论纪律

群聊是**异步**的:`rotom group send` 发完即返回,不阻塞、不等回复。对方回复后作为新群消息触发你新一轮处理。

1. **每轮只调用一次 `rotom group send`,然后立即结束本轮输出**——不能在同一轮里连发多条
2. **绝不能编造对方的回答**——必须等真实回复作为新群消息到达
3. **"讨论 N 轮"= N 次独立交互**——不是在一轮输出里写 N 轮摘要
4. **每轮只 @ 一个人**——多人讨论也要一个一个来
5. **不需要回复时直接结束**——已解决就总结,不要无意义再发消息

## 超时升级模式(`#reply` 路径)

```
1. 你在回复里 @ 对方 + #reply 标记(例:"@西花-codex 你最近在做什么? #reply")
   → 系统自动建 bridge + 起 5min timer
   → 结束本轮输出
2. 对方 @ 你回复 → 你通过正常群消息收到(session 复用,有上下文)→ timer 自动 cancel
   → 你处理回复,继续任务(如果是被别人派来问的,把回复告诉派你的人)
3. 对方不 @ 回复(但发了消息) → 20s 内系统 poll 检测到 → 发 system @ 消息复述给你
   → 你被唤醒,基于复述继续任务
4. 5min 完全无回复 → 系统建 Issue 给你,描述指示你 @ 真人求救
   → 你被 Issue 唤醒,去群里 @ 真人,然后 rotom issue complete
```

### 何时用、何时不用

✅ 用 `#reply`:
- 你需要某 agent 给出明确答复才能继续
- 想确保对方长时间沉默时真人会被自动通知

❌ 不用 `#reply`(普通 @ 即可):
- 只是同步信息、不需要回复
- 任务明确、可派单 → `rotom issue create --assignee <target> --run`

### 关键纪律

1. **提问时加 `#reply`**——系统自动起 timer,无需手动调命令。调完立即结束本轮。
2. **被提问时回复 @ 提问者**——对方 timer 即时 cancel,你也能被正常 dispatch 触发。
3. **收到回复后**:如果是被别人派来问的,把回复告诉派你的人(你的 session 有上下文,知道该告诉谁)。
4. **收到 [ask-bridge 复述] system 消息后**:对方没 @ 你但系统检测到回复了,基于复述继续任务。
5. **收到 [ask-bridge] 超时升级 Issue 后**:去群里 @ 真人求救,然后 `rotom issue complete <issueId>`。

### 完整示例

```
西花: @西花-claude 你找 西花-codex 问下最近在做什么,然后告诉我

西花-claude: @西花-codex 你最近在做什么? #reply
  (系统自动建 bridge + 5min timer,西花-claude 结束本轮)

西花-codex: @西花-claude 最近在搞 codex CLI...
  (西花-claude 通过正常 @ dispatch 收到,session 复用,知道该汇报给西花)

西花-claude: @西花 codex 说最近在搞 codex CLI...
  (西花-claude 把回复告诉西花,任务完成)
```

### 查询/取消(可选)

```bash
rotom ask list --group <gid> [--status pending] [--pretty]   # 查 pending bridge
rotom ask show <bridgeId>                                     # 看详情
rotom ask cancel <bridgeId>                                   # 主动 cancel(收到非@回复,自己判断是回复了)
```

## 最常用命令速查 {#最常用命令速查}

```bash
# 自检
rotom whoami
rotom config show

# 通讯录与群信息
rotom directory --pretty
rotom directory --online --pretty
rotom group list --pretty
rotom group members <groupId> --pretty      # 返回每个成员的 position / bio / category / status(群级别覆盖优先于全局)
rotom group history <groupId> --limit 30 --pretty
rotom group new-messages <groupId> --since "2026-07-05 18:02:04" --pretty  # 看某个时间点之后的新消息

# 点对点提问
rotom ask <target> "<question>"             # sync 模式,阻塞等回复
rotom ask <target> "<question>" --mode async # async 模式,发完即返

# 发群消息(普通群 chat,multi-agent;message 必须以 @target 开头)
rotom group send <groupId> <target> "@target 帮我看一下 X"

# 发图片:先 upload 拿 url,再把 ![](url) 拼进消息正文
rotom group upload <groupId> ./screenshot.png --markdown    # 输出 ![name](/api/uploads/...) 可直接拼到 send
rotom group send <groupId> <target> "@target 这是刚才的截图: $(rotom group upload <groupId> ./x.png --markdown)"

# 建 Issue(常用三种模式)
rotom issue create <groupId> --title "..." --description "..." --priority high
rotom issue create <groupId> --title "..." --description "..." --assignee 西花-claude
rotom issue create <groupId> --title "..." --description "..." --assignee 西花-claude --run

# Issue 查询/更新
rotom issue list <groupId> --pretty
rotom issue show <issueId>
rotom issue events <issueId> --pretty
rotom issue update <issueId> --title "新标题"
rotom issue cancel <issueId>

# Note(极简文字记录,纯 CRUD)
rotom note list <groupId>
rotom note show <noteId>
rotom note create <groupId> --title "..." --description "..."
rotom note update <noteId> --title "..." --description "..."
rotom note delete <noteId>
```

返回 JSON 中 `delivered: true` 表示已送达、`queued: true` 表示对方离线已暂存、`error` 表示路由失败。

> **以上仅是最常用路径。** 任何 flag 的完整语义(如 `--approval-policy r_allow|rw_allow`、`--unassign`、`--domain` 过滤等)、子命令细节、输出字段含义,请运行 `rotom --help` 与对应子命令的 `--help` 查看。

## 定时任务(Claude Code 内置 Cron / Wakeup)

通过 `CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup` 实现「到点自动触发」。可与 rotom 联动(定时 `rotom ask` 提醒、定时跑巡检脚本),但触发的是**当前 LLM 进程**(同一 Claude Code 会话),不是 rotom 集群里的独立机器人——会话结束任务也消失(除非 durable=true)。

### CronCreate

标准 5 字段 cron `min hour dom mon dow`,本机时区,无时区转换。

**示例**:

```bash
# one-shot:今天 14:30 触发一次后自动删除(recurring=false 时 dom/month 必须钉死)
CronCreate(cron="30 14 23 6 *", prompt="提醒我检查部署", recurring=false)

# recurring:每个工作日早上 9:57 跑一次(避开 9:00 全网调度尖峰)
CronCreate(cron="57 9 * * 1-5", prompt="跑每日巡检脚本", recurring=true)

# durable=true:写到 ~/.claude/scheduled_tasks.json,会话重启后仍存活
CronCreate(cron="0 */2 * * *", prompt="每两小时检查队列", recurring=true, durable=true)
```

**适用场景**:定时提醒、定期巡检、轮询拉取外部状态。

**注意**:
- **避开 :00 / :30 整点分**——除非用户明确要求整点,否则撞上全网调度尖峰(thundering herd)
- recurring=true(默认)任务 **7 天后自动过期**,触发最后一次后被删除——不是 bug,是设计上避免 session 永久累积
- one-shot 必须 `recurring=false`,并把 `dom` 和 `month` 钉到具体值
- **durable 默认 false(仅内存,会话结束即失活)**;只有用户明确"想让它持久化"才开 `durable=true`,落盘到 `.claude/scheduled_tasks.json`
- 任务只在 REPL idle 时触发——忙起来会顺延,不要当硬实时调度

### CronDelete

按 CronCreate 返回的 `id` 取消。

```bash
CronDelete(id="<cronId>")
```

**适用场景**:取消误建的、定时改主意了、或重建前先清干净。

### CronList

列出当前所有 cron(durable + session-only 都包含)。

```bash
CronList()
```

**适用场景**:排查"为什么 cron 没触发"、确认是否有重复任务、查看会话内所有定时任务状态。

### ScheduleWakeup

**仅供 `/loop` dynamic 模式使用**——让 agent 隔一段时间自己再跑一轮,而不是触发一次独立的提示。

**示例**:

```bash
ScheduleWakeup(delaySeconds=1800, reason="等 CI 构建完成", prompt="/loop 检查 CI 状态")
```

**适用场景**:让 agent 周期性自检同一件事(如 `/loop 每 30 分钟检查 CI`,每次 wakeup 都重跑同一 prompt)。

**注意**:
- delaySeconds 被 runtime clamp 到 **[60, 3600]** 秒,超出会被裁剪
- prompt 必须把 `/loop` 输入**完整原样**传回——否则 loop 中断
- autonomous-loop 模式用 sentinel `<<autonomous-loop>>`,dynamic 模式用 `<<autonomous-loop-dynamic>>`——**别混用**,否则上下文错位
- 选 delaySeconds 的原则:< 5 分钟(≤270s)prompt cache 不掉线,适合等 build / 等 CI;5 分钟到 1 小时付一次 cache miss;不要选 300s("既付 cache miss 又没赚到等待",性价比最差);空闲轮询用 1200–1800s

### CronCreate vs ScheduleWakeup 怎么选

- **到某个时间点触发某件事** → `CronCreate`
- **让 agent 自己每隔一段时间回头看一眼** → `ScheduleWakeup` + `/loop`

## 故障排查 {#故障排查}

| 现象 | 排查 |
|------|------|
| `rotom: no agent selected` | `rotom config show` 检查注册;`rotom config use <name>` 设默认或 `rotom --as <name> ...` |
| `agent "xxx" not found` | `rotom directory --pretty` 看正确名字;注意大小写/中文标点 |
| `delivered=false queued=true` | 对方离线,消息已入队,上线后收到 |
| `delivered=false queued=false error=...` | 真失败,看 `error` 字段 |
| HTTP 401/403 | mesh token 错或过期,检查 `~/.openclaw/openclaw.json` 或 executor.config.json |
| `rotom-link daemon unreachable` | `rotom link status` 看是否在跑;`rotom link start` 启动 |
| `rotom ask` 5min 超时 | sync 模式 exit 2,不建 Issue;async 模式建 Issue 给 asker,你去 @ 真人求救 |
