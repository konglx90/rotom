# Patrol(巡检)系统 —— Issue 巡检 + Link 巡检

Rotom 用定时任务驱动"巡检员" agent 周期性检查 issue 队列健康度 / 给链接分类,产出结构化结论落库。

## 1. 概念

两种巡检,各自有独立巡检群 + 巡检员 agent + 规则 skill:

- **Issue 巡检**:扫 open 且未认领的 issue,判定 `ready / not_ready / uncertain`(能否直接认领开工)。防止"挂着的旧 issue 没人理"或"大需求被盲目认领"。
- **Link 巡检**:扫未分类链接,给 `category + tags + title + rationale` 分类。

两者都是 **mode=agent 的 scheduled_task**:到点创建一条 patrol issue + `pushIssueAssignment` 派给巡检员;巡检员跑完产出 JSON result;issue 进入 terminal 时 master 解析 result 落库。

## 2. 数据模型

- `issue_patrol_runs` / `issue_patrol_logs` —— issue 巡检 run + 每条候选的判定
- `link_patrol_runs` / `link_patrol_logs` —— link 巡检 run + 每条链接的分类
- `scheduled_tasks` —— 巡检定时任务(handler_key 区分;interval 默认见下)
- 种子 skill:`sk_issue_patrol_rules_seed` / `sk_link_patrol_rules_seed`(规则正文)

## 3. 间隔默认值(易踩坑)

- **issue-patrol interval 默认 7200s(2 小时),不是 3600s**
- **link-patrol interval 默认 18000s(5 小时),不是 3600s**

改默认要同步改 `bootstrap` 常量 + Dashboard 巡检 Tab 默认值,否则两边漂移。

## 4. 关键文件

- `src/master/scheduler-handlers.ts` —— `issue-patrol` / `link-patrol` handler:候选扫描 + 优先级排序 + 建 patrol issue + fire-and-forget 派发;含 overlap 守卫、agent 在线检查、全局 in_progress 吞吐上限
- `src/master/patrol-terminal.ts` —— **统一入口 `dispatchPatrolTerminal(db, issue)`**:issue 终态时按 `getLinkPatrolRunByIssueId` 反查,命中走 link 流程,否则走 issue 流程。`server.ts` 的 `_onIssueTerminal` 钩子调它
- `src/master/api/issues-patrol.ts` / `links-patrol.ts` / `links.ts` —— 巡检状态 / run / log / 配置 REST
- `src/master/services/link-collector.ts` —— 群消息 inline hook,采集链接进 `links` 表(供 link 巡检扫)
- `migrations/001-schema.sql` —— 上述表 + 种子 skill

## 5. 终态落库

`dispatchPatrolTerminal` 分派:
- issue 流程:`handleIssuePatrolTerminal` 解析 result JSON → 写 `issue_patrol_logs`
- link 流程:`handleLinkPatrolIssueTerminal` → `UPDATE links` + 写 `link_patrol_logs` + 写 memory(分类规则 few-shot)

## 6. 与其他子系统关系

- **Scheduler**:巡检是 mode=agent 定时任务的两大用例。
- **Skills**:规则以 skill 形式存,handler 拼进 patrol issue 的 prompt。
- **Memory**:link 巡检结论沉淀进 memory。
- **Links KB**:link 巡检写回 `links` 主表。
