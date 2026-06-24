# 跨群共享大脑 — 设计讨论记录

> 日期：2026-06-24
> 基于 `claude-tag-introduction.md`、`memory-and-proactivity-design.md` 的延伸讨论
> 当前状态：**构思中，待定稿**

---

## 核心方向

**跨群的持续学习，所有 Agent 共享大脑。**

与 Track A（按群隔离的记忆）不同，新方向要求 Agent 在群 A 学到的知识能被群 B、群 C 的 Agent 复用，形成组织级的"默会知识"积累。

---

## 已确定的分层结构

```
┌─────────────────────────────────┐
│    全局共享记忆 (Cross-Group)     │ ← 所有 Agent 可读，组织级知识
├─────────────────────────────────┤
│    群内记忆 (Intra-Group)        │ ← 仅当前群 Agent 可读，群上下文
└─────────────────────────────────┘
```

- **群内记忆**：提案中 Track A 的 `group_memory` 表，按群隔离
- **全局共享记忆**：新增的 `shared_brain` 表，所有群 Agent 都可查询/注入
- Agent prompt 里两段都注入，先全局再群内

---

## 待定问题

### 1. 存储模型
- 全局一张 `shared_memory` 表（`group_id` 仅作来源标记，非隔离边界）
- 还是每群一张 + 聚合视图（跨群检索时合并）？

### 2. 注入策略
- 全部注入 → context 很快撑爆
- 按相关性检索注入（基于活跃 Issue 关键词/技术栈过滤）？

### 3. 写入权限
- Issue 完成自动总结 → 写入共享大脑
- 还是需要人工审核确认？

### 4. 命名空间与冲突
- 跨群共享后 key 冲突（群 A 记 `decision:logging`，群 B 也记了）
- 用 `namespace:key` 还是按优先级覆盖？

### 5. 安全 / 隔离
- 跨群共享后"上下文严格隔离"的优势弱化
- 需要额外机制防泄露（群 A 的敏感决策被群 B 读到）

### 6. 异步记忆
- 记忆提取/写入不阻塞主流程
- 后台队列处理 LLM 总结、去重、索引更新

---

## 关联的现有基础设施

| 组件 | 用途 |
|------|------|
| `migrations/024-notes.sql` | 笔记表，可作为长文记忆 |
| `src/master/scheduler.ts` | 定时任务，可用于定期记忆提炼/清理 |
| `src/shared/group-context.ts` | prompt 注入点，需要扩展 |
| `src/master/db.ts` | 数据层，需要加记忆 CRUD |
| `src/cli/note.ts` | 笔记 CLI，可参考设计记忆 CLI |

---

## 下一步

等待定稿后，从 Phase 1 开始落地：
1. 新增 migration（全局记忆表 + 群内记忆表）
2. db.ts 记忆 CRUD
3. REST 端点
4. rotom memory CLI
5. group-context.ts 注入
6. Issue complete 自动提取 hook
