# Skills(技能)系统

Rotom 的"技能"是可复用的 markdown 规则/工作流,按需注入到 agent 的 prompt 里,驱动巡检、规范执行等场景。

## 1. 概念

一个 skill = 一段 markdown `content` + 元信息(category / source_type / source_ref)。skill 不直接执行,而是通过**绑定**关联到 (group, agent, skill),被注入 prompt 后由底层 CLI agent 读取并遵循。这绕开了 provider 侧的 skill 机制 —— master 只负责存储 + 触发注入,真正"读懂规则"的是 agent。

## 2. 数据模型

**`agent_skills`** —— skill 主表

| 列 | 含义 |
|---|---|
| `id` | UUID;种子 skill 用固定 id(如 `sk_issue_patrol_rules_seed`) |
| `name` | 唯一名 |
| `content` | markdown 规则正文 |
| `category` | 分类(workflow / patrol / …) |
| `source_type` | manual / memory(memory → skill 升级而来) |
| `source_ref` | 来源引用(memory 升级时指向 memory id) |
| `active` | 软删除标志 |
| `view_count` / `last_viewed_at` | 统计 |

**`agent_skill_bindings`** —— 绑定表(粒度:group + agent + skill)

| 列 | 含义 |
|---|---|
| `group_id` / `agent_name` / `skill_id` | 三元组,UNIQUE 防重 |
| `created_at` | 绑定时间 |

## 3. 关键文件

- `src/master/api/skills.ts` —— REST CRUD + 绑定
- `src/master/db/skills.ts` —— skill / binding 数据访问
- `src/master/db/memory.ts` `promoteMemoryToSkill` —— playbook memory 升级为 skill,`source_ref` 指向原 memory
- `tests/skills.test.ts` —— 绑定/计数/隔离/软删除用例
- 种子 skill:`migrations/001-schema.sql` 的 `sk_issue_patrol_rules_seed` / `sk_link_patrol_rules_seed`

## 4. REST 端点

`GET/POST/PUT/DELETE /skills`、`/skills/:id/bind`、`/skills/:id/unbind`、`/skills/bindings`、`/skills/mine`。

## 5. CLI

`rotom skill list|search|get|create|update|remove|bind|unbind|bindings|mine`。

## 6. 与 prompt 注入的关系

群消息 dispatch 时,`enrichWorkerDispatch`(ws-hub)会把该 (group, agent) 绑定的 active skill content 拼进发给 worker 的指令层。巡检场景下,patrol handler 主动把 rules skill 作为 few-shot 塞进 patrol issue 的 prompt。

## 7. 与其他子系统关系

- **Memory**:playbook 类 memory 可 `promoteMemoryToSkill` 升级为 skill。
- **Patrol**:issue-patrol / link-patrol 的判定规则就是两个种子 skill。
