/**
 * 巡检 issue 终态处理 —— 巡检员完成 patrol issue 后,解析 result JSON 落库。
 *
 * 由 server.ts 的 _onIssueTerminal hook 在 issue 进入 terminal 状态时调用。
 * 跟 e2ed/sync.js 同级,职责单一:解析 result → 写 issue_patrol_logs + finish run。
 */

import { randomUUID } from "node:crypto";
import type { IssueRow, MeshDb } from "./db.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("mesh-patrol-terminal");

interface PatrolVerdictEntry {
  issue_id?: string;
  verdict?: string;
  rule_matched?: string;
  rationale?: string;
}

/**
 * 解析 patrol issue 的 result(JSON 数组),逐条写 issue_patrol_logs,
 * 并 finish 对应的 run。解析失败 → run status='error'。
 */
export function handlePatrolIssueTerminal(db: MeshDb, issue: IssueRow): void {
  const run = db.getPatrolRunByIssueId(issue.id);
  if (!run) {
    log.warn(`patrol issue ${issue.id} terminal, but no run found (orphan?)`);
    return;
  }

  // 巡检员把 JSON 放在 issue.result 里。result 可能是裸 JSON,也可能被包在 markdown 代码块里。
  const raw = (issue.result ?? "").trim();
  if (!raw) {
    db.finishPatrolRun(run.run_id, "error", { note: "empty result" });
    log.warn(`patrol run ${run.run_id}: empty result`);
    return;
  }

  const parsed = parseVerdicts(raw);
  if (!parsed) {
    db.finishPatrolRun(run.run_id, "error", { note: `bad result JSON: ${raw.slice(0, 200)}` });
    log.error(`patrol run ${run.run_id}: bad result JSON`);
    return;
  }

  let readyCount = 0;
  for (const v of parsed) {
    const verdict = normalizeVerdict(v.verdict);
    if (verdict === "ready") readyCount++;
    db.insertPatrolLog({
      id: randomUUID(),
      runId: run.run_id,
      patrolGroupId: run.patrol_group_id,
      issueId: v.issue_id ?? null,
      candidateGroupId: resolveCandidateGroupId(db, v.issue_id),
      verdict,
      ruleMatched: v.rule_matched ?? null,
      rationale: v.rationale ?? null,
      raw: JSON.stringify(v),
    });
  }

  db.finishPatrolRun(run.run_id, "completed", {
    scanned: parsed.length,
    ready: readyCount,
    note: issue.status === "completed" ? undefined : `issue terminal as ${issue.status}`,
  });
  log.info(`patrol run ${run.run_id}: completed (scanned=${parsed.length}, ready=${readyCount})`);
}

function parseVerdicts(raw: string): PatrolVerdictEntry[] | null {
  // 1. 直接 JSON.parse
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
  } catch { /* fall through */ }

  // 2. 从 markdown ```json ... ``` 里抠
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const v = JSON.parse(fenceMatch[1]);
      if (Array.isArray(v)) return v;
    } catch { /* fall through */ }
  }

  // 3. 抠最外层 [ ... ]
  const bracketMatch = raw.match(/\[[\s\S]*\]/);
  if (bracketMatch) {
    try {
      const v = JSON.parse(bracketMatch[0]);
      if (Array.isArray(v)) return v;
    } catch { /* fall through */ }
  }

  return null;
}

function normalizeVerdict(v: string | undefined): "ready" | "not_ready" | "uncertain" | "skipped" {
  if (!v) return "uncertain";
  const s = String(v).toLowerCase().replace(/[-\s]/g, "_");
  if (s === "ready") return "ready";
  if (s === "not_ready") return "not_ready";
  if (s === "uncertain") return "uncertain";
  if (s === "skipped") return "skipped";
  // 兜底:关键字猜测
  if (s.includes("ready") && !s.includes("not")) return "ready";
  if (s.includes("not_ready") || s.includes("not ready")) return "not_ready";
  return "uncertain";
}

function resolveCandidateGroupId(db: MeshDb, issueId: string | undefined): string | null {
  if (!issueId) return null;
  const issue = db.getIssueById(issueId);
  return issue?.group_id ?? null;
}
