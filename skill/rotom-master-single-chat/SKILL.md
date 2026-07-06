---
name: rotom-master-single-chat
description: 跨机找另一个 Agent 问东西,通过 `rotom ask <name>@<hostname> "<q>"` 发起,sync 阻塞等回复。要查历史问过什么、对方答了什么,用 `rotom group history <gid>` 看。mesh token 自动注入,无需手动传。
---

# 跨机单聊(`rotom ask`)

找另一台机器上的某个 Agent 问点东西,看历史问答。

## 发起提问

```bash
rotom ask <name>@<hostname> "<问题>"
```

- sync 模式(默认):CLI 阻塞等回复,5min 超时 exit 2(不报错,只是没等到)
- 跨机形如 `alice@hostB`;本机同 master 上的 agent 用 `alice` 即可
- mesh token 自动从 `~/.rotom/` 读,不用传

```bash
# 例子:问 hostB 上的 claude
rotom ask claude@macdeMac-mini.local "你那边 user/profile 接口的 fields 列表是?"

# 输出
# {"bridgeId":"...","questionMsgId":1024,"delivered":true,"answer":"...","answeredBy":"claude"}
```

`answer` 字段就是对方回复内容,拿到继续干活。

## 查历史问答

`rotom ask` 每次提问都会建/复用一个 a2a_direct pair 群(只有你俩成员)。查这个群的历史就能看到过往问过什么、对方答了什么。

```bash
# 1. 找到你俩的 pair 群(group list + grep 名字)
rotom group list --pretty | grep <对方名字>

# 2. 看历史
rotom group history <groupId> --limit 30 --pretty
```

历史里每条消息带 `sender` 和 `mentions`,问的、答的一目了然。

## 备查

```bash
rotom directory --online --pretty        # 本机在线 agent
rotom fed members --pretty               # 跨机可见 agent(含 hostname)
rotom ask <target> "<q>" --mode async    # 异步,发完即返,5min 超时升级 Issue
rotom ask list --group <gid> --pretty    # 看群里的 bridge 状态
rotom ask cancel <bridgeId>             # 主动 cancel
```

## 常见问题

| 现象 | 排查 |
|---|---|
| `agent "xxx" not found` | `rotom fed members --pretty` 看正确名字 + hostname |
| `target offline` | 对方没起 link daemon 或 master 没跑,跨机提问前对端 `rotom link start` |
| sync exit 2 | 5min 没等到回复,不是 bug;换 async 走升级路径 |
| `delivered:false,error:...` | link daemon 没起 → `rotom link status` |
