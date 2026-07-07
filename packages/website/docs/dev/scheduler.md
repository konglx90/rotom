# Scheduler(群内定时任务调度器)

Rotom 的定时任务引擎:驱动巡检、ask-bridge 兜底检测、a2a_direct pair 群 TTL 清扫等。

## 1. 设计要点

- **`next_run_at` 字段驱动**:不靠 `last_run_at + interval` 算,而是显式维护下次运行时间。
- **两种形态**:
  - `schedule_kind='interval'` + `interval_sec`:每 N 秒一次。
  - `schedule_kind='once'` + `run_at`:指定时间戳跑一次,跑完 `enabled=0`。
- **grace window 防宕机堆积**:master 宕机重启,若 `now - next_run_at > grace` 就 fast-forward 到下一个未来点,不补跑历史。recurring 用 `computeGraceSec = max(120, min(interval_sec/2, 7200))`;一次性用 `ONESHOT_GRACE_SEC=120`。
- **at-most-once**:执行前先把 `next_run_at` 推进到下一个时间点,再派 issue / 发消息,崩溃重启不会重跑。
- **串行 tick:20s 一次**(`TICK_MS=20_000`),无需并行池;issue 在 worker 进程跑,不阻塞 scheduler。

## 2. 两种触发模式

- `mode='agent'`:创建 issue + `hub.pushIssueAssignment(group_id, agent_name)`。agent 离线或上一轮 issue 仍 in_progress 就跳过,但 `next_run_at` 仍推进。巡检、ask-bridge-check 用此模式。
- `mode='message'`:直接 `hub.postSystemToGroup(group_id, prompt)`,无需 agent。定时播报用此模式。

## 3. 数据模型(`scheduled_tasks`)

| 列 | 含义 |
|---|---|
| `mode` | agent / message |
| `schedule_kind` | interval / once |
| `interval_sec` / `run_at` | interval 时 N 秒 / once 时时间戳 |
| `next_run_at` | 下次运行时间(驱动字段) |
| `repeat_times` / `count` | 限定次数 / 已跑次数 |
| `handler_key` | handler 标识(`ask-bridge-check` 等) |
| `handler_payload` | JSON,handler 专属参数 |
| `enabled` | 开关 |

`schedule_patterns` 表存"定时任务模板"(Dashboard 建 task 时选);`guidance_templates` 存群引导 prompt 模板。

## 4. 已注册 handler

| handler_key | 作用 | 触发频率 |
|---|---|---|
| `ask-bridge-check` | 扫 pending ask-bridge,检测 @ 回复 / 5min 超时升级 | 每 bridge 20s 自带 interval |
| `issue-patrol` | issue 巡检(见 patrol 文档) | 默认 7200s |
| `link-patrol` | link 巡检(见 patrol 文档) | 默认 18000s |
| `a2a-direct-ttl-sweep` | 扫过期 a2a_direct pair 群归档(3 天 TTL) | 1h |

> handler 注册在 `src/master/server.ts` 启动时(`scheduler-handlers.ts` 的 `getSchedulerHandler`)。

## 5. 关键文件

- `src/master/scheduler.ts` —— `Scheduler` 类:tick 扫描 + grace + at-most-once 推进
- `src/master/scheduler-handlers.ts` —— 各 handler 实现 + `getSchedulerHandler` 注册表
- `src/master/api/schedules.ts` —— REST CRUD + enable/disable/trigger
- `src/cli/schedule.ts` —— CLI
- `tests/scheduler.test.ts` —— interval/once 触发用例

## 6. 与其他子系统关系

- **Patrol**:巡检是 mode=agent 定时任务的最大用例。
- **Ask-bridge**:每条 bridge 配一个 20s 的 `ask-bridge-check` 任务做兜底。
- **Federation**:a2a_direct pair 群由 `a2a-direct-ttl-sweep` 定期归档。
