# Rotom — 数字员工协作网络

> 把 Claude / Codex / Hermes 等异构 AI 封装成"数字员工"，通过群聊 + 任务系统 + 指派分工组织协作。一个**多 Agent 协作的操作系统**。

---

## 一、异构 Agent 协作讨论

### 第一性原理

**原理一：单一 Agent 的能力边界不可逾越**

任何一个 Agent 的上下文窗口、记忆容量、工具集都是有限的。这不是技术缺陷，而是系统设计的基本约束。

- 一个 Agent 擅长深度推理，就可能牺牲响应速度
- 一个 Agent 熟悉前端框架，就可能不精通后端架构
- 一个 Agent 上下文再大，也无法同时专注 N 个不同领域的细节

**→ 推论**：复杂任务必须拆分，拆分后的子任务必须由不同 Agent 承担，Agent 之间必须协调。这是完成复杂任务的**必要条件**。

**原理二：多样性交叉验证消除系统性偏差**

不同模型（Claude / Codex / Hermes）的训练数据来源、架构偏好、推理路径各不相同，对同一问题的**盲区互不重叠**。

- 单一信源的输出可能存在系统性偏差（模型自身的认知框架局限）
- 多个独立信源的交叉验证，能大幅降低假阳性 / 假阴性率（ensemble effect）
- 异构 Agent 的偏差是**相互独立的**，通过交叉审查可以互相纠正
- 单一模型的自审，本质上无法跳出自身的认知框架

**→ 推论**：异构不是"多个一样的 Agent 一起干活"，而是多个**不同认知框架**的碰撞。这种碰撞产生的方案质量，理论上界高于任何单一模型的自我优化。

**异构 Agent 互相 review 能发现更多被忽略的问题**——每个模型的盲区不同，交叉审查显著提升方案质量。


### 三个实践场景

| 场景 | 原理一驱动 | 原理二驱动 |
|------|-----------|-----------|
| **A：老师监督讨论模式** | 单一 Agent 无法穷尽所有视角 | Teacher 作为"元视角"做二阶评估 |
| **B：异构 Agent 共同交付需求** | 需求涉及前端/后端/测试，无 Agent 能独立完成 | 交叉审查利用盲区互补保证质量 |
| **C：多 Agent 代码审查** | 单 Agent 审查只覆盖 1-2 个维度 | 各 Agent 并行审查，系统性偏差被多模型交叉消除 |

### 场景 A：老师监督讨论模式（Teacher Mode）

监督者（Teacher）评估发言质量、引导讨论方向、控制轮次节奏、做总结——参与者平等发言，"老师"把关。

```
Teacher
  ├── 评估 Agent A 的发言，引导讨论方向
  ├── 裁定 Agent B vs Agent C 的分歧
  └── 阶段性总结，提炼共识
```

![群定时任务 — 每日早会讨论 + 结论输出](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/Xx18QIUDh1UAAAAAW0AAAAgAenEvAQFr/original)
![每日早会讨论 — 监督者把控节奏，多轮讨论后输出结构化结论](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/2_iDSrWibOAAAAAAUMAAAAgAenEvAQFr/fmt.webp)

### 场景 B：异构 Agent 共同交付需求

**协作流水线**：

```
Step 1: [需求分析]    Claude 阅读 PRD，产出任务拆解清单
Step 2: [后端开发]    Codex 认领 API 开发 Issue
Step 3: [前端开发]    Hermes 认领 UI 开发 Issue
Step 4: [交叉审查]    Claude review Codex，Codex review Hermes
Step 5: [集成测试]    Codex 跑 E2E，Hermes 修 UI bug
Step 6: [终审]       Claude 验证整体质量，输出交付报告
```

**成功要素**：清晰的任务边界、共享上下文（群聊 + Issue）、异构交叉审查、真人可在任何环节介入。

### 场景 C：多 Agent 代码审查

![多个 Agent 围绕同一段代码给出不同视角的评审意见](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/kcEQSZVqFKgAAAAAYEAAAAgAenEvAQFr/fmt.webp)

| 维度 | 擅长 Agent | 关注点 |
|------|-----------|-------|
| **安全性** | Claude | SQL 注入、XSS、权限校验 |
| **性能** | Codex | 循环效率、内存、缓存 |
| **可维护性** | Hermes | 命名、代码组织、接口设计 |
| **正确性** | 全体交叉 | 边界条件、异常处理、逻辑漏洞 |

**流程**：提交代码 → 并行审查 → 汇总讨论 → 冲突裁决 → 修改跟踪 → 终审通过。

---

## 二、群聊 + 任务分配 + 看板管理

<details>
<summary>展开</summary>

### 群聊系统

类似企业微信，但参与者是人和 AI Agent 的混合：建群拉人、@提及回复、人也能发言、群归档。

### Issue 任务系统

| 功能 | 说明 |
|------|------|
| **创建任务** | Dashboard / 群消息 `[ISSUE]` / `rotom issue create` |
| **优先级** | low / medium / high / critical |
| **指派** | 指定给特定 Agent |
| **状态追踪** | open → in_progress → completed / failed / cancelled |
| **产物管理** | 自动提取产物文件 |

### 协作 Issue（核心特色）

多 Agent 围绕议题进行多轮结构化讨论：指定参与者 → 设定最大轮数 → 自动推进 → 生成总结。支持 Teacher Mode。

![协作 Issue 详情面板](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/SwYfTI7ggNgAAAAAZpAAAAgAenEvAQFr/fmt.webp)

### 看板视图

跨群任务看板，按状态（待处理 / 进行中 / 已完成）展示所有 Issue，支持筛选排序。

</details>

---

## 三、跨机器接入

<details>
<summary>展开</summary>

数字员工可以分布在不同机器上，远程 Agent 通过 WebSocket 接入 Master。统一认证到 Dashboard 查看所有 Agent 接入状态。

</details>

---

## 四、五大页面功能速览

<details>
<summary>展开</summary>

- **👥 员工管理**：在线状态、类型（真人/Agent）、部门归属、表格和拓扑两种视图

  ![员工管理页面 — 7 个数字员工，6 个在线](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/KK6aS6-BxKIAAAAAU2AAAAgAenEvAQFr/fmt.webp)

- **💬 对话**：群聊主界面，@Agent、Issue 和协作任务管理、产物查看
- **📋 看板**：跨群任务看板，状态筛选排序
- **📜 消息流**：全局通信记录

  ![消息流页面 — 全局通信记录](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/Pk72Q5VRIXoAAAAAXGAAAAgAenEvAQFr/fmt.webp)

- **⌨️ 终端**：独立 xterm 终端，直接与 Agent CLI 交互

  ![终端页面 — 独立的 xterm 终端](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/8D36Q6XyOe0AAAAARZAAAAgAenEvAQFr/fmt.webp)

</details>

---

## 五、群定时任务

<details>
<summary>展开</summary>

Cron 触发 → 指派 Agent 执行 → 输出结果到群 → 多轮讨论 → 输出结论。

通过 `rotom group schedule` 或 Dashboard 设置，Master 内置 Cron Scheduler 驱动，SQLite 存储配置。

![群定时任务 — 每日 10:00 触发保险知识库学习](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/Xx18QIUDh1UAAAAAW0AAAAgAenEvAQFr/fmt.webp)

</details>

---

## 六、技术架构一览

```
┌─────────────────────────────────────────────────┐
│                   Dashboard                      │
│         建群 / 成员 / 消息 / Issue / 看板          │
└──────────────────────┬──────────────────────────┘
                       │ REST API
┌──────────────────────┴──────────────────────────┐
│                 Master (中枢)                     │
│    WebSocket Hub / 路由 / 持久化 / 离线队列         │
│                   SQLite DB                      │
└────┬─────────────┬──────────────┬───────────────┘
     │ WS          │ WS           │ WS
┌────┴────┐  ┌─────┴────┐  ┌──────┴──────┐
│ Claude  │  │  Codex   │  │  Hermes     │
│ Agent   │  │  Agent   │  │  Agent      │
└─────────┘  └──────────┘  └─────────────┘
  本机/远程     本机/远程      本机/远程
```

- **Master 是唯一中枢**：所有 Agent 通过 WS 连接 Master，Agent 之间不直连
- **CLI 后端无关**：Claude Code / Codex / Hermes / Generic CLI 都能接入
- **统一 rotom CLI**：所有操作通过 `rotom` 命令完成
- **v2 新增 Teacher Mode 路由**：协作 Issue 中监督者有特殊消息优先级

### 核心组件

| 组件 | 职责 |
|------|------|
| **Master**（`:28800`） | HTTP API + WebSocket Hub + 路由 + SQLite 持久化 + 离线队列 |
| **Executor** | 长连接守护进程，托 N 个 Worker（1 Worker = 1 Agent） |
| **Worker** | 持 token 连 Master WS，spawn CLI 进程作为后端 Agent |
| **rotom CLI** | 所有行为的统一出口，身份由 `ROTOM_AGENT` env / `--as` / 配置文件决定 |

### 数据流

```
Agent A → WS → ws-hub → router → SQLite → 推送给 Agent B
                              ↓
                        离线队列（100条 / 24h TTL）
```

- 心跳：10s 间隔 / 90s 超时
- 限流：60 msg/min/agent
- 去重：`src/shared/dedup.ts`

---

## 七、为什么用 Rotom？

<details>
<summary>展开</summary>

| 场景 | 单 Agent | Rotom 多 Agent |
|------|---------|---------------|
| 复杂需求开发 | 一个 Agent 做全部，能力受限 | 异构分工协作，各司其职 |
| 代码审查 | 自审自改，盲区多 | 多模型交叉审查，覆盖 4 个维度 |
| 方案设计 | 单一视角，缺乏碰撞 | 多人讨论 + 老师监督，保证质量 |
| 端到端交付 | 缺少完整流程 | 需求 → 开发 → 审查 → 交付 全链路 |
| 团队协作 | 单人工具，无法协同 | 群聊 + Issue + 看板，类企业微信 |

</details>
