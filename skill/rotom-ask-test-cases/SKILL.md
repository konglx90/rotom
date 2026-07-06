---
name: rotom-ask-test-cases
description: 工作流里需要测试用例时,直接 `rotom ask claude@30.249.225.150 "需求是：XXX，给我生成测试用例"` 跨机找测试 Agent 要。sync 模式阻塞等回复,拿到就用。要看历史问过什么、对方答了什么,`rotom group history <gid>`。包含 rotom 安装 + 跨机 link 接入一次性准备步骤。
---

# 找测试 Agent 要测试用例

工作流跑到"需要测试用例"那一步,跨机问 `30.249.225.150` 上的 claude 要。

## 0. 一次性准备(每台机器一次)

### 安装 rotom

```bash
npm i -g @konglx/rotom
```

装完 PATH 里多两个命令:`mesh-master` 和 `rotom`。本地 loopback 场景**不需要 mesh_token**。

### 接入协调 master(跨机必须)

跨机提问前,本机要先 `link join` 一次拿到 masterId,然后起 link daemon。

```bash
# 一次性:加入协调 master(地址 ws://30.249.225.150:28800)
rotom link join ws://30.249.225.150:28800 --hostname <本机hostname>

# 启动 link daemon(默认端口 28900,后台跑)
rotom link start

# 验证 daemon 健康
rotom link status

# 确认协调 master 同步来的可见 agent 列表里能看到 claude
rotom fed members --pretty
```

`--hostname <本机hostname>` 是本机在联邦里的标识,对方 `rotom ask <你>@<本机hostname>` 找你用。比如本机叫 `hostA` 就传 `hostA`。

**没装/没 link 的征兆**:`rotom ask claude@30.249.225.150 "..."` 直接报 `agent not found` 或 `target offline` → 跑上面三步。

## 1. 一句话调用

```bash
rotom ask claude@30.249.225.150 "需求是：XXX，给我生成测试用例"
```

把 `XXX` 换成你的需求描述。CLI 阻塞等回复(默认 5min),返回 JSON 里 `answer` 字段就是测试用例,拿到继续干活。

```json
{"bridgeId":"...","questionMsgId":1024,"delivered":true,"answer":"<测试用例正文>","answeredBy":"claude"}
```

## 提问模板

```bash
# 最简
rotom ask claude@30.249.225.150 "需求是：<需求描述>，给我生成测试用例"

# 带上下文(给测试 Agent 更多信息,用例更准)
rotom ask claude@30.249.225.150 "
需求是：<需求描述>
涉及模块：<模块名 / 文件路径>
关键约束：<边界 / 异常 / 性能要求>
给我生成测试用例,覆盖正常流程 + 边界 + 异常
"

# 等久一点
rotom ask claude@30.249.225.150 "需求是：XXX，给我生成测试用例" --timeout 10m

# 不想阻塞当前轮(5min 超时升级 Issue 通知你)
rotom ask claude@30.249.225.150 "需求是：XXX，给我生成测试用例" --mode async
```

## 查历史问答

每次提问都建/复用你们俩的 pair 群,看历史就知道以前问过什么、对方答了什么。

```bash
# 找到你跟 claude 的 pair 群
rotom group list --pretty | grep claude

# 看历史
rotom group history <groupId> --limit 30 --pretty
```

## 常见问题

| 现象 | 怎么办 |
|---|---|
| `agent "claude" not found` / `target offline` | 对端没起 link daemon 或 master 没跑,联系对端 `rotom link start` |
| sync 5min 超时 exit 2 | 没等到回复,不是 bug;加 `--timeout 10m` 或换 `--mode async` |
| `delivered:false,error:...` | 本机 link daemon 没起 → `rotom link status` |
| 想看 bridge 状态 | `rotom ask list --group <gid> --pretty` |
