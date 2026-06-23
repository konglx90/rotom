# 前后端需求交付工作流（rotom 协作模型）

> 一个需求 = 一个 rotom 群。后端主导决策，前端协作者，真人兜底。

## 角色定义

| 角色 | 谁（举例） | 职责 |
|------|-----------|------|
| **后端主 agent** | 西花-claude | 需求经理：技术决策、任务拆解、排期评估、产出分工方案 |
| **前端 agent** | 西花-codex | 前端调研、向后端索取方案接口、前端执行 |
| **真人** | 西花 | 兜底：复杂实现介入、上线审批、验收归档 |

## 交付流水线总览

```
P0 建群         → 创建需求群 + 拉成员 + 建 note
P1 双端调研      → 前后端各自摸现状
P2 前端问三件事  → 后端按模板答复边界/接口/就绪度
P3 确认+写 note  → 分工方案写入 note
P4 各自出 plan   → 前后端出执行计划
P5 实现          → 简单的走 issue --run，复杂的 @人介入
P6 验收+归档     → 确认交付，更新 note 收尾
```

---

## P0 — 建群

**触发器**：一个新需求进来。

**操作**：

```bash
# 1. 建群
rotom group create "需求-xxx" --description "xxx 功能开发"

# 2. 拉角色
rotom group invite <groupId> 西花-claude   # 后端主 agent
rotom group invite <groupId> 西花-codex    # 前端 agent
# 你（西花）作为真人已在群中

# 3. 建需求 note（生命周期内持续更新）
rotom note create <groupId> \
  --title "需求-xxx-分工方案" \
  --description "## 需求描述\n[TBD]\n\n## 分工方案\n[TBD]\n\n## 接口方案\n[TBD]\n\n## 就绪状态\n[TBD]\n\n## 执行记录\n[TBD]"
```

---

## P1 — 双端调研

后端 agent 和前端 agent **各自**调研自己域的现状，发群消息同步。

**后端 agent**:

```bash
rotom group send <groupId> 全体 \
  "@全体 后端调研结论：
1. 现有 XX 模块已有 A/B 能力，缺 C
2. 需要新增 D 接口
3. 天戈 test 环境可用"
```

**前端 agent**:

```bash
rotom group send <groupId> 全体 \
  "@全体 前端调研结���：
1. XX 页面已有，缺 YY 组件
2. 数据流路径：页面 → service → GET /api/..."
```

**真人角色**：不参与，除非 agent 调研中遇到业务盲区需要你澄清。

---

## P2 — 前端问三件事

**前端 agent 主动向后端主 agent 发问**：

```bash
rotom group send <groupId> 西花-claude \
  "@西花-claude 关于这个需求，我需要知道三件事：
1. **边界**：前后端分工怎么切？
2. **接口方案**：后端提供什么接口？出入参和实现原理？
3. **就绪状态**：接口 ready 了没？天戈/联调环境/资料有什么？"
```

**后端主 agent 按结构化模板回复**：

```bash
rotom group send <groupId> 西花-codex \
  "@西花-codex

【边界】
- 前端：XXX、YYY
- 后端：ZZZ

【接口方案】
1. GET /api/xxx
   - 入参：xxx
   - 出参：xxx
   - 原理：xxx
2. POST /api/yyy
   - 入参：xxx
   - 出参：xxx
   - 原理：xxx

【就绪状态】
- GET 已上线，PUT 明晚上线
- 联调环境：http://xxx
- 天戈 appKey：xxx
- Mock 数据：xxx

【排期估计】
- 后端 1d，前端 2d，联调 0.5d"
```

---

## P3 — 确认分工 + 写入 note

**前端 agent 确认**：

```bash
rotom group send <groupId> 西花-claude \
  "@西花-claude 分工方案同意，我按这个做 plan。"
```

有异议则 PK，直到达成一致。

**后端主 agent 更新 note**：

```bash
rotom note update <noteId> \
  --description "（用 P2 的模板内容填充需求描述/分工方案/接口方案/就绪状态等字段）"
```

---

## P4 — 各自出 plan

前后端各自发执行计划：

```bash
# 前端 plan
rotom group send <groupId> 全体 \
  "@全体 前端 plan：
1. 新建 XX 组件
2. 接入 XX 页面
3. 调 GET 接口展示数据
4. 联调 POST 接口
5. 预估 2d"

# 后端 plan
rotom group send <groupId> 全体 \
  "@全体 后端 plan：
1. 加 YY 表 migration
2. 写 GET handler
3. 写 POST handler + 事务
4. 部署 test 环境
5. 预估明天上线"
```

---

## P5 — 实现

**原则**：简单功能走 `rotom issue create --run` agent 自动执行，复杂逻辑@人介入。

```bash
# 前端任务
rotom issue create <groupId> \
  --title "实现 XX 组件" \
  --description "..." \
  --assignee 西花-codex \
  --run

# 后端任务
rotom issue create <groupId> \
  --title "实现 YY API" \
  --description "..." \
  --assignee 西花-claude \
  --run
```

**真人介入节点**：
- 需求有歧义、需要你拍板
- 实现涉及外部系统对接、需要你协调
- 代码审查验收

---

## P6 — 验收 + 归档

**agent 完成时自动群公告**。你验收通过后：

```bash
# 更新 note 收尾
rotom note update <noteId> \
  --description "（原内容）\n\n## 执行记录\n✅ 前后端已上线，验收通过，<日期>"
```

---

## 一个完整需求的最小命令序列

```bash
# === P0 建群 ===
rotom group create "需求-角色管理"
rotom group invite <gId> 西花-claude 西花-codex
rotom note create <gId> --title "角色管理-分工方案" --description "## 需求描述\n[TBD]..."

# === P1 调研（agent 自动发群消息）===

# === P2 前端问三件事（agent 自动问，后端按模板回）===

# === P3 确认 + 写 note ===

# === P4 各自出 plan ===

# === P5 实现 ===
rotom issue create <gId> --title "..." --assignee 西花-codex --run
rotom issue create <gId> --title "..." --assignee 西花-claude --run

# === P6 验收 ===
rotom note update <noteId> --description "..."
```

## 设计决策

| 维度 | 选择 | 理由 |
|------|------|------|
| 群粒度 | 一个需求一个群 | 上下文隔离，互不干扰 |
| 主 agent | 后端 | 后端定边界、定接口、定排期 |
| 产出物 | rotom note | 结构化，可回溯可更新 |
| 后端回复模板 | 边界→接口→就绪→排期 | 前端 agent 程序化解析 |
| 决策权边界 | 技术+排期 | 后端也管任务拆解和工作量评估 |
| 兜底机制 | 真人@你介入 | 简单走 issue 自动跑，复杂你控 |
