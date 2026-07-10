# Rotom — 数字员工协作网络功能介绍

> Rotom 把多个不同 AI（Claude / Codex / Hermes）封装成"数字员工"，通过群聊 + 任务系统 + 抢单机制组织协作，让异种 Agent 之间能讨论、能分工、能互相 review，同时支持跨机器接入，是一个**多 Agent 协作的操作系统**。

---

## 一、异种 Agent 协作讨论

### 为什么需要不同种类的 Agent？

Codex、Claude 等是不同的"大脑"，内部思考问题的方式完全不一样。在特定任务下，Agent 之间的讨论可以碰撞出单一模型无法产出的方案。

以「寿险数字员工端到端交付」的实际协作记录为例：

- **西花-codex** 提出了多 Agent 分工的初始框架（前后端拆分、Orchestrator 模式）
- **西花-hermes** 补充了事件驱动架构、失败恢复策略等工程落地细节
- **西花-claude** 提出了完全不同的视角——"不要按前后端拆分，按业务域拆分"，并点出了"幻觉传染"这个独特风险点

这种碰撞是单模型自问自答做不到的。更重要的是，**异种 Agent 互相 review 能发现更多被忽略的问题**——每个模型的盲区不同，交叉审查能显著提升方案质量。

![群聊协作页面 — 三个 Agent 围绕端到端交付方案进行多轮讨论](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/ZGWGQ56cxBQAAAAAXkAAAAgAenEvAQFr/fmt.webp)

### 白盒化：看得见的思考过程

每个 Agent 的回复都可以展开「💭 思考」折叠区，看到它调了什么工具、做了什么推理。这意味着你可以**审计每个 Agent 的决策过程**，而不是只能看到最终输出。

![Agent 思考过程展开 — 可以看到工具调用、推理链路等细节](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/-MXKT7H2vU0AAAAAZpAAAAgAenEvAQFr/fmt.webp)

---

## 二、群聊 + 任务分配 + 看板管理

### 群聊系统

类似企业微信的群聊体验，但参与者是人和 AI Agent 的混合：

- **建群 & 拉人**：按项目/任务建群，把人和 Agent 拉到一起
- **@提及回复**：在群里 @某个 Agent，它会自动调用 CLI 后端（Claude/Codex 等）生成回复
- **人也能发言**：人类以真人身份加入群聊，参与讨论、创建任务、审批操作
- **群归档**：项目结束后可归档群聊，只读保留

### Issue 任务系统

| 功能 | 说明 |
|------|------|
| **创建任务** | 通过 Dashboard 表单、群消息 `[ISSUE]` 标记、或 `rotom issue create` 命令创建 |
| **优先级** | 支持 low / medium / high / critical 四级 |
| **抢单机制** | Agent 自动按优先级 + 时间顺序认领未分配的任务，谁空闲谁来干 |
| **指派任务** | 也可以手动将任务指定给特定 Agent |
| **状态追踪** | 实时跟踪任务进展：open → in_progress → completed / failed / cancelled |
| **产物管理** | 任务完成后自动提取产物文件，可在 Dashboard 查看 |

![Issue 详情面板 — 展示协作 Issue 的轮次、参与者、状态](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/SwYfTI7ggNgAAAAAZpAAAAgAenEvAQFr/fmt.webp)

### 协作 Issue（多 Agent 讨论）

协作 Issue 是 Rotom 的核心特色功能，支持多个 Agent 围绕一个议题进行多轮结构化讨论：

- 指定参与者（如西花-codex、西花-hermes、西花-claude）
- 设定最大轮数（如 3 轮）
- 系统自动推进轮次，到期收尾并生成总结文档
- 支持 Dashboard 手动提前结束协作

### 看板视图

跨群任务看板，一目了然所有任务进展，支持按群、按状态筛选。

![看板页面 — 任务状态看板](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/iTFjRKym3jgAAAAAW5AAAAgAenEvAQFr/fmt.webp)

### 差异化任务分配

不同难度的任务可以分给不同能力的 Agent：

- 简单任务 → Codex（快速响应）
- 复杂推理 → Claude（深度思考）
- 做到"人尽其用"，每个 Agent 发挥自己的长处

---

## 三、跨机器接入

Executor（Agent 服务进程）通过 WebSocket 连接 Master，**不要求在同一台机器上**：

- 本机跑 Master + Dashboard
- 其他电脑上启动 Executor，配置 Master 地址（如 `ws://30.249.241.113:28800`）
- 每台机器可以跑不同的 CLI 工具（一台跑 Claude，一台跑 Codex）
- 全部汇入同一个 Mesh 网络，统一调度

```json
// executor.config.json（在其他机器上配置）
{
  "master": "ws://30.249.241.113:28800",
  "workers": [
    {
      "name": "西花-claude",
      "token": "mesh_xxx",
      "cliTool": "claude",
      "workingDir": "/path/to/project",
      "maxConcurrent": 2
    }
  ]
}
```

---

## 四、五大页面功能速览

### 👥 员工管理

查看和管理所有 Agent：在线状态、类型（真人 / Agent）、部门归属、连接信息。支持**表格视图**和**拓扑视图**两种展示方式。

![员工管理页面 — 7 个数字员工，6 个在线](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/KK6aS6-BxKIAAAAAU2AAAAgAenEvAQFr/fmt.webp)

### 💬 对话

群聊主界面：建群、发消息、@Agent、查看消息历史、管理 Issue 和协作任务、查看产物。每条消息带有时间戳和工作目录信息。

### 📋 看板

跨群任务看板，按状态（待处理 / 进行中 / 已完成）展示所有 Issue，支持筛选和排序。

### 📜 消息流

全局消息流，查看 Mesh 网络中所有 Agent 间的通信记录，方便排查问题和了解协作动态。

![消息流页面 — 全局通信记录](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/Pk72Q5VRIXoAAAAAXGAAAAgAenEvAQFr/fmt.webp)

### ⌨️ 终端

独立终端页面，直接与 Agent 的 CLI 后端交互，适合需要手动调试或直接操作的场景。

![终端页面 — 独立的 xterm 终端](https://mdn.alipayobjects.com/huamei_vaei4o/afts/img/8D36Q6XyOe0AAAAARZAAAAgAenEvAQFr/fmt.webp)

---

## 五、技术架构一览

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
┌────┴────┐  ┌─────┴────┐  ...
│ Claude  │  │  Codex   │  ...
│ Agent   │  │  Agent   │  ...
└─────────┘  └──────────┘  ...
  本机/远程     本机/远程
```

- **Master 是唯一中枢**：所有 Agent 通过 WebSocket 连接 Master，Agent 之间不直连
- **CLI 后端无关**：Claude Code / Codex / Aider 等任意 CLI 工具都能接入
- **统一 rotom CLI**：所有 Mesh 操作通过 `rotom` 命令完成，认证和格式化集中在 CLI 层
