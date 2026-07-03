/**
 * @-mention extraction.
 *
 * The pattern `/@([\w一-鿿][\w.一-鿿-]*)/g` matches a leading @ followed by an
 * identifier that may contain ASCII word chars, CJK (一-鿿), dots, and hyphens.
 * Extracted to `shared/mention.ts` so the 8+ call sites across master/ws-hub
 * and master/api keep the same matching rules and slicing convention.
 *
 * `extractMentions` returns the names without the leading @. Returns an empty
 * array for falsy / no-match input. No dedup — callers historically consumed
 * the raw match list, so the helper preserves that.
 */

const MENTION_RE = /@([\w一-鿿][\w.一-鿿-]*)/g;

export function extractMentions(content: string | null | undefined): string[] {
  if (!content) return [];
  const out: string[] = [];
  for (const m of content.matchAll(MENTION_RE)) {
    out.push(m[1]);
  }
  return out;
}
