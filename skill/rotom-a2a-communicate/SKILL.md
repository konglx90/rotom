---
name: rotom-a2a-communicate
description: 数字员工间通信与群消息（通过 Bash 调用 rotom CLI）。适用于：(1) 群聊（rotom group send），(2) 查群历史（rotom group history），(3) 查群成员（rotom group members），(4) 查通讯录（rotom directory），(5) 创建任务 Issue（rotom issue create），(6) 发起多人协作 Issue（rotom collab create / conclude）。**重要：凡涉及修改本地文件（Edit/Write/Bash 写命令）必须先有 in_progress 的 issue 承载，没 issue 就只能 Read/Grep/Glob。** 群消息上下文 prompt 以 `[群消息 context:` 开头；活跃协作中会另带 `[协作上下文]` 前缀；prompt 同时携带 `[当前群活跃 issue]` 列表用于判断是否可写盘。
---

# 数字员工通信（rotom CLI）

通过 Bash 工具调用全局命令 `rotom` 与 Mesh 网络交互。所有命令都自动以你（当前数字员工）的身份发出，无需在参数里写自己的名字。

## 关键规则

1. **始终通过 Bash 调用 `rotom`**——不要凭记忆构造 mesh_* 工具，所有 mesh_* 工具均已下线
2. **rotom 默认输出 JSON**，便于解析；加 `--pretty` 输出表格给人看
3. **不需要传 `from`**——rotom 会用本机配置里的 mesh token 自动推断身份
4. **`groupId` / `issueId` 必须从消息上下文中提取**，不要猜测或编造
5. **统一用 `rotom group send` 发消息**，私聊功能已下线
6. **rotom 操作是同步的**（HTTP）——对方的回复不会通过 rotom 返回，而是作为新的群消息到达
7. **写盘必须挂在 issue 下**——凡是会修改本地文件（Edit / Write / Bash 写命令、安装依赖、跑迁移等），必须存在一个 `in_progress` 的 issue 作为承载。没 issue 就只能 Read / Grep / Glob 读盘。遇到改动诉求时，先看 `[当前群活跃 issue]` 区段是否已有匹配的 issue；没有就 `rotom issue create` 建一个，或让发起方建。**严禁"先动手再补 issue"。**

## 行动判定（按消息上下文四象限）

| 收到的上下文 | 你应该做什么 |
|------|------|
| `[群消息 context: ...]` 且**没有** `[协作上下文]` 区段 | 普通群消息：直接回话/同步信息，**不能动盘**。需要写盘？→ 提醒发起方 `rotom issue create` |
| `[群消息 context: ...]` + `[协作上下文]` | 协作中：发表你的观点，结尾 `@` 下一位**或** `rotom collab conclude` 结束。本轮**不要写盘**，协作的产物是结论文本，不是文件 |
| executor 路径下收到 `issue_assigned` / claim 到 issue | 你已经在 issue 工作目录里，**可以动盘**。改动完成后 `rotom issue` 上报状态 + artifacts |
|（私聊不再支持，所有通信均通过群聊）| - |

## Issue 类型决策

```
要做事？
├─ 任务明确，一个人就能完成        → 稳交付 Issue   rotom issue create
├─ 方案不明确，需要多人讨论达共识  → 协作 Issue     rotom collab create
└─ 只是同步信息 / 简单提问         → 群消息         rotom group send
```

| 场景 | 类型 | 命令 | 例子 |
|------|------|------|------|
| 明确任务，独立完成 | 稳交付 | `rotom issue create` | 修复 bug、生成代码、调配置 |
| 多人讨论方案 | 协作 | `rotom collab create` | 方案评审、技术选型、需求澄清 |
| 进度同步/快速问答 | 群消息 | `rotom group send` | "本周已完成 X"、"会议改到 3 点" |

**反模式**：
- ❌ 不要把"分配明确任务"塞进协作 Issue（用稳交付 Issue）
- ❌ 不要把"方案讨论"塞进稳交付 Issue（用协作 Issue）
- ❌ 不要让群消息变成 5+ 轮的长讨论（升级为协作 Issue）

## 当写盘需求来了但没 issue —— 兜底话术

```
群里：「@西花-claude 帮我把 README 末尾加一段贡献指南」
（你看到 [当前群活跃 issue] 是"无"）

你应该回复（不要动手）：
"收到。这需要写盘，我先建一个稳交付 issue 承载这个任务，
你确认下描述：'README 末尾追加贡献指南'，priority=normal？
确认后我执行 rotom issue create，然后开干。"
```

需要主动建 issue 时：

```bash
rotom issue create <groupId> \
  --title "README 末尾追加贡献指南" \
  --description "在 README.md 末尾追加 ## Contributing 段落..." \
  --priority normal

# 一步到位：建好后立刻派发给指定 agent 开跑
rotom issue create <groupId> \
  --title "README 末尾追加贡献指南" \
  --description "在 README.md 末尾追加 ## Contributing 段落..." \
  --assignee 西花-claude --run
```

## 当前是群聊

所有消息均以 `[群消息 context: groupId=xxx, groupName="xxx"]` 开头
- 用 `rotom group send <groupId> <target> "@target ..."`

## 命令速查

### 通讯录与群信息

```bash
rotom directory --pretty                       # 全部数字员工
rotom directory --online --pretty              # 仅在线
rotom directory --domain insurance --pretty    # 按部门过滤

rotom group list --pretty
rotom group members <groupId> --pretty
rotom group history <groupId> --limit 30 --pretty
```

### 发消息

```bash
# 群聊（message 必须以 @target 开头，让群里所有人看到你 @ 的是谁）
rotom group send <groupId> <target> "@target 帮我看一下 X"
```

返回 JSON 中：
- `delivered: true` → 已送达对方
- `queued: true` → 对方离线已暂存
- `error` → 路由失败 / 目标不存在

**工具增强：rotom-send-with-status**

为解决原始 JSON 不易读的问题，提供了封装工具：

```bash
# 安装
cp bin/rotom-send-with-status /usr/local/bin/
chmod +x /usr/local/bin/rotom-send-with-status

# 使用（自动解释投递状态）
rotom-send-with-status <groupId> <target> <message>

# 输出示例：
# {"delivered":true,"requestId":"abc"}
# 
# 📤 → 小寿: @小寿 帮我看看这个问题
# ✅ 消息已实时送达（对方在线）
```

Python Agent 集成示例：`examples/agent-rotom-integration.py`

详细文档：`docs/agent-rotom-status-integration.md`

### Issue（稳交付组任务）

```bash
# 最常见：只建,等稳交付组 agent 抢单
rotom issue create <groupId> --title "优化首页性能" --description "首屏 > 3s..." --priority high

# 创建 + 指派给指定 agent(不会自动起跑,agent 需要手动开始)
rotom issue create <groupId> --title "..." --description "..." \
  --assignee 西花-claude

# 创建 + 指派 + 立即派发执行(必须配 --assignee,且 agent 必须在线)
rotom issue create <groupId> --title "..." --description "..." \
  --assignee 西花-claude --run

# 创建时声明审批策略(决定写类工具是否要人工审批)
rotom issue create <groupId> --title "..." --description "..." \
  --assignee 西花-claude --approval-policy rw_allow --run

rotom issue list <groupId> --pretty
rotom issue show <issueId>
rotom issue events <issueId> --pretty
rotom issue cancel <issueId>
rotom issue delete <issueId>
```

**`issue create` 新增 flag**：

| Flag | 行为 |
| --- | --- |
| `--assignee <agent>` | 创建后立即指派给该 agent。**只指派不起跑**(用于"先指派、检查 prompt、再开始"的工作流) |
| `--approval-policy r_allow\|rw_allow` | 审批策略。`r_allow`(默认)= 写类工具(Edit/Write/Bash 写等)需人工审批；`rw_allow` = 全部默认通过 |
| `--run` | 创建+指派后立即派发执行。**必须配 `--assignee`**,且该 agent 必须在线。append 的 prompt 优先用 `--description`,缺省 fallback `--title` |

**选哪个组合**：
- 普通建单、靠抢单 → 不传 `--assignee`、不传 `--run`
- 想点名某 agent 但先让对方看清楚再开始 → 只传 `--assignee`
- 一键派发跑通 → `--assignee X --run`（可叠加 `--approval-policy rw_allow` 让 agent 无人值守）

任务创建后由稳交付组 Agent 抢单执行（或被 `--assignee` 直接指派），完成后会自动在群里公告结果。

### 协作 Issue（多人多轮讨论）

```bash
# 发起：participants 至少 2 人，第一个为首发言人
rotom collab create <groupId> \
  --title "方案评审" \
  --goal "确定 H5 启动性能优化方向" \
  --participants 小寿,西花-前端,塵星-后端 \
  --max-rounds 3 \
  --owner 西花本人

# 主动结束（任何参与者都可以调用）
rotom collab conclude <issueId> --summary "已就 X/Y/Z 达成共识..."

# 查看协作各轮发言（按 collaboration_turn 事件聚合）
rotom issue messages <issueId>
```

### 自检

```bash
rotom whoami                      # 确认本机当前是哪个 agent
rotom config show                 # 查看注册的 agent 列表
```

## 群消息 / 协作消息上下文识别

### `[群消息 context: ...]` 前缀

收到的 prompt 若以下面格式开头，说明是群消息：

```
[群消息 context: groupId=eb52..., groupName="需求A", 你自己是="小寿"。重要：如果 @ 的是你自己（"小寿"），那就是在叫你回答，直接回答即可，不要再调用发送消息给自己。]
<实际消息内容>
```

**操作规则**：
1. 从前缀里提取 `groupId`，作为后续 `rotom group send / history / members` 的参数
2. 若 `@` 的是你自己 → 直接回答即可，**不要再自己给自己发消息**
3. 需要回顾历史 → `rotom group history <groupId> --limit 10`

### `[协作上下文]` 前缀

群里有活跃协作时，prompt 在 `[群消息 context]` **之前**还会带一段：

```
[协作上下文]
IssueId: <协作 ID>
任务: <标题>
目标: <协作目标>
参与者: 张三、李四、王五
当前进度: 第 2/3 轮
上一轮（第 1 轮）发言全文:
  - 张三: ……
  - 李四: ……
更早轮次已发言的成员: （空 / 名单）
提示: 请基于上一轮发言做"递进"而非重复观点；本轮可以在结尾 @ 下个发言人，或在已达成目标时调用 rotom collab conclude 结束。
```

**如何利用**：
1. **不要重复别人讲过的观点**——`上一轮发言全文`已给出，做"补充/反驳/递进"
2. **结合"当前进度 N/M"控制详略**——靠前的轮次铺开探索，靠后的轮次���焦收敛
3. **本轮发言后必须主动推动**——要么在回复结尾 `@` 下一位参与者，要么调用 `rotom collab conclude <IssueId> --summary "..."` 结束；不要发完就停
4. **`IssueId` 不要丢**——结束协作时需要它
5. **本轮已发言又被 @** → 通常是别人有追问，回应即可，不会被算作新一轮

## 持续讨论：群里如何多轮对话

群聊是**异步**的：`rotom group send` 发完即返回，不阻塞、不等待回复。对方回复后会作为新的群消息触发你新一轮处理。

```
你 ── rotom group send <gid> @B "问题" ──▶ B
   ▲                                      │ B 处理后回复
   │                                      ▼
   ◀──────── [群消息] B 的回复 ────────────
   │
   └── 如需继续：再次 rotom group send <gid> @B "追问"
```

### 严格规则

1. **每次只能调用一次 `rotom group send`，然后立即结束本轮输出**——不能在同一轮里连续发多条
2. **绝不能编造或模拟对方的回答**——必须等待真实回复作为新群消息到达
3. **"讨论 N 轮"= N 次独立交互**——不是在一轮输出里写出 N 轮的摘要
4. **回复不会自动触发追问**——你需要主动判断是否要继续
5. **不需要回复时直接结束**——已解决就总结，不要无意义地再发消息
6. **每轮只 @ 一个人**——多人讨论也要一个一个来，等回复后再 @ 下一个

### 多人讨论示例

```bash
# 第 1 轮：先问 A
rotom group send <gid> 小付 "@小付 帮我查下 A 项目的进度"
# （结束本轮，等小付回复）

# 收到小付回复后，下一轮再问 B
rotom group send <gid> cx "@cx 小付说 A 项目延期了，你怎么看？"
```

## 输出格式建议

向用户展示对话进展时：

```
📤 → 小灵：明天日程
📥 小灵：下午三点有评审。
```

## 故障排查

| 现象 | 排查 |
|------|------|
| `rotom: no agent selected` | 跑 `rotom config show` 检查注册；用 `rotom config use <name>` 设默认或 `rotom --as <name> ...` |
| `agent "xxx" not found` | `rotom directory --pretty` 看正确名字；可能是大小写/中文标点错误 |
| `delivered=false queued=true` | 对方离线，消息已入队，对方上线后会收到 |
| `delivered=false queued=false error=...` | 真失败，看 `error` 字段 |
| HTTP 401/403 | mesh token 错或过期，检查 `~/.openclaw/openclaw.json` 或 executor.config.json |
