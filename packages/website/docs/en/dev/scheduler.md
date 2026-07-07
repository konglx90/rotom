# Scheduler

Rotom's scheduled-task engine: drives patrol, ask-bridge fallback detection, and a2a_direct pair-group TTL sweep.

## 1. Design

- **`next_run_at` driven**: not `last_run_at + interval`; the next-run time is maintained explicitly.
- **Two forms**:
  - `schedule_kind='interval'` + `interval_sec`: every N seconds.
  - `schedule_kind='once'` + `run_at`: fire once at a timestamp, then `enabled=0`.
- **Grace window**: on master restart, if `now - next_run_at > grace`, fast-forward to a future point (no historical catch-up). recurring uses `computeGraceSec = max(120, min(interval_sec/2, 7200))`; oneshot uses `ONESHOT_GRACE_SEC=120`.
- **At-most-once**: advance `next_run_at` before dispatching, so a crash-restart never re-runs.
- **Serial tick: 20s** (`TICK_MS=20_000`); no parallel pool needed — issues run in the worker process.

## 2. Trigger modes

- `mode='agent'`: create issue + `hub.pushIssueAssignment(group_id, agent_name)`. Skip if agent offline or the previous issue is still in_progress, but still advance `next_run_at`. Used by patrol and ask-bridge-check.
- `mode='message'`: directly `hub.postSystemToGroup(group_id, prompt)`, no agent needed. Used for periodic broadcasts.

## 3. Data model (`scheduled_tasks`)

| Column | Meaning |
|---|---|
| `mode` | agent / message |
| `schedule_kind` | interval / once |
| `interval_sec` / `run_at` | N seconds / timestamp |
| `next_run_at` | next run (driver) |
| `repeat_times` / `count` | limit / run so far |
| `handler_key` | handler id (`ask-bridge-check`, …) |
| `handler_payload` | JSON, handler-specific args |
| `enabled` | toggle |

`schedule_patterns` holds "task templates" (picked in the dashboard); `guidance_templates` holds group-guidance prompt templates.

## 4. Registered handlers

| handler_key | Purpose | Frequency |
|---|---|---|
| `ask-bridge-check` | scan pending ask-bridges, detect @ reply / 5min timeout escalation | per-bridge 20s interval |
| `issue-patrol` | issue patrol (see patrol doc) | default 7200s |
| `link-patrol` | link patrol (see patrol doc) | default 18000s |
| `a2a-direct-ttl-sweep` | archive expired a2a_direct pair groups (3-day TTL) | 1h |

> Handlers are registered at startup in `src/master/server.ts` (via `getSchedulerHandler` in `scheduler-handlers.ts`).

## 5. Key files

- `src/master/scheduler.ts` — `Scheduler` class: tick scan + grace + at-most-once advance
- `src/master/scheduler-handlers.ts` — handler implementations + `getSchedulerHandler` registry
- `src/master/api/schedules.ts` — REST CRUD + enable/disable/trigger
- `src/cli/schedule.ts` — CLI
- `tests/scheduler.test.ts` — interval/once firing

## 6. Relationships

- **Patrol**: the largest mode=agent use case.
- **Ask-bridge**: each bridge gets a 20s `ask-bridge-check` task for fallback.
- **Federation**: a2a_direct pair groups are archived periodically by `a2a-direct-ttl-sweep`.
