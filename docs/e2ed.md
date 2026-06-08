# E2ED — End-to-End Requirement Delivery

Claude 生产，Codex 评审，三类产物对抗交付。

## 两大卖点

1. **全流程白盒化** — 每一步的状态变化、决策、评审结果都持久化并可视化（Dashboard + CLI + artifacts）。用户随时能看到 agent 在做什么、做了什么、为什么这样做。不是黑盒跑完甩结果，而是全程透明可追溯。

2. **异构 Agent 评审机制** — 交付（Claude）和评审（Codex）使用不同模型/角色的 agent，形成独立的第三方评审。交付 agent 不能自评，评审 agent 只读不写，从架构层面避免自我审查的盲区。

## 核心理念

两个 Agent 各司其职，形成生产-评审对抗闭环：

| 角色 | Agent | 做什么 | 不做什么 |
|------|-------|--------|----------|
| 生产者 | Claude | 生成需求分析、实现方案、代码 | 不自评 |
| 评审者 | Codex | 独立评审三类产物，给出评分和改进意见 | 不修改任何内容 |

三类产物，每类都经过"生产 → 评审"一轮对抗：

| 产物 | 生产（Claude） | 评审（Codex） |
|------|----------------|----------------|
| 需求 | — | 评审清晰度、完整性、可测试性 |
| 方案 | 生成实现方案（文件变更、API、数据模型、测试策略） | 评审可行性、需求覆盖、风险评估 |
| 代码 | 实现代码 + 自我反思 | 评审需求覆盖、代码质量、可维护性 |

## 状态流转

```
CREATED ──→ ENV_READY ──→ REQ_REVIEWED ──→ DELIVERED ──→ PLAN_REVIEWED ──→ DELIVERED ──→ REVIEWED ──→ CLOSED
                 │                             │                            │
                 └──→ ENV_BLOCKED              │                            │
                                               ↑                            ↑
                                    (方案评审完成后)              (代码实现完成后)
```

状态枚举（8 个里程碑）：

| 状态 | 说明 |
|------|------|
| `CREATED` | 需求已创建 |
| `ENV_READY` | 环境就绪 |
| `ENV_BLOCKED` | 环境阻塞 |
| `REQ_REVIEWED` | 需求已评审 |
| `PLAN_REVIEWED` | 方案已评审 |
| `DELIVERED` | 已交付 |
| `REVIEWED` | 已评审 |
| `CLOSED` | 已关闭 |

活跃任务（`activeTask` 字段）：

| activeTask | 含义 |
|------------|------|
| `env_checking` | 环境检查中 |
| `req_reviewing` | 需求评审中 |
| `planning` | 方案生成中 |
| `plan_reviewing` | 方案评审中 |
| `delivering` | 代码实现中 |
| `code_reviewing` | 代码评审中 |
| `null` | 无进行中任务 |

## 典型工作流

### 1. 创建需求

通过 CLI 或 Dashboard 创建需求，描述你想要实现的功能。

- 好的需求描述应包含：**背景、功能点、验收标准**
- 建议描述不少于 200 字

```bash
rotom e2ed start <file.md | text> [--title T] [--cwd DIR]
```

从 Markdown 文件或内联文本创建需求，生成 UUID 作为 `groupId`。

### 2. 交付 & 评审

`deliver` 和 `review` 会根据当前状态自动推断该做什么：

```bash
# 自动：无 plan 时生成方案，有 plan 且已评审时实现代码
rotom e2ed deliver <groupId>

# 自动：根据未评审的产物推断类型（需求/方案/代码）
rotom e2ed review <groupId>
```

典型的分步流程：

```bash
rotom e2ed deliver <groupId>   # 生成方案（自动推断 --plan-only）
rotom e2ed review <groupId>    # 评审方案（自动推断 --type plan）
rotom e2ed deliver <groupId>   # 实现代码（自动推断 --code-only）
rotom e2ed review <groupId>    # 评审代码（自动推断 --type code）
```

如果评审未通过，使用 `--fix` 基于反馈修复：

```bash
rotom e2ed deliver <groupId> --fix
```

### 3. 查看状态

```bash
rotom e2ed status <groupId> --pretty
```

展示需求基本信息、各轮交付/评审耗时、最近事件时间线。

### 4. 关闭需求

代码通过评审后，关闭需求完成交付。

```bash
rotom e2ed close <groupId>
```

## CLI 命令

### 列出需求

```bash
rotom e2ed ls        # 或 list
rotom e2ed ls --pretty
```

### 查看需求状态

```bash
rotom e2ed status <groupId> [--pretty]
```

展示需求信息、各轮交付/评审耗时度量和最近事件时间线。

### 启动交付

```bash
rotom e2ed deliver <groupId> [flags]
```

自动推断：无方案时生成方案，方案已评审时实现代码。

| 标志 | 说明 |
|------|------|
| `--plan-only` | 强制只生成计划，不写代码 |
| `--code-only` | 强制只实现代码（需要已有计划） |
| `--fix` | 基于上次评审反馈修复 |
| `--cwd <dir>` | 指定工作目录 |

### 启动评审

```bash
rotom e2ed review <groupId> [--type requirement|plan|code] [--cwd DIR]
```

自动推断：根据未评审的产物选择评审类型。

| 类型 | 说明 |
|------|------|
| `requirement` | 独立需求评审 |
| `plan` | 计划可行性评审 |
| `code` | 代码实现评审（默认） |

### 查看需求详情

```bash
rotom e2ed show <groupId> [--pretty]
```

### 通用标志

| 标志 | 说明 |
|------|------|
| `--pretty` | 人类可读格式输出（默认 JSON） |

### 版本号说明

版本格式 `R{r}.P{p}.C{c}` — 每次生成方案或代码，对应版本号自增。

示例：`R1.P2.C3` 表示需求 v1、第 2 版方案、第 3 版代码。

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/e2ed/groups` | 列出所有需求 |
| GET | `/e2ed/groups/:groupId` | 获取需求详情 |
| GET | `/e2ed/groups/:groupId/text` | 获取需求文本 |
| GET | `/e2ed/groups/:groupId/metrics` | 获取度量数据 |
| GET | `/e2ed/groups/:groupId/timeline` | 获取时间线事件 |
| GET | `/e2ed/groups/:groupId/artifacts/*` | 读取产物文件 |
| POST | `/e2ed/groups` | 创建需求 |
| POST | `/e2ed/groups/:groupId/deliver` | 启动交付 |
| POST | `/e2ed/groups/:groupId/review` | 启动评审 |
| POST | `/e2ed/groups/:groupId/close` | 关闭需求 |

## 评审体系

所有评审均由独立 Agent (Codex) 执行，采用统一输出格式，最终以 `VERDICT_JSON` 形式给出结论。

### 评分规则

| 分数 | 结论 |
|------|------|
| 80 – 100 | `pass` |
| 50 – 79 | `needs-review` |
| 0 – 49 | `fail` |

### 需求评审 (Requirement Review)

评估维度（各占 25%）：

| 维度 | 检查项 |
|------|--------|
| **清晰度** | 无歧义、术语一致、范围明确、无矛盾 |
| **完整性** | 功能需求具体、非功能需求已说明、边界情况已描述、外部依赖已识别 |
| **可测试性** | 验收标准可度量、可构造测试用例、正常/异常输入有预期 |
| **歧义检查** | 无模糊措辞、无未量化范围、无隐含假设、无遗漏场景 |

### 计划评审 (Plan Review)

评估维度（各占 25%）：

| 维度 | 检查项 |
|------|--------|
| **可行性** | 技术方案可行、依赖可用、复杂度匹配 |
| **需求覆盖** | 每条需求已对应、边界情况已处理、错误策略已定义 |
| **风险评估** | 技术风险有应对、影响已评估、性能已考虑、有回滚策略 |
| **方案质量** | 步骤具体可执行、文件变更已识别、数据模型已指定、API 变更已定义、测试策略已规划 |

### 代码评审 (Code Review)

评估维度：

| 维度 | 检查项 |
|------|--------|
| **需求覆盖** | 所有需求点已实现、边界条件已处理、错误处理完整 |
| **代码质量** | 无安全漏洞、遵循项目规范、无冗余代码 |
| **边界校验** | API 接口类型匹配、状态流转与 UI 一致、数据模型与业务逻辑一致 |
| **可维护性** | 无隐蔽技术债、无过度抽象、测试覆盖充分 |
| **需求偏差** | 实现与计划一致、反思中风险合理、无范围蔓延 |

## 最佳实践

- **需求描述越详细越好** — 包含背景、功能点、验收标准、边界情况。简短的需求会导致方案偏差和返工
- **`deliver` 和 `review` 会自动推断** — 无需手动指定 `--plan-only` / `--code-only` / `--type`，系统根据当前状态自动决定
- **利用评审反馈修复** — 评审未通过时使用 `--fix` 参数，Claude 会基于评审报告修复问题
- **指定正确的工作目录** — 使用 `--cwd` 指向目标项目目录，Claude 需要读取项目结构才能生成准确的方案和代码
- **Dashboard 可直接操作** — 除了 CLI，也可以直接在页面点击操作按钮完成交付和评审

## 数据模型

### RequirementMeta

需求元数据，存储在 `groups` 表的 `metadata` JSON 列中（`type = 'e2ed'`）。

```typescript
interface RequirementMeta {
  reqId: string;              // 等同 groupId (UUID v4)
  status: RequirementStatusType;
  activeTask: ActiveTask;     // 当前进行中的任务，null 表示空闲
  compositeVersion: string;   // "R1.P2.C3"
  planVersions: PlanVersionMeta[];
  codeVersions: CodeVersionMeta[];
  runCount: {
    deliver: number;
    review: number;
    reqReview: number;
    planReview: number;
    codeReview: number;
  };
  timeline: Array<{ status: RequirementStatusType; at: string }>;
  source: string;             // "cli" | "api"
  links: Array<{ type: string; url: string; branch?: string }>;
}
```

### PlanVersionMeta

```typescript
interface PlanVersionMeta {
  version: number;
  dirName: string;              // "plan-v1"
  parentReqVersion: number;
  createdAt: string;
  reviewStatus: 'pass' | 'fail' | 'needs-review' | null;
}
```

### CodeVersionMeta

```typescript
interface CodeVersionMeta {
  version: number;
  dirName: string;              // "code-v1"
  parentPlanVersion: number;
  author: 'ai' | 'human';
  isFix: boolean;
  fixForCodeVersion: number | null;
  createdAt: string;
  reviewStatus: 'pass' | 'fail' | 'needs-review' | null;
}
```

## 目录结构

每个需求在 Rotom 工作目录下创建独立目录：

```
~/.rotom/results/<groupId>/
├── requirement.md                  # 原始需求文本
├── plans/
│   └── plan-v1/
│       ├── plan.md                 # 实现计划
│       └── review/
│           └── report.md           # 计划评审报告
├── code/
│   └── code-v1/
│       ├── reflection.md           # 交付自我反思
│       ├── artifacts/              # 生成的文件
│       └── review/
│           └── report.md           # 代码评审报告
└── req-reviews/
    └── review-v1/
        └── report.md               # 需求评审报告
```

## 数据库

E2ED 复用 Rotom 的 `groups` 表，通过 `type = 'e2ed'` 区分：

```sql
ALTER TABLE groups ADD COLUMN type TEXT DEFAULT NULL;
ALTER TABLE groups ADD COLUMN metadata TEXT DEFAULT '{}';
```

- `type` — 设为 `'e2ed'` 标识 E2ED 需求
- `metadata` — 存储 `RequirementMeta` JSON
- `working_dir` — 目标项目目录

## 源文件索引

| 文件 | 职责 |
|------|------|
| `src/e2ed/types.ts` | 类型定义（状态、元数据、评审结果） |
| `src/e2ed/requirement.ts` | 需求 CRUD、计划/代码版本管理、元数据读写 |
| `src/e2ed/pipeline.ts` | 流水线编排（交付/评审 Issue 创建、Git branch 写入 links） |
| `src/e2ed/prompts.ts` | Prompt 模板（交付、三种评审、Verdict 提取） |
| `src/e2ed/metrics.ts` | 度量计算（耗时统计、时间线） |
| `src/cli/e2ed.ts` | CLI 子命令入口 |
| `src/master/api/e2ed.ts` | Express API 路由（返回 workingDir、title 等富化字段） |
| `packages/dashboard/src/api/e2ed.ts` | Dashboard API 客户端（含 source、links、workingDir） |
| `packages/dashboard/src/features/e2ed/E2edGroupsView.tsx` | 需求列表组件 |
| `packages/dashboard/src/features/e2ed/E2edPipelineView.tsx` | 流水线详情组件 |
| `packages/dashboard/src/features/e2ed/E2edSidebar.tsx` | E2ED 侧边栏（需求列表 + 新建） |
