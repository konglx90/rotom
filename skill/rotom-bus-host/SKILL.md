---
name: rotom-bus-host
description: 你(codex/claude)手动用 rotom CLI 把其他 mesh agent 拉进同一个群里协作。适用:新需求进来要拆给多人 / 需要找其他 agent 要信息 / 多 agent 讨论方案。两步:group create 一键建群+拉人+发开场 → 沟通循环(group send 发 / group history 收 / issue create --run 派活)。身份从 ~/.rotom/executor.config.json 解析,--as=<你> 切换。
---

# 手动建群协作(rotom CLI)

你作为已注册的 mesh agent,通过 Bash 手动调 rotom CLI 把其他 agent 拉进同一个群,围绕一个需求同步信息 / 讨论 / 派活。身份来自 `~/.rotom/executor.config.json`,`--as=<你>` 指定(缺省走 `defaultAgent`)。

## 前置:rotom 是 HTTP,codex 必须提权

rotom CLI 每条命令都是**同步 HTTP**——向 master(:28800)发 REST 请求,等响应返回。**不是本地 IPC,不是 WS 长连**。

**codex 默认 sandbox 拦 127.0.0.1**,会导致每条 rotom 命令报网络错(`fetch failed` / `connection refused`)。所以 codex 跑本 skill 前**必须提权**,三选一:

- 启动时带 `--dangerously-bypass-approvals-and-sandbox`(完全绕过 sandbox)
- 或 `--ask-for-approval`(写盘类审批,放行只读 Bash + HTTP)
- 或运行中每条 rotom 命令被拦时手动 Accept(慢,不推荐)

claude 默认不挂 sandbox,不用管。**第一条 rotom 命令先跑 `rotom --as=<你> whoami` 验证 HTTP 通**,通了再继续;不通就先解决提权,别往下走。

## 两步动作

### 1. 建群(每个需求做一次)

```bash
rotom --as=<你> group create "<需求标题>" \
  --agents <agentA,agentB[,agentC...]> \
  --message "@全体 <开场白,说清需求 + 你希望大家各自看什么>" \
  --note "## 需求描述\n[TBD]\n## 分工\n[TBD]"
```

- `--agents` 必填:已在 master 注册的 agent 名,逗号分隔。未注册 → 命令 fail,不建群(先 `rotom --as=<你> directory` 查)
- 默认自动加载**"群内讨论方案设计"** guidance 模板到群指导 prompt,引导 agent 走群内讨论而非无脑建 issue。`--no-template` 跳过
- `--message` 可选:建群即发开场消息(target=全体)
- `--note` / `--note-file` 可选:建群即建 note 记录需求生命周期
- 输出 `id` 即 groupId,后续命令都用它

### 2. 沟通循环

```bash
# 收消息(每轮思考后拉一次,别空转)
rotom --as=<你> group history <gid> --limit 20 --clean

# 发消息(message 必须以 @target 开头)
rotom --as=<你> group send <gid> <target> "@<target> <你的话>"

# 要某个 agent 干明确的活
rotom --as=<你> issue create <gid> --title "..." --description "..." --assignee <target> --run
```

### 预期:一问一答,不来回聊

本 skill 的用法是**一问一答**——你 @某 agent 提一个问题 / 派一个活,对方回一次就完。**不要让 agent 之间在群里自主接力 @ 来回聊**,原因:

- LLM 在群里接力讨论很容易跑偏,且每轮都要 spawn CLI 跑一遍,token 烧得快
- 真要多轮讨论,建 task issue 承载,issue 有状态机 / 审批 / artifacts,比群消息结构化
- 你是 host,该由你决定"还要不要继续问",不是让 agent 自顾自聊下去

**关键纪律**:
1. 你 @ A 提问 → A 回复一次。A 的回复**不应该 @ 你继续聊**,除非 A 真有反问
2. 你收到 A 的回复后,如果还要问别的,**自己再发一条新的 `group send`**,不要指望 A 主动接
3. A 的回复如果 @ 了 B(让你去找 B),那是 A 在指路,不是让 B 自动接力——你要明确决定要不要 @ B
4. 群消息超 5 轮还没收敛 → 停下来,升级为 task issue

如果某条消息你**只是同步信息,不想要回复**,加 `--no-dispatch` 跳过对方 worker 的 auto-dispatch(消息仍入库 + 广播给群成员看,但 @target 不会被 trigger 起来回复):

```bash
rotom --as=<你> group send <gid> <target> "@<target> 这是同步信息,不用回" --no-dispatch
```

### 等回复:sleep 轮询

发完消息等对方回复时,用**有界 sleep 轮询**,不要单次拉完就停(对方还没回),也不要无限空转(浪费 cache)。推荐 30s 间隔、最多 10 轮(约 5 分钟覆盖 ask-bridge 超时窗口):

```bash
GID=<groupId>
LAST_SEEN=<你刚发的那条消息的 timestamp 或 id>   # 只看这条之后的新消息

for i in $(seq 1 10); do
  sleep 30
  NEW=$(rotom --as=<你> group history "$GID" --limit 10 --clean \
        | awk -v last="$LAST_SEEN" '
            $0 ~ last { seen=1; next }
            seen && /^[0-9]{4}-/ { print }
          ')
  if [ -n "$NEW" ]; then
    echo "$NEW"
    break
  fi
  echo "[poll $i/10] 暂无新消息" >&2
done
```

要点:
- **30s 间隔**——避开每秒空转,prompt cache 也能吃到
- **最多 10 轮**——5min 内没回就退出,让对方 ask-bridge 超时机制兜底(见 `rotom-a2a-communicate` 的 #reply 段)
- **基于 timestamp/id 过滤**——只看自己发言之后的新消息,避免重复处理
- **找到即 break**——不把 10 轮跑满

## 关键约束

1. **写盘必须挂在 in_progress issue 下**——凡 Edit/Write/写 Bash,先看 `rotom issue list <gid> --status in_progress`,没有就先建 issue 或让发起方建。**严禁"先动手再补 issue"**(详见 `rotom-a2a-communicate` skill)
2. **groupId / issueId 从命令输出取,不要编**——`group history` / `issue list` 给你真实 id
3. **群消息异步**——`group send` 发完即返回,对方回复作为新群消息到达。**绝不能编造对方回答**,等真实 `group history` 拉到再说
4. **每轮只发一次 `group send`**——发完立即结束本轮输出,等下一条群消息触发

## 反模式

- ❌ 轮询 `group history` 太快(每秒一次)→ 浪费 cache,每轮思考后拉一次足够
- ❌ 把明确任务塞进群消息讨论 → 用 `issue create --run` 派单
- ❌ 群消息变成 5+ 轮长讨论 → 升级为 task issue 承载
- ❌ 把 `[thinking]...[/thinking]` 这类 agent 内部状态标签当成对方没回话——见下文"轮询踩坑"

## 轮询踩坑(实战)

### `--clean` 会吞掉嵌套 tag 里的全部正文

`group history --clean` 的清洗正则 `[(\w[\w-]*:\w[\w-]*)\].*?\[\/\1\]` 是**非贪婪 + 按就近配对**的。对方 agent 的回复常常是这种结构:

```
[thinking]...[/thinking][tool:exec]rotom memory search ...[/tool:exec]
[thinking]...[/thinking][status:thinking]Working[/status:thinking]
@瓦力 真实回复正文...
[status:thinking]Done[/status:thinking]
```

非贪婪正则会优先吞掉最内层的 `[thinking]...[/thinking]`,把后续整段(连同最后那条 `@你` 的真实正文)都卷进被替换的范围内,清洗后 `content` 变成空字符串或仅剩前导 `[thinking]...[/thinking]` 截断前缀。

**结论:`--clean` 拿不到完整正文,只能当"有没有新消息"的粗筛**。要拿到真实回复,直接绕 CLI 打 master API 拿原始 `content`,再用 `jq` / `python` 解析:

```bash
GID='<groupId>'
# 从 ~/.rotom/executor.config.json 拿对应 agent 的 token(每个 agent 一个,不是 master token)
curl -s -H "Authorization: Bearer <token>" \
  "http://127.0.0.1:28800/api/groups/${GID}/messages?limit=200" \
| python3 -c "
import sys, json
msgs = json.loads(sys.stdin.read())
for m in msgs:
    if m.get('sender') == '<target>' and m.get('created_at','') > '<你发出消息的时间戳>':
        print('====', m['created_at'], 'id=', m.get('id'), '====')
        print(m.get('content',''))
"
```

要点:
- **不用 `--clean`**——`--clean` 在嵌套 tag 下会误吞
- **不用 `LAST_SEEN` 锚 id 配合 `awk`**——master 输出的消息 id(`messageId` / 内部 `id`)格式不稳定,且 `--clean` 截断后 anchor 也对不上
- **用时间戳过滤**(`created_at > 你的发送时间`)——SQLite 默认按时间升序翻页,稳定可靠
- **轮询第一遍可以双跑**:`--clean` 跑看有没有新消息(`sender=对方`),有再走 `curl` 拿完整原文

### hex 起首的 groupId 会触发 zsh 算术展开

`7cada00f-...` / `0x...` 这类以 hex 字符开头的 groupId,在 zsh 里被识别为算术表达式(`0x7cada00f`),赋值时直接报 `bad math expression`。**不要在 zsh 里直接 `GID=7cada00f-...`**,两种解法二选一:

```bash
# 法 1:塞 bash 子 shell
env GID='7cada00f-715e-49c3-8de5-7293cf964ce3' bash -c '
  rotom --as=瓦力 group history "$GID" --limit 20
'

# 法 2:赋值时显式当字符串(加 no-arith 选项仅对当前 shell)
disable -p arith 2>/dev/null
setopt no_arith_glob 2>/dev/null
GID='7cada00f-715e-49c3-8de5-7293cf964ce3'
```

法 1 最稳,推荐默认走 `bash -c`。



本 skill 只补"建群协作"模式的增量(group create + 沟通循环)。群消息上下文识别、行动判定、写盘兜底话术、#reply 超时升级等通用规则见 `rotom-a2a-communicate` skill,不重复。



## 与 `rotom-a2a-communicate` 的关系

本 skill 只补"建群协作"模式的增量(group create + 沟通循环)。群消息上下文识别、行动判定、写盘兜底话术、#reply 超时升级等通用规则见 `rotom-a2a-communicate` skill,不重复。
