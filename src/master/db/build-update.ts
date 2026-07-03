/**
 * Dynamic `UPDATE ... SET` builder.
 *
 * Replaces the 8+ scattered `const sets = []; if (field !== undefined) { ... }`
 * patterns in db/issues.ts, db/memory.ts, db/skills.ts, db/agents.ts,
 * db/domains.ts, db/guidance-templates.ts, db/schedules.ts,
 * db/schedule-patterns.ts, db/notes.ts.
 *
 * Returns `null` when there are no set clauses (caller can short-circuit
 * without running a no-op UPDATE). Otherwise returns the SQL string and the
 * ordered bind params (set params first, then where params).
 *
 * `updatedAt` controls the auto-pushed `updated_at` column shape so each
 * table sticks to its existing convention:
 *   - "beijing"      → `?` bound to `nowBeijing()` (Beijing "YYYY-MM-DD HH:MM:SS.mmm")
 *   - "datetime-now" → `datetime('now')` (SQLite UTC, no param)
 *   - "epoch"        → `?` bound to `Date.now()` (epoch ms)
 *   - false / undefined → no auto-pushed updated_at
 */

import { nowBeijing } from "../../shared/time.js";

export type UpdatedAtMode = "beijing" | "datetime-now" | "epoch" | false;

export interface BuildUpdateOptions {
  table: string;
  /** Map of column → input value. Undefined values are skipped (no SET clause). */
  sets: Record<string, unknown>;
  /** WHERE clause without the keyword, e.g. `id = ?`. */
  where: string;
  /** Params for the WHERE clause, in order. */
  whereParams: unknown[];
  /** Auto-push `updated_at` column. Defaults to false. */
  updatedAt?: UpdatedAtMode;
  /**
   * Extra SET clauses that don't come from user input (always pushed). Each
   * entry is either a `{ sql: string, params?: unknown[] }` raw fragment or
   * a `{ column, value }` pair bound as `column = ?`. Useful for status
   * transitions or computed expressions like
   * `started_at = COALESCE(started_at, ?)`.
   */
  extraSets?: Array<
    | { sql: string; params?: unknown[] }
    | { column: string; value: unknown }
  >;
}

export interface BuiltUpdate {
  sql: string;
  params: unknown[];
}

export function buildUpdate(opts: BuildUpdateOptions): BuiltUpdate | null {
  const setClauses: string[] = [];
  const setParams: unknown[] = [];

  for (const [column, value] of Object.entries(opts.sets)) {
    if (value === undefined) continue;
    setClauses.push(`${column} = ?`);
    setParams.push(value);
  }

  if (opts.extraSets) {
    for (const ex of opts.extraSets) {
      if ("sql" in ex) {
        setClauses.push(ex.sql);
        if (ex.params) setParams.push(...ex.params);
      } else {
        setClauses.push(`${ex.column} = ?`);
        setParams.push(ex.value);
      }
    }
  }

  const mode = opts.updatedAt ?? false;
  if (mode === "beijing") {
    setClauses.push("updated_at = ?");
    setParams.push(nowBeijing());
  } else if (mode === "epoch") {
    setClauses.push("updated_at = ?");
    setParams.push(Date.now());
  } else if (mode === "datetime-now") {
    setClauses.push("updated_at = datetime('now')");
  }

  if (setClauses.length === 0) return null;

  const sql = `UPDATE ${opts.table} SET ${setClauses.join(", ")} WHERE ${opts.where}`;
  return { sql, params: [...setParams, ...opts.whereParams] };
}
