import { type Router as ExpressRouter } from "express";
import type { MeshDb } from "../db.js";
import { createLogger } from "../../shared/logger.js";
import { extractUrls, normalizeUrl } from "../../shared/url-extractor.js";

const log = createLogger("mesh-api-links");

/**
 * PATCH /api/links/:id 时,若改了 category/tags,要顺手在 memory 强化一条
 * link_rule:<host> 规则(放在 link 出现过的 source_group,不放 global namespace)。
 * global memory 必须走人工 promote(POST /api/memory/:id/promote),不能由 link override 直接写。
 */
function overrideMemoryForLink(
  db: MeshDb,
  linkId: string,
  fields: { category?: string; tags?: string[] },
): void {
  const link = db.getLink(linkId);
  if (!link) return;
  if (fields.category === undefined && fields.tags === undefined) return;

  const sourceGroups = db.listSourceGroupsForLink(linkId);
  if (sourceGroups.length === 0) {
    log.info(`Link ${linkId} override: no source_group, skip memory reinforce`);
    return;
  }
  // 多群共享的 host 规则:取最近出现群(按 source_groups 写入顺序等价于发现顺序)
  const groupId = sourceGroups[0];

  const category = fields.category ?? "other";
  const tags = Array.isArray(fields.tags) ? fields.tags : [];
  const key = `link_rule:${link.host}`;
  const value = `[人工 override] host=${link.host} 默认分类 ${category}; tags=[${tags.join(", ")}]`;
  const summary = `${link.host} → ${category} (override)`;

  const existing = db.db.prepare(
    `SELECT id FROM agent_memory WHERE key = ? AND group_id = ? AND active = 1 LIMIT 1`,
  ).get(key, groupId) as { id: string } | undefined;

  if (existing) {
    db.updateMemory(existing.id, { value, summary, tags: ["link_classification", ...tags, "manual"], category: "convention" });
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
      tags: ["link_classification", ...tags, "manual"],
      visibility: "group",
      agentVisible: true,
      createdBy: "dashboard:link-override",
    });
  }
  log.info(`Link ${linkId} override → memory ${key} written in group ${groupId}`);
}

export function registerLinkRoutes(apiRouter: ExpressRouter, db: MeshDb): void {
  /** POST /api/links/extract — 从文本抽 URL,返回 [{raw, norm, host}]。供调试 + 单测用。 */
  apiRouter.post("/links/extract", (req, res) => {
    const { text } = req.body ?? {};
    if (typeof text !== "string") {
      res.status(400).json({ error: "text (string) is required" });
      return;
    }
    const items = extractUrls(text);
    const urls = items.map((it) => {
      const n = normalizeUrl(it.raw);
      return n ? { raw: n.raw, norm: n.norm, host: n.host } : { raw: it.raw, norm: null, host: null };
    }).filter((u) => u.norm !== null);
    res.json({ urls });
  });

  /** GET /api/links — 列表 + 过滤(category / tag / search / group_id / host)。 */
  apiRouter.get("/links", (req, res) => {
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const groupId = typeof req.query.group_id === "string" ? req.query.group_id : undefined;
    const host = typeof req.query.host === "string" ? req.query.host : undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const items = db.listLinks({ category, tag, search, groupId, host, limit, offset });
    const total = db.countLinks({ category, tag, search, groupId, host });
    res.json({ items, total, limit, offset });
  });

  /** GET /api/links/:id — 链接详情 + tags + occurrences + source_groups */
  apiRouter.get("/links/:id", (req, res) => {
    const link = db.getLink(req.params.id);
    if (!link) {
      res.status(404).json({ error: "Link not found" });
      return;
    }
    const tags = db.listTagsForLink(link.id);
    const occurrences = db.listOccurrencesForLink(link.id, 50);
    const sourceGroups = db.listSourceGroupsForLink(link.id);
    res.json({ ...link, tags, occurrences, source_groups: sourceGroups });
  });

  /** PATCH /api/links/:id — 人工 override(category/tags/title/summary)+ memory 强化。 */
  apiRouter.patch("/links/:id", (req, res) => {
    const link = db.getLink(req.params.id);
    if (!link) {
      res.status(404).json({ error: "Link not found" });
      return;
    }
    const { category, tags, title, summary } = req.body ?? {};
    const fields: { category?: string; tags?: string[]; title?: string | null; summary?: string | null } = {};
    if (typeof category === "string") fields.category = category;
    if (Array.isArray(tags)) {
      fields.tags = tags.filter((t: unknown) => typeof t === "string" && (t as string).trim()).map((t) => (t as string).trim());
    }
    if (typeof title === "string") fields.title = title;
    if (typeof summary === "string") fields.summary = summary;

    db.updateLinkClassification(link.id, fields);
    overrideMemoryForLink(db, link.id, fields);
    log.info(`Link ${link.id} patched: ${JSON.stringify(fields)}`);
    const updated = db.getLink(link.id);
    res.json({ ok: true, link: updated });
  });
}
