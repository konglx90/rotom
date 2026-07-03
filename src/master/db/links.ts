/**
 * Links — 链接主表 / 出现记录 / 标签 / 来源群 / 巡检 run-log CRUD。
 *
 * 采集路径(inline hook):
 *   collectLinksFromText → extractUrls + normalizeUrl → dedup by url_norm
 *   命中已有 link: addLinkOccurrence + touchLinkLastSeen + (可选)addLinkSourceGroup
 *   新 link:createLink + addLinkOccurrence + addLinkSourceGroup
 *
 * 分类路径(link-patrol scheduled task + 巡检员 agent):
 *   listUnclassifiedLinks → handler 拼 prompt → pushIssueAssignment
 *   → agent 完成 issue → handleLinkPatrolIssueTerminal 解析 result → updateLinkClassification
 *
 * Methods attach via Object.assign(见 internal.ts)。
 */

import { nowBeijing } from "../../shared/time.js";
import { buildUpdate } from "./build-update.js";
import type { MeshDbSelf } from "./core.js";

// ─── Row types ────────────────────────────────────────────────────────────

export interface LinkRow {
  id: string;
  url_norm: string;
  url_raw: string;
  title: string | null;
  category: string | null;
  summary: string | null;
  host: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

export interface LinkOccurrenceRow {
  id: string;
  link_id: string;
  source_type: string;
  source_id: string | null;
  source_group_id: string | null;
  source_sender: string | null;
  context_snippet: string | null;
  occurred_at: string;
}

export interface LinkPatrolRunRow {
  run_id: string;
  patrol_group_id: string;
  patrol_issue_id: string | null;
  started_at: string;
  finished_at: string | null;
  candidates_scanned: number;
  candidates_classified: number;
  status: "dispatched" | "completed" | "skipped" | "agent_offline" | "error";
  note: string | null;
}

export interface LinkPatrolLogRow {
  id: string;
  run_id: string;
  link_id: string | null;
  category: string;
  tags: string | null;
  title: string | null;
  rationale: string | null;
  raw: string | null;
  created_at: string;
}

// ─── Inputs ───────────────────────────────────────────────────────────────

export interface CreateLinkInput {
  id: string;
  urlNorm: string;
  urlRaw: string;
  host: string;
}

export interface AddOccurrenceInput {
  sourceType: string; // 'group_message'
  sourceId?: string | null;
  sourceGroupId?: string | null;
  sourceSender?: string | null;
  contextSnippet?: string | null;
}

export interface ListLinksFilter {
  category?: string;
  tag?: string;
  search?: string;
  groupId?: string;
  host?: string;
  limit?: number;
  offset?: number;
}

// ─── Methods ──────────────────────────────────────────────────────────────

export const linkMethods = {
  // ─── Link 主表 ────────────────────────────────────────────────────────

  /** INSERT OR IGNORE,命中 UNIQUE(url_norm) 时返回 undefined。 */
  createLink(this: MeshDbSelf, input: CreateLinkInput): void {
    const now = nowBeijing();
    this.db.prepare(`
      INSERT OR IGNORE INTO links (id, url_norm, url_raw, title, category, summary, host, created_at, updated_at, last_seen_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)
    `).run(input.id, input.urlNorm, input.urlRaw, input.host, now, now, now);
  },

  getLinkByUrlNorm(this: MeshDbSelf, urlNorm: string): LinkRow | undefined {
    return this.db.prepare("SELECT * FROM links WHERE url_norm = ?").get(urlNorm) as LinkRow | undefined;
  },

  getLink(this: MeshDbSelf, id: string): LinkRow | undefined {
    return this.db.prepare("SELECT * FROM links WHERE id = ?").get(id) as LinkRow | undefined;
  },

  /** 更新 last_seen_at + updated_at。同 link 多次出现时累加 occurrence 后调。 */
  touchLinkLastSeen(this: MeshDbSelf, id: string): void {
    const now = nowBeijing();
    this.db.prepare(
      "UPDATE links SET last_seen_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, id);
  },

  /** 巡检员写分类结果。tags 为空数组时清空标签。 */
  updateLinkClassification(
    this: MeshDbSelf,
    id: string,
    fields: { category?: string; tags?: string[]; title?: string | null; summary?: string | null },
  ): boolean {
    // 1. UPDATE links 主表(category / title / summary)
    const built = buildUpdate({
      table: "links",
      sets: {
        category: fields.category,
        title: fields.title,
        summary: fields.summary,
      },
      where: "id = ?",
      whereParams: [id],
      updatedAt: "beijing",
    });
    if (built) this.db.prepare(built.sql).run(...built.params);

    // 2. tags 多对多:传了就重写(先 DELETE 再 INSERT)
    if (Array.isArray(fields.tags)) {
      this.db.prepare("DELETE FROM link_tags WHERE link_id = ?").run(id);
      if (fields.tags.length > 0) {
        const stmt = this.db.prepare(
          "INSERT OR IGNORE INTO link_tags (link_id, tag) VALUES (?, ?)",
        );
        for (const tag of fields.tags) {
          if (typeof tag === "string" && tag.trim()) stmt.run(id, tag.trim());
        }
      }
    }
    return true;
  },

  /** 列表过滤。tag 过滤走 link_tags JOIN;search 在 url_raw / title / host 上 LIKE。 */
  listLinks(this: MeshDbSelf, filter: ListLinksFilter = {}): LinkRow[] {
    const {
      category, tag, search, groupId, host,
      limit = 50, offset = 0,
    } = filter;
    const where: string[] = [];
    const params: unknown[] = [];
    if (category) { where.push("category = ?"); params.push(category); }
    if (host) { where.push("host = ?"); params.push(host); }
    if (search) {
      where.push("(url_raw LIKE ? OR title LIKE ? OR host LIKE ?)");
      const kw = `%${search}%`;
      params.push(kw, kw, kw);
    }
    if (tag) {
      where.push("id IN (SELECT link_id FROM link_tags WHERE tag = ?)");
      params.push(tag);
    }
    if (groupId) {
      where.push("id IN (SELECT link_id FROM link_source_groups WHERE group_id = ?)");
      params.push(groupId);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit, offset);
    return this.db.prepare(
      `SELECT * FROM links ${whereClause} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`,
    ).all(...params) as LinkRow[];
  },

  countLinks(this: MeshDbSelf, filter: ListLinksFilter = {}): number {
    const { category, tag, search, groupId, host } = filter;
    const where: string[] = [];
    const params: unknown[] = [];
    if (category) { where.push("category = ?"); params.push(category); }
    if (host) { where.push("host = ?"); params.push(host); }
    if (search) {
      where.push("(url_raw LIKE ? OR title LIKE ? OR host LIKE ?)");
      const kw = `%${search}%`;
      params.push(kw, kw, kw);
    }
    if (tag) {
      where.push("id IN (SELECT link_id FROM link_tags WHERE tag = ?)");
      params.push(tag);
    }
    if (groupId) {
      where.push("id IN (SELECT link_id FROM link_source_groups WHERE group_id = ?)");
      params.push(groupId);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const row = this.db.prepare(
      `SELECT COUNT(*) as n FROM links ${whereClause}`,
    ).get(...params) as { n: number };
    return row?.n ?? 0;
  },

  /** 取未分类链接(category IS NULL)按 last_seen_at desc,scheduler handler 用。 */
  listUnclassifiedLinks(this: MeshDbSelf, limit: number = 20): Array<LinkRow & { first_context: string | null }> {
    return this.db.prepare(`
      SELECT l.*, (
        SELECT context_snippet FROM link_occurrences
        WHERE link_id = l.id
        ORDER BY occurred_at ASC
        LIMIT 1
      ) AS first_context
      FROM links l
      WHERE l.category IS NULL
      ORDER BY l.last_seen_at DESC
      LIMIT ?
    `).all(limit) as Array<LinkRow & { first_context: string | null }>;
  },

  // ─── Tags ─────────────────────────────────────────────────────────────

  listTagsForLink(this: MeshDbSelf, linkId: string): string[] {
    const rows = this.db.prepare(
      "SELECT tag FROM link_tags WHERE link_id = ? ORDER BY tag",
    ).all(linkId) as { tag: string }[];
    return rows.map((r) => r.tag);
  },

  // ─── Occurrences ──────────────────────────────────────────────────────

  addLinkOccurrence(this: MeshDbSelf, linkId: string, input: AddOccurrenceInput): void {
    const id = (`occ_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
    this.db.prepare(`
      INSERT INTO link_occurrences (id, link_id, source_type, source_id, source_group_id, source_sender, context_snippet, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, linkId, input.sourceType,
      input.sourceId ?? null,
      input.sourceGroupId ?? null,
      input.sourceSender ?? null,
      input.contextSnippet ?? null,
      nowBeijing(),
    );
  },

  listOccurrencesForLink(this: MeshDbSelf, linkId: string, limit: number = 50): LinkOccurrenceRow[] {
    return this.db.prepare(
      "SELECT * FROM link_occurrences WHERE link_id = ? ORDER BY occurred_at DESC LIMIT ?",
    ).all(linkId, limit) as LinkOccurrenceRow[];
  },

  // ─── Source groups(多对多)────────────────────────────────────────────

  addLinkSourceGroup(this: MeshDbSelf, linkId: string, groupId: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO link_source_groups (link_id, group_id) VALUES (?, ?)",
    ).run(linkId, groupId);
  },

  listSourceGroupsForLink(this: MeshDbSelf, linkId: string): string[] {
    const rows = this.db.prepare(
      "SELECT group_id FROM link_source_groups WHERE link_id = ?",
    ).all(linkId) as { group_id: string }[];
    return rows.map((r) => r.group_id);
  },

  // ─── Patrol runs / logs ───────────────────────────────────────────────

  createLinkPatrolRun(
    this: MeshDbSelf,
    input: {
      runId: string;
      patrolGroupId: string;
      patrolIssueId?: string | null;
      startedAt?: string;
      candidatesScanned?: number;
      status?: LinkPatrolRunRow["status"];
    },
  ): void {
    const now = input.startedAt ?? nowBeijing();
    this.db.prepare(`
      INSERT INTO link_patrol_runs
        (run_id, patrol_group_id, patrol_issue_id, started_at, finished_at, candidates_scanned, candidates_classified, status, note)
      VALUES (?, ?, ?, ?, NULL, ?, 0, ?, NULL)
    `).run(
      input.runId,
      input.patrolGroupId,
      input.patrolIssueId ?? null,
      now,
      input.candidatesScanned ?? 0,
      input.status ?? "dispatched",
    );
  },

  finishLinkPatrolRun(
    this: MeshDbSelf,
    runId: string,
    status: LinkPatrolRunRow["status"],
    opts?: { classified?: number; note?: string | null },
  ): void {
    const built = buildUpdate({
      table: "link_patrol_runs",
      sets: {
        candidates_classified: opts?.classified,
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

  getLinkPatrolRunByIssueId(this: MeshDbSelf, patrolIssueId: string): LinkPatrolRunRow | undefined {
    return this.db.prepare(
      "SELECT * FROM link_patrol_runs WHERE patrol_issue_id = ? ORDER BY started_at DESC LIMIT 1",
    ).get(patrolIssueId) as LinkPatrolRunRow | undefined;
  },

  getLinkPatrolRun(this: MeshDbSelf, runId: string): LinkPatrolRunRow | undefined {
    return this.db.prepare(
      "SELECT * FROM link_patrol_runs WHERE run_id = ?",
    ).get(runId) as LinkPatrolRunRow | undefined;
  },

  listLinkPatrolRuns(this: MeshDbSelf, opts?: { patrolGroupId?: string; limit?: number }): LinkPatrolRunRow[] {
    const limit = Math.min(opts?.limit ?? 50, 500);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts?.patrolGroupId) {
      where.push("patrol_group_id = ?");
      params.push(opts.patrolGroupId);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit);
    return this.db.prepare(
      `SELECT * FROM link_patrol_runs ${whereClause} ORDER BY started_at DESC LIMIT ?`,
    ).all(...params) as LinkPatrolRunRow[];
  },

  insertLinkPatrolLog(
    this: MeshDbSelf,
    input: {
      id: string;
      runId: string;
      linkId?: string | null;
      category: string;
      tags?: string[] | null;
      title?: string | null;
      rationale?: string | null;
      raw?: string | null;
    },
  ): void {
    this.db.prepare(`
      INSERT INTO link_patrol_logs
        (id, run_id, link_id, category, tags, title, rationale, raw, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.runId,
      input.linkId ?? null,
      input.category,
      input.tags ? JSON.stringify(input.tags) : null,
      input.title ?? null,
      input.rationale ?? null,
      input.raw ?? null,
      nowBeijing(),
    );
  },

  listLinkPatrolLogsForRun(this: MeshDbSelf, runId: string): LinkPatrolLogRow[] {
    return this.db.prepare(
      "SELECT * FROM link_patrol_logs WHERE run_id = ? ORDER BY created_at ASC",
    ).all(runId) as LinkPatrolLogRow[];
  },
};
