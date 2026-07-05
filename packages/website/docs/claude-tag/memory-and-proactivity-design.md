# 持续记忆与主动出击 — 设计提案

> 相关文章：`docs/claude-tag-introduction.md`  
> 现有基础设施：`src/master/scheduler.ts`（定时任务调度器）、`src/shared/group-context.ts`（群上下文注入）、`migrations/024-notes.sql`（笔记表）、`src/cli/note.ts`（笔记 CLI）

---

## 现状盘点

### 已有的

| 组件 | 状态 | 说明 |
|------|------|------|
| `scheduler.ts` | ✅ 已实现 | interval/once 调度，agent 模式（建 Issue + push）和 message 模式（发系统通知），grace window 防堆积，at-most-once 语义 |
| `scheduled_tasks` 表 | ✅ 已实现 | 支持 agent/message 两种模式，repeat_times 限制，auto-disable |
| `notes` 表 + CLI | ✅ 已实现 | 按群的 CRUD 笔记，手动管理，**不自动注入到 agent prompt** |
| `group-context.ts` | ✅ 已实现 | 注入 groupId + groupName + selfName + 活跃 Issue 列表，**无记忆注入** |

### 缺失的

| 能力 | Claude Tag | Rotom |
|------|-----------|-------|
| 持续学习 | Claude 在频道中积累隐式记忆 | ❌ 只有 stateless 的 prompt 注入 |
| 跨任务记忆 | Claude 记住之前的决策和偏好 | ❌ 每个 Issue 都是全新上下文 |
| 主动推送 | Ambient 模式 "我觉得你需要知道 X" | ❌ 只有规则驱动的自动抢单 |
| 记忆 + 定时联动 | Claude 自己决定什么时候做什么 | ❌ 调度器只做 "到点发指令" |

---

## Track A：持续记忆（Group Memory）

### 设计目标

让 Agent 在每个群里有一块"会成长的记忆"——随着 Issue 的完成和群聊的积累，Agent 逐渐了解这个群的工作习惯、技术偏好、历史决策，不需要每次都从零开始。

### 设计

#### 1. 记忆存储层

新增 `group_messages` 表基础上的记忆抽象层，不建新表，而是利用已有的**消息 + Issue + 笔记**数据，加一个**记忆索引表**：

```sql
-- group_memory: 按群隔离的结构化记忆条目
CREATE TABLE IF NOT EXISTS group_memory (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL CHECK (source_type IN ('auto_extract','manual','issue_summary')),
  source_ref    TEXT,                    -- 来源引用: issue_id / message_id / note_id
  key           TEXT NOT NULL,           -- 记忆键, 如 "tech_stack","decision:2026-06-24"
  value         TEXT NOT NULL,           -- 记忆内容, 自由文本
  tags          TEXT DEFAULT '[]',       -- JSON 标签数组, 用于分类检索
  created_by    TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  expires_at    TEXT,                    -- NULL=永久有效; 可设置过期时间
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_group_memory_group ON group_memory(group_id, active);
CREATE INDEX IF NOT EXISTS idx_group_memory_key  ON group_memory(group_id, key);
```

#### 2. 记忆来源

**自动提取**：Issue 完成时，自动总结关键决策/产出为记忆条目
- Issue complete → 调用 LLM 总结 → 写入 `group_memory`（`source_type='issue_summary'`）
- 总结内容包括：做了什么、为什么这么做、技术选型、注意事项

**手动记录**：Agent 在群聊中通过命令写入
- Agent prompt 里注入 `[群记忆]` 块，Agent 可以读取当前群的记忆
- Agent 通过 `rotom group remember <key> <value>` 添加记忆
- 示例：`rotom group remember g-001 "decision:logging" "统一使用 pino logger，不走 console.log"`

**群笔记关联**：已有的 `notes` 表作为长文记忆，`group_memory` 作为结构化键值记忆，两者互补

#### 3. 记忆注入到 prompt

在 `injectGroupContext()` 中增加记忆块：

```typescript
// 注入后的 prompt 示例 (新增 [群记忆] 段)
[群消息 context: groupId=g-001, groupName="保险理赔讨论群", 你自己是="AgentA"]
[群活跃 issue]
- #a1b2c3d4  in_progress  "修复理赔金额计算 bug" by AgentB
[群记忆]
- tech_stack: TypeScript + pnpm workspace + SQLite WAL (by AgentB, 2026-06-20)
- decision:logging: 统一使用 pino logger，不走 console.log (by AgentA, 2026-06-22)
- decision:test: 新增逻辑必须补单元测试，覆盖率不低于 80% (auto_extract, 2026-06-23)
- note: 数据库 migration 指南 — 见笔记 "DB Migration Playbook"
```

记忆的注入策略：
- 默认注入最近 N 条（如 20 条）active 记忆
- Agent 可以通过 `--key` 过滤特定维度的记忆
- 过期记忆（`expires_at`）自动排除

#### 4. Agent 操作记忆的方式

通过 rotom CLI 扩展：

```bash
rotom memory list <groupId>                    # 列出群记忆
rotom memory list <groupId> --key tech_stack    # 按 key 过滤
rotom memory add <groupId> --key <k> --value <v> [--tags '["tag1","tag2"]']
rotom memory remove <memoryId>
rotom memory expire <memoryId>                  # 标记过期
```

Agent 在 prompt 中通过这些命令操作记忆。不需要新增 MCP 工具——全部通过 Bash 调 rotom CLI。

#### 5. 自动失效策略

- 按 key 去重：同一个 key 的新值覆盖旧值（保留历史版本，`active=0`）
- 显式过期时间：`expires_at` 字段
- 数量上限：每个群最多保留 500 条 active 记忆，超出时自动淘汰最旧的

---

## Track B：定时任务 + 主动出击

### 设计目标

利用已有的 `scheduler.ts` + 新增的 `group_memory`，让 Agent 能"到点主动做事"，实现 Rotom 版的 ambient 模式。

### 设计

#### 1. 新增两种调度模式

现有 `scheduler.ts` 支持 `agent` 和 `message` 两种模式。新增：

**`ambient` 模式** — Agent 自主检查 + 主动推送：

```
scheduler tick → 定时到了
  → Scheduler 创建 Issue + push 给 Agent
  → Agent 启动时 prompt 里注入:
     - [群活跃 issue]
     - [群记忆]
     - [定时任务指令] "检查群里是否有 stale 超过 2 天的 Issue，报告进展"
  → Agent 读取群数据、读记忆、做判断
  → Agent 调用 rotom group send 主动汇报结果
  → Issue complete → 自动总结本次动作为记忆
```

这与已有的 `agent` 模式区别在于：
- 已有 `agent` 模式：Scheduler 建 Issue → push 给 Agent → Agent 执行指令 → 完成
- `ambient` 模式：同上，但**强调 Agent 自己判断"要不要做、怎么做"**，不是机械执行

实际上**不需要改 scheduler.ts 的代码**，`ambient` 模式只是一个语义标签——区别在于定时任务的 prompt 怎么写：

```sql
-- 现有 agent 模式: "每周一早上 9 点推送代码覆盖率报告"
INSERT INTO scheduled_tasks (name, group_id, mode, agent_name, schedule_kind, interval_sec, prompt, ...)
VALUES ('weekly-coverage-report', 'g-001', 'agent', 'AgentA', 'interval', 604800,
  '请生成上周代码覆盖率报告并推送到群里。先读群记忆了解上次使用的格式。');

-- 新增 ambient 语义: "每 2 小时检查一下有没有需要你注意的事"
INSERT INTO scheduled_tasks (name, group_id, mode, agent_name, schedule_kind, interval_sec, prompt, ...)
VALUES ('ambient-checkin', 'g-001', 'agent', 'AgentA', 'interval', 7200,
  '[ambient] 请检查群里是否有 stale Issue、未回复的消息、或你之前答应过但还没做的事。'
  '如果有值得注意的，发一条总结到群里。没有就什么都不做。');
```

#### 2. 记忆驱动的主动行为

这是真正的"主动出击"——定时任务 + 记忆的组合：

```typescript
// 场景：AgentA 每 4 小时检查一次群记忆里有没有过期待办
scheduler task: "ambient-todo-check"
interval: 4h
prompt: |
  [ambient] 请执行以下步骤：
  1. 读群记忆，找出所有 key 以 "todo:" 开头且未完成的条目
  2. 检查这些 todo 对应的 Issue 状态
  3. 如果有已完成但未更新记忆的，更新记忆为 done
  4. 如果有长时间无进展的，发群消息提醒
  5. 如果没有需要处理的，什么都不做
```

#### 3. 典型主动场景

| 场景 | 调度方式 | 行为 |
|------|---------|------|
| **每日站会总结** | `interval: 86400` | 每天早 9 点 Agent 总结昨天群里的进展 |
| **Stale Issue 提醒** | `interval: 21600` | 每 6 小时检查是否有 3 天未更新的 Issue |
| **记忆清理** | `interval: 86400` | 每天清理过期记忆、合并重复条目 |
| **上下文预热** | `interval: 3600` | 每小时 Agent 读一遍群记忆，保持上下文新鲜 |
| **决策跟进** | `once` + 记忆 | 某项决策定了一周后自动提醒 check 执行情况 |
| **竞品监控** | `interval: 43200` | Agent 每 12 小时检查外部数据源，有变化主动通知 |

#### 4. 防打扰机制

主动推送不能变成"噪音"。约束：

- **静默模式**：如果没有任何值得注意的发现，Agent 不发送任何消息（prompt 里写明）
- **频次上限**：同一个 Agent 在同一个群里主动推送不超过 1 次/小时
- **重要度分级**：Agent 在信息前加 `[info]` / `[warning]` / `[action-required]` 前缀
- **用户可关闭**：群成员可以通过 `rotom task disable <taskId>` 停用某个定时任务

---

## 实现路线

### Phase 1：记忆基础设施

1. 新增 `migrations/025-group-memory.sql` — `group_memory` 表
2. 扩展 `db.ts` — `MeshDb` 增加记忆 CRUD 方法
3. 新增 `src/master/api/memory.ts` — REST 端点 `GET/POST/PUT /groups/:id/memory`
4. 新增 `src/cli/memory.ts` — `rotom memory` 子命令
5. 扩展 `group-context.ts` — `injectGroupMemory()` 从 DB 拉取最近 N 条注入 prompt
6. Issue complete 时自动调用 LLM 提取记忆（hook 在 `worker.ts` 的完成逻辑里）

### Phase 2：主动出击

1. 确认 `scheduler.ts` 的 `agent` 模式已满足需求（应该不需要改代码）
2. 编写典型 ambient 场景的定时任务 seed 脚本
3. 扩展 `group-context.ts` 注入定时任务上下文：当前任务的调度信息（`[定时任务: 你被定时触发, 任务是...]`）
4. 添加防打扰保护（group-context 中增加 "如果无事可汇报，请勿发送消息" 的指令）

### Phase 3：迭代优化

1. Dashboard 上查看/管理群记忆
2. 记忆的向量化检索（可选，取决于使用量）
3. 定时任务的 Dashboard UI（创建/启停/查看执行历史）

---

## 与现有系统的关系

```
                     ┌─────────────────────────────┐
                     │      group-context.ts        │
                     │  ┌───────────────────────┐   │
                     │  │ [群消息 context]        │   │ ← 已有的
                     │  │ [群活跃 issue]          │   │ ← 已有的
                     │  │ [群记忆]                │   │ ← Phase 1 新增
                     │  │ [定时任务上下文]          │   │ ← Phase 2 新增
                     │  └───────────────────────┘   │
                     └──────────┬──────────────────┘
                                │ inject
                     ┌──────────▼──────────────────┐
                     │      Agent Prompt             │
                     │  (被 spawn 的 CLI 进程收到)    │
                     └─────────────────────────────┘
```

数据流：

```
Issue complete ──→ 自动提取记忆 ──→ group_memory 表
                                           │
scheduler tick ──→ 创建 Issue ──→ push Agent
                                           │
Agent 启动 ──→ group-context 注入 ──→ 读记忆 + 读群消息 + 执行
                                           │
Agent 完成 ──→ 更新记忆 ──→ 推送结果到群 ──→ 等待下次调度
```

---

## 与 Claude Tag 的设计哲学差异

```
Claude Tag:  隐式记忆 + AI 直觉 → 自主决定何时推送
             "Claude 自己觉得这事重要"
             
Rotom:      显式记忆 + 规则调度 → 定时检查 + 按指令行动
             "到点了，查一下有什么值得说的"
```

Rotom 的优势是**可预测和可审计**——你知道 Agent 什么时候会因为什么原因发消息；
Claude Tag 的优势是**更智能和更低摩擦**——不需要人配置规则。

这个设计保持了 Rotom 的"结构化"基因，同时补上了持续学习和主动性的短板。

---

*本设计提案基于 Rotom 现有架构（scheduler / group-context / notes / 消息 Issue 体系）编写。*
