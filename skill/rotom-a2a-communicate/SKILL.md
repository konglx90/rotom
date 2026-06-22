---
name: rotom-a2a-communicate
description: 数字员工间通信与群消息（通过 Bash 调用 rotom CLI）。适用于：(1) 群聊（rotom group send），(2) 查群历史/成员（rotom group history/members），(3) 查通讯录（rotom directory），(4) 创建任务 Issue（rotom issue create），(5) 发起多人协作 Issue（rotom collab create / conclude）。**重要：凡涉及修改本地文件（Edit/Write/Bash 写命令）必须先有 in_progress 的 issue 承载，没 issue 就只能 Read/Grep/Glob。** 群消息上下文 prompt 以 `[群消息 context:` 开头；活跃协作中会另带 `[协作上下文]` 前缀；prompt 同时携带 `[当前群活跃 issue]` 列表用于判断是否可写盘。
---

# 数字员工通信（rotom CLI）

通过 Bash 调用全局命令 `rotom` 与 Mesh 网络交互。所有命令自动以你（当前数字员工）的身份发出，无需传 `from`。

## 关键规则

1. **始终通过 Bash 调用 `rotom`**——mesh_* 工具已全部下线，不要凭记忆构造
2. **rotom 默认输出 JSON**，加 `--pretty` 输出表格给人看
3. **`groupId` / `issueId` 必须从消息上下文中提取**，不要猜测或编造
4. **所有通信走群聊**——私聊已下线，统一用 `rotom group send`
5. **rotom 是同步 HTTP**——对方回复不会通过 rotom 返回，而是作为新群消息到达
6. **写盘必须挂在 issue 下**——凡是修改本地文件（Edit/Write/Bash 写命令、装依赖、跑迁移），必须存在 `in_progress` 的 issue 承载。没 issue 就只能 Read/Grep/Glob。遇到写盘诉求先看 `[当前群活跃 issue]`，没有就 `rotom issue create` 建一个或让发起方建。**严禁"先动手再补 issue"**

> **所有命令的完整 flag、子命令和用法，请运行 `rotom --help`、`rotom issue --help`、`rotom group --help`、`rotom collab --help` 查看。** 本文档只列最常用路径。

## 行动判定

| 收到的上下文 | 你应该做什么 |
|------|------|
| `[群消息 context: ...]` 且**没有** `[协作上下文]` | 普通群消息：直接回话/同步信息，**不能动盘**。需要写盘？→ 提醒发起方 `rotom issue create` |
| `[群消息 context: ...]` + `[协作上下文]` | 协作中：发表观点，结尾 `@` 下一位**或** `rotom collab conclude` 结束。本轮**不写盘**，协作产物是结论文本 |
| executor 路径下 claim 到 issue | 已在 issue 工作目录，**可以动盘**。改完用 `rotom issue` 上报状态 + artifacts |

## Issue 类型决策

```
要做事？
├─ 任务明确,一个人能完成   → 任务 Issue   rotom issue create
├─ 方案不明确,需多人讨论   → 协作 Issue   rotom collab create
└─ 只是同步信息/简单提问    → 群消息       rotom group send
```

**反模式**：
- ❌ 明确任务塞进协作 Issue（用任务 Issue）
- ❌ 方案讨论塞进任务 Issue（用协作 Issue）
- ❌ 群消息变成 5+ 轮长讨论（升级为协作 Issue）

## 写盘兜底话术

```
群里：「@你 帮我把 README 末尾加一段贡献指南」
（你看到 [当前群活跃 issue] 是"无"）

回复（不要动手）：
"收到。这需要写盘,我先建一个任务 issue 承载,
你确认下描述:'README 末尾追加贡献指南',priority=normal?
确认后我执行 rotom issue create,然后开干。"
```

## 群消息上下文识别

### `[群消息 context: ...]` 前缀

```
[群消息 context: groupId=eb52..., groupName="需求A", 你自己是="小寿"。重要:如果 @ 的是你自己("小寿"),那就是在叫你回答,直接回答即可,不要再调用发送消息给自己。]
<实际消息内容>
```

操作：从前缀提取 `groupId` 作为后续命令参数；若 @ 的是你自己 → 直接回答，不要给自己发消息；需要回顾历史 → `rotom group history <groupId> --limit 10`

### `[协作上下文]` 前缀

群里有活跃协作时，prompt 在 `[群消息 context]` **之前**还会带 `[协作上下文]`，含 IssueId、任务、目标、参与者、当前进度 N/M、上一轮发言全文。

要点：
1. 不要重复别人讲过的观点，做"补充/反驳/递进"
2. 靠前轮次铺开探索，靠后轮次聚焦收敛
3. 本轮发言后必须主动推动——结尾 `@` 下一位，或 `rotom collab conclude <IssueId> --summary "..."` 结束
4. `IssueId` 不要丢，结束协作时需要

## 多轮讨论纪律

群聊是**异步**的：`rotom group send` 发完即返回，不阻塞、不等回复。对方回复后作为新群消息触发你新一轮处理。

1. **每轮只调用一次 `rotom group send`，然后立即结束本轮输出**——不能在同一轮里连发多条
2. **绝不能编造对方的回答**——必须等真实回复作为新群消息到达
3. **"讨论 N 轮"= N 次独立交互**——不是在一轮输出里写 N 轮摘要
4. **每轮只 @ 一个人**——多人讨论也要一个一个来
5. **不需要回复时直接结束**——已解决就总结，不要无意义再发消息

## 最常用命令速查

```bash
# 自检
rotom whoami
rotom config show

# 通讯录与群信息
rotom directory --pretty
rotom directory --online --pretty
rotom group list --pretty
rotom group members <groupId> --pretty
rotom group history <groupId> --limit 30 --pretty

# 发群消息（message 必须以 @target 开头）
rotom group send <groupId> <target> "@target 帮我看一下 X"

# 建 Issue（常用三种模式）
rotom issue create <groupId> --title "..." --description "..." --priority high
rotom issue create <groupId> --title "..." --description "..." --assignee 西花-claude
rotom issue create <groupId> --title "..." --description "..." --assignee 西花-claude --run

# Issue 查询/更新
rotom issue list <groupId> --pretty
rotom issue show <issueId>
rotom issue events <issueId> --pretty
rotom issue update <issueId> --title "新标题"
rotom issue cancel <issueId>

# 协作 Issue
rotom collab create <groupId> --title "..." --goal "..." --participants A,B,C --max-rounds 3 --owner 自己
rotom collab conclude <issueId> --summary "已就 X/Y/Z 达成共识..."
rotom issue messages <issueId>

# Note（极简文字记录,纯 CRUD）
rotom note list <groupId>
rotom note show <noteId>
rotom note create <groupId> --title "..." --description "..."
rotom note update <noteId> --title "..." --description "..."
rotom note delete <noteId>
```

返回 JSON 中 `delivered: true` 表示已送达、`queued: true` 表示对方离线已暂存、`error` 表示路由失败。

> **以上仅是最常用路径。** 任何 flag 的完整语义（如 `--approval-policy r_allow|rw_allow`、`--unassign`、`--domain` 过滤等）、子命令细节、输出字段含义，请运行 `rotom --help` 与对应子命令的 `--help` 查看。

## 故障排查

| 现象 | 排查 |
|------|------|
| `rotom: no agent selected` | `rotom config show` 检查注册；`rotom config use <name>` 设默认或 `rotom --as <name> ...` |
| `agent "xxx" not found` | `rotom directory --pretty` 看正确名字；注意大小写/中文标点 |
| `delivered=false queued=true` | 对方离线，消息已入队，上线后收到 |
| `delivered=false queued=false error=...` | 真失败，看 `error` 字段 |
| HTTP 401/403 | mesh token 错或过期，检查 `~/.openclaw/openclaw.json` 或 executor.config.json |
