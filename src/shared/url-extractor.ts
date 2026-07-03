/**
 * URL 抽取 + 规范化 —— 链接采集层的基础工具。
 *
 * 用法:从消息正文里抽 URL(markdown [text](url) + 裸 URL),规范化后供 dedup/入库。
 *
 * 设计原则:
 *   - 纯函数,无 IO,可单测
 *   - 解析失败 / 非 http(s) 直接丢
 *   - 规范化去掉追踪参数(utm_* / fbclid / gclid / ref 等)和 hash,host 小写,去 www. 前缀,删末尾 /
 */

/** 抽到的 URL 原始信息(未规范化,含 index 供 context snippet 用)。 */
export interface ExtractedUrl {
  raw: string;
  index: number; // 在原文中的起始位置
}

/** 规范化后的 URL 信息。 */
export interface NormalizedUrl {
  raw: string;
  norm: string; // 规范化后 URL,dedup key
  host: string; // 小写 host(去 www.)
}

const MD_URL_RE = /\[(?:[^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RE = /(https?:\/\/[^\s<>"')]+[^\s<>"').,;:!?])/g;

/** 从文本抽 URL。返回 [{raw, index}],不去重(同一 URL 多次出现各算一条)。 */
export function extractUrls(text: string): ExtractedUrl[] {
  if (!text) return [];
  const out: ExtractedUrl[] = [];
  const seen = new Set<number>(); // 防同一位置被两个正则同时命中

  // 1. markdown [text](url) 形式 —— 抓括号内的 url
  for (const m of text.matchAll(MD_URL_RE)) {
    const url = m[1];
    const idx = (m.index ?? 0) + m[0].indexOf(url);
    if (!seen.has(idx)) {
      out.push({ raw: url, index: idx });
      seen.add(idx);
    }
  }

  // 2. 裸 URL —— 剥掉 trailing 标点
  for (const m of text.matchAll(BARE_URL_RE)) {
    const url = m[1];
    const idx = (m.index ?? 0) + (m[0].length - url.length);
    if (!seen.has(idx)) {
      out.push({ raw: url, index: idx });
      seen.add(idx);
    }
  }

  // 按出现位置排序,context snippet 用
  out.sort((a, b) => a.index - b.index);
  return out;
}

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_name",
  "fbclid", "gclid", "gclsrc", "dclid", "msclkid", "yclid",
  "ref", "ref_src", "ref_url",
  "_hsenc", "_hsmi", "hsCtaTracking",
  "mc_cid", "mc_eid",
  "si", // youtube shorts tracking
]);

/**
 * 规范化 URL。
 * 失败(非法 URL / 非 http(s))返回 null,调用方丢弃。
 */
export function normalizeUrl(raw: string): NormalizedUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  // host:小写 + 去 www.
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

  // path:去末尾 /,空 path 留空
  let path = parsed.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  // percent-encoded 大写一致性(避开大小写差异导致的 dedup miss)
  try {
    path = decodeURIComponent(path);
  } catch {
    // decode 失败(乱码)保留原样
  }

  // query:剥追踪参数,剩余按 key 字典序排(dedup 友好)
  const keepParams: string[] = [];
  const search = parsed.searchParams;
  if (search.size > 0) {
    for (const [k, v] of search.entries()) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
      keepParams.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    keepParams.sort();
  }

  const norm = `https://${host}${path}${keepParams.length > 0 ? `?${keepParams.join("&")}` : ""}`;
  return { raw, norm, host };
}

/** 从文本 + URL 位置截 context snippet(url 前后各 100 字,去 newline)。 */
export function extractContextSnippet(text: string, urlIndex: number, urlLen: number, radius = 100): string {
  if (!text) return "";
  const start = Math.max(0, urlIndex - radius);
  const end = Math.min(text.length, urlIndex + urlLen + radius);
  const snippet = text.slice(start, end);
  return snippet.replace(/\s+/g, " ").trim();
}
