# Memory(记忆)系统

Rotom 的 agent 记忆库:跨 turn 沉淀的事实/决策/约定/坑/待办/playbook,按可见性分层注入 prompt 或对 agent 不可见。

## 1. 概念

记忆是"群内可复用的知识",分 scope(group / global)与 visibility(private / group / global)。private 记忆只有写入 agent 自己可见;group/global 对群内 agent 可见。**global 可见 + agent 可见**的记忆必须先经 `pending_review`,由真人审批后才对 agent 暴露 —— 防止脏记忆污染所有 agent。

## 2. 数据模型(`agent_memory`)

| 列 | 含义 |
|---|---|
| `scope` | group / global(group 时带 group_id) |
| `category` | fact / decision / convention / pitfall / todo / playbook / note |
| `visibility` | private / group / global |
| `agent_visible` | 0/1,是否对 agent 路径可见(note 默认 0;pending 默认 0) |
| `pending_review` | 0/1,待真人审批(global 写入默认 1) |
| `injected_count` | search 命中 +1(被注入次数) |
| `view_count` | get +1(被读取次数) |
| `expires_at` | 过期时间(可选) |
| `active` | 软删除 |

## 3. 可见性矩阵

| 写入 | visibility | pending_review | agent_visible | agent 路径可见? |
|---|---|---|---|---|
| 私有 | private | 0 | 1 | 仅本人 |
| 群内 | group | 0 | 1 | 群内 agent |
| 全局 | global | **1** | 0 | 否,待审批 |
| 全局审批后 | global | 0 | 1 | 全 agent |
| note(旧兼容) | * | 0 | **0** | 否 |

> 规则:visibility=global 且 agent_visible=true 的记忆必须经 pending_review。自动写规则放在 group scope,不放 global。

## 4. 关键文件

- `src/master/db/memory.ts` —— addMemory / listMemory / searchMemory / promoteMemoryVisibility / approveMemory / memoryStats
- `src/master/api/memory.ts` —— REST CRUD + 审批 + stats
- `src/cli/memory.ts` —— CLI;`memory stats --stale` 因 `/memory/stale` 端点未实现,会告警并近似
- `tests/memory.test.ts` —— 覆盖可见性隔离 / pending / 计数 / 升级 / 审批 / 旧 note 兼容

## 5. 计数语义

- `injected_count`:每次 `searchMemory` 命中该条 +1(代表"被注入 prompt 的次数")。
- `view_count`:每次 `getMemory` +1。
- `memoryStats`:按 category / byAgentVisible / topViewed 汇总。

## 6. 与其他子系统关系

- **Skills**:playbook memory 可 `promoteMemoryToSkill` 升级为 skill(`source_ref` 指回 memory)。
- **Patrol**:link-patrol 巡检员把分类结论写回 memory(分类规则 + few-shot)。
- **Prompt 注入**:群消息 dispatch 时按 (group, agent) 注入可见记忆的 summary。
