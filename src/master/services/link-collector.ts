/**
 * Link collector —— 消息发送路径上的 inline hook。
 *
 * 用法:在 4 个 addGroupMessage 调用点之后,直接调
 *   collectLinksFromText(text, ctx, db)
 * 函数内部纯函数式抽 URL → 规范化 → dedup by url_norm → 入库。
 *
 * 错误隔离:整个流程包 try/catch,失败只 log.warn,绝不影响消息发送主路径。
 * 不抓 system sender 的消息(系统消息不含真实业务链接,且会重复触发)。
 */

import { randomUUID } from "node:crypto";
import type { MeshDb } from "../db.js";
import {
  extractUrls,
  normalizeUrl,
  extractContextSnippet,
} from "../../shared/url-extractor.js";
import { createLogger } from "../../shared/logger.js";

const log = createLogger("link-collector");

export interface CollectCtx {
  sourceType: "group_message";
  sourceId: string; // msgId
  sourceGroupId?: string;
  sourceSender?: string;
}

/**
 * 从消息正文抽 URL 入库。
 * 同一消息内多次出现的同一 URL 也各算一次 occurrence(防漏抓上下文)。
 */
export function collectLinksFromText(
  text: string,
  ctx: CollectCtx,
  db: MeshDb,
): void {
  if (!text) return;
  // system sender 跳过
  if (ctx.sourceSender && ctx.sourceSender === "system") return;

  let extracted;
  try {
    extracted = extractUrls(text);
  } catch (err) {
    log.warn(`extractUrls failed: ${(err as Error).message}`);
    return;
  }
  if (extracted.length === 0) return;

  for (const item of extracted) {
    try {
      const norm = normalizeUrl(item.raw);
      if (!norm) continue; // 非法 / 非 http(s) 丢弃

      const snippet = extractContextSnippet(text, item.index, item.raw.length);

      const existing = db.getLinkByUrlNorm(norm.norm);
      if (existing) {
        db.addLinkOccurrence(existing.id, {
          sourceType: ctx.sourceType,
          sourceId: ctx.sourceId,
          sourceGroupId: ctx.sourceGroupId,
          sourceSender: ctx.sourceSender,
          contextSnippet: snippet,
        });
        db.touchLinkLastSeen(existing.id);
        if (ctx.sourceGroupId) db.addLinkSourceGroup(existing.id, ctx.sourceGroupId);
      } else {
        const linkId = randomUUID();
        db.createLink({
          id: linkId,
          urlNorm: norm.norm,
          urlRaw: norm.raw,
          host: norm.host,
        });
        // 并发情况:另一个 collector tick 可能在我们 createLink 之前抢先 INSERT,
        // INSERT OR IGNORE 后再查一次确保有 row(若已被抢先,existing 就拿到那个 id)
        const again = db.getLinkByUrlNorm(norm.norm);
        const finalId = again?.id ?? linkId;
        db.addLinkOccurrence(finalId, {
          sourceType: ctx.sourceType,
          sourceId: ctx.sourceId,
          sourceGroupId: ctx.sourceGroupId,
          sourceSender: ctx.sourceSender,
          contextSnippet: snippet,
        });
        if (ctx.sourceGroupId) db.addLinkSourceGroup(finalId, ctx.sourceGroupId);
      }
    } catch (err) {
      // 单条失败不影响其他链接
      log.warn(`collectLinksFromText: URL "${item.raw}" 失败: ${(err as Error).message}`);
    }
  }
}
