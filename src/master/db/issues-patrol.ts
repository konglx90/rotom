import { nowBeijing } from "../../shared/time.js";
import { buildUpdate } from "./build-update.js";
/**
 * Issue 巡检 —— runs/logs CRUD。
 *
 * 巡检本身是 patrol 群里的 scheduled_tasks 行(handler_key='issue-patrol'),
 * 每小时跑一次 handler,派一个 issue 给巡检员 agent。巡检员完成后,
 * server.ts 的 _onIssueTerminal hook 解析 result JSON,写日志到这里。
 *
 * 跟 issues.ts 一样,methods 挂到 MeshDb via Object.assign。
 */

import type { MeshDbSelf } from "./core.js";

export interface IssuePatrolRunRow {
  run_id: string;
  patrol_group_id: string;
  patrol_issue_id: string | null;
  started_at: string;
  finished_at: string | null;
  in_progress_count: number;
  candidates_scanned: number;
  candidates_ready: number;
  status: "dispatched" | "completed" | "skipped_quota" | "skipped_overlap" | "agent_offline" | "error";
  note: string | null;
}

export interface IssuePatrolLogRow {
  id: string;
  run_id: string;
  patrol_group_id: string;
  issue_id: string | null;
  candidate_group_id: string | null;
  verdict: "ready" | "not_ready" | "uncertain" | "skipped";
  rule_matched: string | null;
  rationale: string | null;
  raw: string | null;
  created_at: string;
}

export interface InsertPatrolLogInput {
  id: string;
  runId: string;
  patrolGroupId: string;
  issueId?: string | null;
  candidateGroupId?: string | null;
  verdict: IssuePatrolLogRow["verdict"];
  ruleMatched?: string | null;
  rationale?: string | null;
  raw?: string | null;
}

export const issuePatrolMethods = {
  createPatrolRun(
    this: MeshDbSelf,
    input: {
      runId: string;
      patrolGroupId: string;
      patrolIssueId?: string | null;
      startedAt?: string;
      inProgressCount: number;
      status?: IssuePatrolRunRow["status"];
    },
  ): void {
    const now = input.startedAt ?? nowBeijing();
    this.db.prepare(`
      INSERT INTO issue_patrol_runs
        (run_id, patrol_group_id, patrol_issue_id, started_at, in_progress_count, candidates_scanned, candidates_ready, status, note)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, NULL)
    `).run(
      input.runId,
      input.patrolGroupId,
      input.patrolIssueId ?? null,
      now,
      input.inProgressCount,
      input.status ?? "dispatched",
    );
  },

  /** 标记本轮结束。scanned/ready/note 不传则保留原值。 */
  finishPatrolRun(
    this: MeshDbSelf,
    runId: string,
    status: IssuePatrolRunRow["status"],
    opts?: { scanned?: number; ready?: number; note?: string | null },
  ): void {
    const built = buildUpdate({
      table: "issue_patrol_runs",
      sets: {
        candidates_scanned: opts?.scanned,
        candidates_ready: opts?.ready,
        note: opts?.note,
      },
      where: "run_id = ?",
      whereParams: [runId],
      updatedAt: false,
      extraSets: [
        { column: "finished_at", value: nowBeijing() },
        { column: "status", value: status },
      ],
    });
    if (built) this.db.prepare(built.sql).run(...built.params);
  },

  getPatrolRunByIssueId(this: MeshDbSelf, patrolIssueId: string): IssuePatrolRunRow | undefined {
    return this.db.prepare(
      "SELECT * FROM issue_patrol_runs WHERE patrol_issue_id = ? ORDER BY started_at DESC LIMIT 1",
    ).get(patrolIssueId) as IssuePatrolRunRow | undefined;
  },

  getPatrolRun(this: MeshDbSelf, runId: string): IssuePatrolRunRow | undefined {
    return this.db.prepare("SELECT * FROM issue_patrol_runs WHERE run_id = ?").get(runId) as IssuePatrolRunRow | undefined;
  },

  listPatrolRuns(this: MeshDbSelf, opts?: { patrolGroupId?: string; limit?: number; offset?: number }): IssuePatrolRunRow[] {
    const limit = Math.min(opts?.limit ?? 50, 200);
    const offset = Math.max(opts?.offset ?? 0, 0);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.patrolGroupId) {
      where.push("patrol_group_id = ?");
      params.push(opts.patrolGroupId);
    }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit, offset);
    return this.db.prepare(
      `SELECT * FROM issue_patrol_runs ${whereClause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    ).all(...params) as IssuePatrolRunRow[];
  },

  countPatrolRuns(this: MeshDbSelf, opts?: { patrolGroupId?: string }): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.patrolGroupId) {
      where.push("patrol_group_id = ?");
      params.push(opts.patrolGroupId);
    }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const row = this.db.prepare(
      `SELECT COUNT(*) as n FROM issue_patrol_runs ${whereClause}`,
    ).get(...params) as { n: number };
    return row?.n ?? 0;
  },

  insertPatrolLog(this: MeshDbSelf, input: InsertPatrolLogInput): void {
    const now = nowBeijing();
    this.db.prepare(`
      INSERT INTO issue_patrol_logs
        (id, run_id, patrol_group_id, issue_id, candidate_group_id, verdict, rule_matched, rationale, raw, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.runId,
      input.patrolGroupId,
      input.issueId ?? null,
      input.candidateGroupId ?? null,
      input.verdict,
      input.ruleMatched ?? null,
      input.rationale ?? null,
      input.raw ?? null,
      now,
    );
  },

  listPatrolLogsForRun(this: MeshDbSelf, runId: string): IssuePatrolLogRow[] {
    return this.db.prepare(
      "SELECT * FROM issue_patrol_logs WHERE run_id = ? ORDER BY created_at ASC",
    ).all(runId) as IssuePatrolLogRow[];
  },

  listPatrolLogs(this: MeshDbSelf, opts?: {
    patrolGroupId?: string;
    verdict?: IssuePatrolLogRow["verdict"];
    candidateGroupId?: string;
    limit?: number;
  }): IssuePatrolLogRow[] {
    const limit = Math.min(opts?.limit ?? 200, 1000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.patrolGroupId) { where.push("patrol_group_id = ?"); params.push(opts.patrolGroupId); }
    if (opts?.verdict) { where.push("verdict = ?"); params.push(opts.verdict); }
    if (opts?.candidateGroupId) { where.push("candidate_group_id = ?"); params.push(opts.candidateGroupId); }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);
    return this.db.prepare(
      `SELECT * FROM issue_patrol_logs ${whereClause} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params) as IssuePatrolLogRow[];
  },
};
