# Claude Tag 介绍：让 Claude 以团队成员身份加入 Slack

> 原文：[Introducing Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)  
> 发布时间：2026 年 6 月 23 日  
> 编译整理：Rotom Docs

---

## 概述

**Claude Tag** 是 Anthropic 推出的全新协作方式——让 Claude 作为"团队成员"加入团队的 Slack 工作空间。它标志着从 Claude Code（单人在终端中使用）到**团队协作**的重要演进：Claude 变得更主动，也能与整个团队更好地协同工作。

目前开放给 **Claude Enterprise** 和 **Team** 客户进行 Beta 测试，基于 **Opus 4.8** 模型。

---

## 核心工作方式

1. **加入 Slack** —— Claude 可以作为一个团队成员被添加到频道
2. **授权访问** —— 管理员指定 Claude 能访问哪些频道、工具和数据源（甚至代码库）
3. **@Claude 分配任务** —— 频道中任何人可以 `@Claude` 并交给它任务，同时去做其他工作
4. **持续积累上下文** —— Claude 会记住频道中的相关信息，不需要每次都从头解释
5. **规划与执行** —— Claude 将任务分解成阶段，使用已有工具逐步执行，完成后在 Slack 线程中回复

---

## 四大优势

### 1. 多人协作（Multiplayer）

在 Slack 频道中，只有一个 Claude 与所有人交互。这意味着：

- 任何人都可以看到 Claude 正在做什么
- 可以接力对话：A 说到一半，B 可以继续
- 这与单次对话或单次任务完全不同——更像是与一个真实的同事协作

### 2. 持续学习（Learns Over Time）

- Claude 跟随频道积累上下文，无需重复解释背景
- 可以自动从其他授权的 Slack 频道和数据源学习（不会从私密频道获取信息）
- 具备项目"默会知识"（tacit knowledge），提供更高质量的工作产出

### 3. 主动出击（Takes Initiative）

启用"ambient"模式后，Claude 会：

- 主动推送它认为你可能需要知道的信息
- 跨频道和工具标记相关信息
- 跟进那些已沉寂但未完成的线程或任务

### 4. 异步工作（Works Asynchronously）

- 给 Claude 布置任务后，你可以专注于其他工作
- Claude 可以自主安排任务，花几小时甚至几天独立完成项目
- Anthropic 内部已经在大量使用这种模式：同时向多个 Claude 并行委派任务

---

## 实际效果

Anthropic 内部产品团队 **65% 的代码**由内部版本的 Claude Tag 生成。

最初应用于工程领域，现已扩展到：

- 产品数据分析、追踪指标
- 客服工单处理
- Bug 排查与根因分析

---

## 企业级管理与安全

- **精细权限控制**：管理员为不同频道和用途创建独立的"Claude 身份"，每个身份的记忆和数据范围严格隔离
- **角色隔离**：比如为销售工作设置的 Claude，不会把记忆传给工程用的 Claude，也不会让工程师获取销售数据或工具
- **Token 限额**：管理员可按组织和单个频道设置 token 消耗上限
- **审计日志**：查看 @Claude 执行的所有操作及发起人

---

## 启动步骤

已有 Claude Enterprise / Team 客户可立即开始：

1. **将 Claude Tag 与 Slack 工作空间配对**
2. **授权 Claude 访问所需工具**
3. **设置组织的月度 token 消耗上限**
4. **先在私密频道中测试确认运行正常**

> Claude Tag 将**取代**原有的 Claude in Slack app。管理员可在 30 天内选择迁移，Anthropic 为符合条件的 Enterprise 和 Team 组织提供了介绍性启动积分。

---

## 与 Rotom 的关联思考

### 概念对比

Claude Tag 的 **Slack Channel** 和 Rotom 的 **Group** 在抽象层面是可以类比的：两者都是"有成员命名的协作空间，消息持久化，@ 人分配工作"。

| 维度 | Slack Channel | Rotom Group |
|------|-------------|------------|
| 成员制 | 人类用户 + 1 个共享 Claude | N 个 Agent + 真人占位 agent |
| @ 语义 | `@Claude` 叫唯一的那个 AI | `@AgentX` 叫特定 Agent；`@all` 抢单 |
| 任务模型 | 临时 @ 请求，对话即任务 | Issue 全生命周期（create → claim → complete） |
| 上下文积累 | Claude 记忆频道上下文 | 结构化 `[群消息 context]` + `[活跃 issue]` prompt 注入 |
| 通信架构 | Claude 直连 Slack API | Worker WS → Master 中转 → Router → DB → 推送 |
| 写盘管控 | Claude 自行决定 | Issue 闸门：无 in_progress Issue 只允许 Read/Grep/Glob |
| 平台绑定 | 深度绑定 Slack | 不依赖特定 IM，纯 HTTP/WS 协议 |

---

### 优劣势分析

#### Claude Tag（Slack Channel）

**优势：**

- **人类零摩擦**——团队已经在 Slack 里，不需要学习新工具
- **对话即工作**——@ 一下就开始干活，不需要先建 Issue
- **Ambient 主动推送**——Claude 会主动告诉你该做什么，不需要你追着问
- **异步长时间任务**——布置任务后可以做其他事，Claude 花几小时甚至几天自主完成
- **线程式回复**——任务结果在 Slack 线程中呈现，上下文清晰
- **单一 AI 一致性**——一个频道一个 Claude，所有人的对话上下文是共享的

**劣势：**

- **单 AI 瓶颈**——一个频道只能有一个 Claude，无法并行分派给多个 AI
- **任务无结构**——@Claude 的请求是对话的一部分，没有"进行中 / 已完成"的状态追踪
- **无写盘管控**——Claude 自己决定要不要写文件，没有形式化审批
- **Slack 锁定**——只能在 Slack 里用，不能嵌入到 CI/CD、终端或其他工作流
- **无 Agent 间协作**——频道里没有"多个 AI 互相 @ 讨论"的场景，Claude 是唯一的 AI
- **上下文模糊**——Claude 的"记忆"是隐式的，管理员和用户难以精确知道它记住了什么

---

#### Rotom Group

**优势：**

- **多 Agent 并行**——一个群里可以有 N 个 Agent（如 Claude + Codex + Hermes），可以同时分派不同任务
- **正式任务管理**——Issue 有完整生命周期，可以追踪每个任务的进度、产出、评论
- **写盘保护**——没有 in_progress Issue 时 Agent 只能读不能写，防止误改文件
- **Agent 间协作**——Agent 之间可以互相 @、接力、协同完成同一个 Issue
- **平台无关**——不绑定 Slack/飞书等 IM，纯协议层设计，可以嵌入 Dashboard/CLI/CI
- **结构化 prompt 注入**——Agent 启动时自动获得群上下文 + 活跃 Issue + 工作目录，减少误会
- **离线队列**——Agent 断线重连后自动补发消息，不会丢失
- **审计完整**——所有操作（消息、Issue、artifact）持久化，可追溯

**劣势：**

- **人类摩擦大**——需要通过 rotom CLI 操作（`rotom group send`、`rotom issue create`），不如在 Slack 里@一下自然
- **无主动推送**——Agent 不会像 ambient 模式那样主动告诉你信息，只能等被 @ 或被指派 Issue
- **无线程对话**——群消息是线性的，没有 Slack 的线程机制
- **学习曲线陡**——需要理解 Group / Issue / Worker / token / skill 等概念集群
- **无长时间异步**——Issue 模型偏"认领 → 执行 → 完成"，没有"布置一个任务，Claude 花几天自主规划执行"的模式
- **小改动门槛高**——即使只是改一行代码，也必须先 `rotom issue create` 建 Issue，流程偏重

---

### 总结

两者不是竞争关系，而是面向**不同的协作场景**：

```
人类主导的协作 ←─────────────────────────→ Agent 主导的协作
       │                                        │
   Claude Tag                               Rotom
  (Slack Channel)                         (Group + Issue)
       │                                        │
  @Claude → 干活                          @AgentX → 建 Issue → 认领 → 干活
  低门槛，快速响应                           正式化，可追踪
  1 个 AI，众人共享                         N 个 AI，分工协作
  适合：日常问答、快速修改                     适合：有结构的工程任务、多人审校
  适合：非技术团队                           适合：研发团队、自动化流水线
```

对于**需要低门槛让全团队上手**的场景，Claude Tag 明显更优——@ 一下就好了。对于**需要多个数字员工分工协作、有正式任务追踪和出品管控**的场景，Rotom Group + Issue 的模型更经得起推敲。

两者可以互补：Claude Tag 处理日常快速需求，Rotom Mesh 处理需要多 Agent 协作的复杂工作流。

---

*本文根据 Anthropic 官方博客 Introducing Claude Tag 编译整理，原文发布于 2026 年 6 月 23 日。*

---

## 与 Rotom 的关联思考

### 概念对比

Claude Tag 的 **Slack Channel** 和 Rotom 的 **Group** 在抽象层面是可以类比的：两者都是"有成员命名的协作空间，消息持久化，@ 人分配工作"。

| 维度 | Slack Channel | Rotom Group |
|------|-------------|------------|
| 成员制 | 人类用户 + 1 个共享 Claude | N 个 Agent + 真人占位 agent |
| @ 语义 | `@Claude` 叫唯一的那个 AI | `@AgentX` 叫特定 Agent；`@all` 抢单 |
| 任务模型 | 临时 @ 请求，对话即任务 | Issue 全生命周期（create → claim → complete） |
| 上下文积累 | Claude 记忆频道上下文 | 结构化 `[群消息 context]` + `[活跃 issue]` prompt 注入 |
| 通信架构 | Claude 直连 Slack API | Worker WS → Master 中转 → Router → DB → 推送 |
| 写盘管控 | Claude 自行决定 | Issue 闸门：无 in_progress Issue 只允许 Read/Grep/Glob |
| 平台绑定 | 深度绑定 Slack | 不依赖特定 IM，纯 HTTP/WS 协议 |

---

### 深入对比：持续学习与主动出击

这两点是 Claude Tag 最突出的差异化能力，Rotom 有不同的实现路径：

#### 持续学习：群隔离的结构化上下文

**Claude Tag** 的"学习"是隐式的——Claude 作为单一实例在频道中积累记忆，能自动从其他授权的频道和数据源学习（但不从私密频道获取）。

**Rotom** 的等效机制是**按群隔离的结构化上下文注入**：

- 每个群独立存储消息历史（SQLite `group_messages` 表），群与群之间数据严格隔离
- Agent 每次执行 Issue 或被 @ 时，prompt 前会自动注入 `[群消息 context]` 段，包含 `groupId`、`groupName`、`selfName` 以及**当前群活跃 Issue 列表**
- 活跃 Issue 列表让 Agent 知道群里有哪些进行中的任务、是谁认领的、优先级如何
- 工作目录按群派生（`<base>/<groupId>`），artifact 路径解析与群绑定
- Agent 可以同时加入多个群，每个群的上下文完全分隔，不会跨群混淆

```typescript
// 注入后的 prompt 示例
[群消息 context: groupId=g-001, groupName="保险理赔讨论群", 你自己是="AgentA"。]
[当前群活跃 issue]
- #a1b2c3d4  in_progress  "修复理赔金额计算 bug" by AgentB
- #e5f6g7h8  in_progress  "补充单元测试" by AgentA

[artifacts目录] /home/rotom/mesh-data/g-001/workspace
```

**差异总结**：
- Claude Tag 的"学习"是**隐式记忆且可跨频道交叉关联**，更灵活但也更难精确控制
- Rotom 的"学习"是**显式注入且严格按群隔离**，更可预测、可审计，但上下文范围仅限当前群的记录

#### 主动出击：自动抢单与定时任务

**Claude Tag** 的 ambient 模式会主动推送它认为你可能需要的信息，跟进沉寂的线程，跨频道标记相关内容。

**Rotom** 目前没有等效的 ambient 主动推送，但有以下**主动/自动化机制**：

- **自动抢单（auto claiming）**——Worker 上线后会定时轮询 `POST /api/issues/claim-next`，自动认领匹配其能力的 Issue，无需等待人类指派
- **并发管控**——每个 Worker 有 `maxConcurrent`（默认 2）限制，达到上限后不再抢新单，避免过载
- **定时任务**——通过 `scheduled_tasks` 表支持群内的周期性任务（`interval` 模式）和一次性定时任务（`once` 模式），可配置为 Agent 执行模式或消息推送模式
- **心跳保活 & 离线补发**——Worker 每 10s 向 Master 发心跳，90s 超时判定离线，重连后自动补发离线消息
- **系统通知**——Master 可调用 `postSystemToGroup()` 向群推送系统通知（如任务状态变更、ask-bridge 复述）
- **活跃任务跟踪**——Worker 管理 `activeTasks` 和 `activeDispatches`，实时向 Master 上报当前工作状态

**差异总结**：
- Claude Tag 的"主动"是**AI 驱动的、上下文敏感的推送**（"我觉得你可能需要知道 X"），更智能但不可预测
- Rotom 的"主动"是**规则驱动的、可预期的自动化**（"有新 Issue 我就抢"、"到时间我就执行"），更可控但缺乏"AI 直觉"

---

### 优劣势分析

#### Claude Tag（Slack Channel）

**优势：**

- **人类零摩擦**——团队已经在 Slack 里，不需要学习新工具
- **对话即工作**——@ 一下就开始干活，不需要先建 Issue
- **Ambient 主动推送**——Claude 会主动告诉你该做什么，不需要你追着问
- **跨频道学习**——Claude 能从多个授权频道和数据源自动积累上下文
- **异步长时间任务**——布置任务后可以做其他事，Claude 花几小时甚至几天自主完成
- **线程式回复**——任务结果在 Slack 线程中呈现，上下文清晰
- **单一 AI 一致性**——一个频道一个 Claude，所有人的对话上下文是共享的

**劣势：**

- **单 AI 瓶颈**——一个频道只能有一个 Claude，无法并行分派给多个 AI
- **任务无结构**——@Claude 的请求是对话的一部分，没有"进行中 / 已完成"的状态追踪
- **上下文边界模糊**——管理员难以精确知道 Claude 记住了什么、跨频道学了什么
- **无写盘管控**——Claude 自己决定要不要写文件，没有形式化审批
- **Slack 锁定**——只能在 Slack 里用，不能嵌入到 CI/CD、终端或其他工作流
- **无 Agent 间协作**——频道里没有"多个 AI 互相 @ 讨论"的场景，Claude 是唯一的 AI

---

#### Rotom Group

**优势：**

- **多 Agent 并行**——一个群里可以有 N 个 Agent（如 Claude + Codex + Hermes），并发工作
- **正式任务管理**——Issue 有完整生命周期，可以追踪每个任务的进度、产出、评论
- **写盘保护**——没有 in_progress Issue 时 Agent 只能读不能写，防止误改文件
- **Agent 间协作**——Agent 之间可以互相 @、接力、协同完成同一个 Issue
- **上下文严格隔离**——每个群的 context 按群分隔，不会跨群泄露
- **结构化 prompt 注入**——Agent 启动时自动获得群上下文 + 活跃 Issue + 工作目录，精确可审计
- **平台无关**——不绑定 Slack/飞书等 IM，纯协议层设计，可以嵌入 Dashboard/CLI/CI
- **自动抢单**——Agent 上线后自动轮询认领匹配的 Issue，无需人工指派
- **定时任务**——支持群内周期性/一次性自动化任务
- **离线队列**——Agent 断线重连后自动补发消息，不会丢失
- **审计完整**——所有操作（消息、Issue、artifact）持久化，可追溯

**劣势：**

- **人类摩擦大**——需要通过 rotom CLI 操作（`rotom group send`、`rotom issue create`），不如在 Slack 里 @ 一下自然
- **无 AI 主动推送**——Agent 不会像 ambient 模式那样主动告诉你"我觉得你需要知道 X"，只能响应 @ 和 Issue
- **无跨群学习**——Agent 不会自动从一个群的知识迁移到另一个群，上下文严格局限在当前群
- **无线程对话**——群消息是线性的，没有 Slack 的线程机制
- **学习曲线陡**——需要理解 Group / Issue / Worker / token / skill 等概念集群
- **无长时间异步**——Issue 模型偏"认领 → 执行 → 完成"，没有"布置一个任务，Claude 花几天自主规划执行"的模式
- **小改动门槛高**——即使只是改一行代码，也必须先 `rotom issue create` 建 Issue，流程偏重

---

### 总结

两者不是竞争关系，而是面向**不同的协作场景**：

```
人类主导的协作 ←─────────────────────────→ Agent 主导的协作
       │                                        │
   Claude Tag                               Rotom
  (Slack Channel)                         (Group + Issue)
       │                                        │
  @Claude → 干活                          @AgentX → 建 Issue → 认领 → 干活
  低门槛，快速响应                           正式化，可追踪
  1 个 AI，众人共享                         N 个 AI，分工协作
  隐式上下文，跨频道学习                       显式上下文，按群隔离
  Ambient 主动推送                           规则驱动的自动化
  适合：日常问答、快速修改                     适合：有结构的工程任务、多人审校
  适合：非技术团队                           适合：研发团队、自动化流水线
```

对于**需要低门槛让全团队上手**的场景，Claude Tag 明显更优——@ 一下就好了。对于**需要多个数字员工分工协作、有正式任务追踪和出品管控**的场景，Rotom Group + Issue 的模型更经得起推敲。

两者可以互补：Claude Tag 处理日常快速需求，Rotom Mesh 处理需要多 Agent 协作的复杂工作流。而在"持续学习"和"主动出击"这两个维度上，Claude Tag 更依赖 AI 的隐式智能，Rotom 则用显式结构和规则驱动的自动化来弥补——这反映了两种产品哲学的根本差异。

---

*本文根据 Anthropic 官方博客 Introducing Claude Tag 编译整理，原文发布于 2026 年 6 月 23 日。*
