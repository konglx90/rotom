# Sessions & Cost

Agent sessions per group are persisted in master DB, tracking token usage and cumulative cost; invalidated sessions are kept (stamped), not deleted.

## 1. Concept

Underlying CLIs (claude/codex/…) have their own session concept (multi-turn context reuse). Rotom registers these sessions in master DB so that: the dashboard shows full session history per group; on worker reconnect master pushes `session_sync_push` to restore; invalidated sessions (poisoned history / provider error) are stamped with `invalidated_at` and kept for audit.

## 2. Data model (`agent_sessions`)

| Column | Meaning |
|---|---|
| `group_id` / `agent_name` / `cli_tool` | owning triple |
| `session_id` | underlying CLI session id |
| `created_at` / `last_used_at` | first write / last upsert |
| `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_creation_tokens` | **last turn** usage |
| `total_cost_usd` / `model` | last turn cost + model |
| `cumulative_cost_usd` / `cumulative_*_tokens` | **cumulative across all turns** (worker-reported; master does not sum) |
| `invalidated_at` | invalidation stamp; NULL = active |

UNIQUE: `(cli_tool, group_id, session_id)` — same session upserts, never duplicates.

## 3. Upsert semantics (gotcha)

- `created_at` only written on first insert; upserts don't touch it.
- `last_used_at` refreshed on every upsert.
- `usage` / `model` / `cumulative_*` use `COALESCE(excluded.*, old.*)` — **omitted fields keep the old value** (worker stores only sessionId before reporting usage).
- `invalidated_at` is cleared to NULL on upsert — **an invalidated session receiving a new snapshot "revives"** (worker-reconnect case).
- Cumulative fields are summed by the worker and reported (master is the sole writer, avoiding concurrent-accumulate races).

## 4. Key files

- `src/master/db/agent-sessions.ts` — upsert / list / listActive / invalidate / delete / find
- `src/master/ws-hub/connection.ts` — `session_sync_push` (master→worker), `session_snapshot` / `session_invalidated` (worker→master)
- `tests/db-sessions-links.test.ts` — upsert / COALESCE / invalidate / revive / delete / lookup

## 5. Protocol messages

- `session_sync_push` (master→worker): on worker start, push active sessions to restore.
- `session_snapshot` (worker→master): after each turn, worker pushes latest usage; master upserts.
- `session_invalidated` (worker→master): worker declares a session invalid; master stamps it.

## 6. Relationships

- **Issue**: `issues.session_id` / `cli_tool` point to the session used; the continue path resumes via it.
- **Artifacts**: worktree is tied to the session.
- **Dashboard**: group-chat "Process" panel has a session debug view (view/copy/delete).
