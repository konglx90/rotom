/**
 * 巡检 issue 终态处理 —— 巡检员完成 patrol issue 后,解析 result JSON 落库。
 *
 * 由 server.ts 的 _onIssueTerminal hook 在 issue 进入 terminal 状态时调用。
 * 跟 e2ed/sync.js 同级,职责单一:解析 result → 写 issue_patrol_logs + finish run。
 *
 * 入口分两条路径:
 *   - handleIssuePatrolTerminal: issue-patrol 巡检员 → 写 issue_patrol_logs
 *   - handleLinkPatrolIssueTerminal: link-patrol 巡检员 → UPDATE links + 写 link_patrol_logs + memory
 *
 * 统一入口 dispatchPatrolTerminal(issue) 先按 issueId 反查 link_patrol_runs,
 * 命中走 link 流程,否则 fallback 到 issue 流程。
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

interface LinkVerdictEntry {
  link_id?: string;
  category?: string;
  tags?: string[];
  title?: string;
  rationale?: string;
}

/**
 * 统一入口:issue 终态时 server.ts 调这个。
 * 优先反查 link_patrol_runs.patrol_issue_id —— 命中走 link 分类流程,
 * 否则 fallback 到 issue 巡检流程。
 */
export function dispatchPatrolTerminal(db: MeshDb, issue: IssueRow): void {
  const linkRun = db.getLinkPatrolRunByIssueId(issue.id);
  if (linkRun) {
    handleLinkPatrolIssueTerminal(db, issue);
    return;
  }
  handleIssuePatrolTerminal(db, issue);
}

/**
 * 解析 patrol issue 的 result(JSON 数组),逐条写 issue_patrol_logs,
 * 并 finish 对应的 run。解析失败 → run status='error'。
 */
export function handleIssuePatrolTerminal(db: MeshDb, issue: IssueRow): void {
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

/**
 * 解析 link-patrol issue 的 result(JSON 数组),逐条:
 *   - UPDATE links SET category/tags/title
 *   - INSERT link_patrol_logs
 * 然后合并本轮学到的规则写入 agent_memory(scope=global, tags=link_classification)。
 * 解析失败 → run status='error'。
 */
export function handleLinkPatrolIssueTerminal(db: MeshDb, issue: IssueRow): void {
  const run = db.getLinkPatrolRunByIssueId(issue.id);
  if (!run) {
    log.warn(`link-patrol issue ${issue.id} terminal, but no run found (orphan?)`);
    return;
  }

  const raw = (issue.result ?? "").trim();
  if (!raw) {
    db.finishLinkPatrolRun(run.run_id, "error", { note: "empty result" });
    log.warn(`link-patrol run ${run.run_id}: empty result`);
    return;
  }

  const parsed = parseLinkVerdicts(raw);
  if (!parsed) {
    db.finishLinkPatrolRun(run.run_id, "error", { note: `bad result JSON: ${raw.slice(0, 200)}` });
    log.error(`link-patrol run ${run.run_id}: bad result JSON`);
    return;
  }

  let classifiedCount = 0;
  /** 按聚合:同 host 的多 link 共用一条规则 */
  const rulesByHost = new Map<string, { category: string; tagsSet: Set<string>; sampleLink: string }>();

  for (const v of parsed) {
    const linkId = v.link_id;
    const category = (v.category ?? "other").toString();
    const tags = Array.isArray(v.tags)
      ? v.tags.filter((t) => typeof t === "string" && t.trim()).map((t) => (t as string).trim())
      : [];
    const title = typeof v.title === "string" ? v.title : null;
    const rationale = typeof v.rationale === "string" ? v.rationale : null;

    if (!linkId) continue;
    const link = db.getLink(linkId);
    if (!link) {
      log.warn(`link-patrol: link ${linkId} not found, skip`);
      continue;
    }

    db.updateLinkClassification(linkId, { category, tags, title });
    db.insertLinkPatrolLog({
      id: randomUUID(),
      runId: run.run_id,
      linkId,
      category,
      tags,
      title,
      rationale,
      raw: JSON.stringify(v),
    });
    classifiedCount++;

    // 累积 host 规则
    const entry = rulesByHost.get(link.host);
    if (entry) {
      entry.tagsSet = new Set([...entry.tagsSet, ...tags]);
    } else {
      rulesByHost.set(link.host, { category, tagsSet: new Set(tags), sampleLink: link.url_raw });
    }
  }

  // 合并写入 agent_memory(每 host 一条,upsert:同 key 已存在就 update value/tags)
  for (const [host, info] of rulesByHost.entries()) {
    upsertLinkRuleMemory(db, issue.group_id, host, info.category, [...info.tagsSet], info.sampleLink, "system:link-patrol");
  }

  db.finishLinkPatrolRun(run.run_id, "completed", {
    classified: classifiedCount,
    note: issue.status === "completed" ? undefined : `issue terminal as ${issue.status}`,
  });
  log.info(`link-patrol run ${run.run_id}: completed (classified=${classifiedCount}, rules_learned=${rulesByHost.size})`);
}

/**
 * 把一条 host 级规则写入 agent_memory,scope=group / group_id=patrolGroupId / category=convention
 * / tags=["link_classification"]。注意:link-patrol 自动学到的规则放 patrol-link 群,不放 global
 * —— global namespace 必须人工 review / promote 才能进。下一轮 link-patrol handler 拼 prompt 时
 * 仍可被 listMemory({ groupId, tags:["link_classification"] }) 拉出。
 * key = `link_rule:${host}`。同 key 已存在 → 合并 tags,刷新 value;不存在 → INSERT。
 */
function upsertLinkRuleMemory(
  db: MeshDb,
  groupId: string,
  host: string,
  category: string,
  tags: string[],
  sampleUrl: string,
  createdBy: string,
): void {
  const key = `link_rule:${host}`;
  const existing = db.db.prepare(
    `SELECT id, tags FROM agent_memory WHERE key = ? AND group_id = ? AND active = 1 LIMIT 1`,
  ).get(key, groupId) as { id: string; tags: string } | undefined;

  const value = `host=${host} 默认分类 ${category}; tags=[${tags.join(", ")}]; 样例=${sampleUrl}`;
  const summary = `${host} → ${category}`;
  const mergedTags = Array.from(new Set(["link_classification", ...tags]));

  if (existing) {
    let oldTags: string[] = [];
    try {
      const parsed = JSON.parse(existing.tags);
      if (Array.isArray(parsed)) oldTags = parsed.filter((t) => typeof t === "string");
    } catch { /* ignore */ }
    const finalTags = Array.from(new Set([...mergedTags, ...oldTags]));
    db.updateMemory(existing.id, { value, summary, tags: finalTags, category: "convention" });
  } else {
    const memId = `mem_link_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.addMemory({
      id: memId,
      scope: "group",
      groupId,
      category: "convention",
      sourceType: "manual",
      key,
      value,
      summary,
      tags: mergedTags,
      visibility: "group",
      agentVisible: true,
      createdBy,
    });
  }
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

/** 解析 link-patrol result JSON。复用 parseVerdicts 的三种 fallback,但类型不同。 */
function parseLinkVerdicts(raw: string): LinkVerdictEntry[] | null {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
  } catch { /* fall through */ }

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const v = JSON.parse(fenceMatch[1]);
      if (Array.isArray(v)) return v;
    } catch { /* fall through */ }
  }

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
