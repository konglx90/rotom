/**
 * CLI route / query-string / usage / fetch helpers.
 *
 * Replaces the hand-rolled `${encodeURIComponent(gid)}` template strings,
 * `URLSearchParams` + `?${qs.toString() ? \`?${qs}\` : ""}` boilerplate,
 * `fail("usage: rotom <cmd> ...")` lines, and bootstrap fetches in
 * `cli/init.ts` / `cli/join.ts` that bypassed `common.ts:api()` because they
 * have no `ResolvedAgent` yet.
 *
 * Existing `common.ts` exports (`api`, `fail`, `masterHttpUrl`, ...) are the
 * foundation — `routes.ts` builds on top, not around them.
 */

import { fail, masterHttpUrl } from "./common.js";

// ── Route builder ─────────────────────────────────────────────────────────

/**
 * Substitute `:name` placeholders in `template` with URL-encoded segments.
 *
 *   route("/groups/:groupId/issues/:issueId", gid, iid)
 *   → "/groups/<encoded gid>/issues/<encoded iid>"
 *
 * The placeholder names are documentation only — segments are positional and
 * substituted in order. Throws if the segment count doesn't match the
 * placeholder count, so typos in the template surface at the call site.
 */
export function route(template: string, ...segs: string[]): string {
  const placeholders = template.match(/:[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  if (placeholders.length !== segs.length) {
    throw new Error(
      `route(${template}): expected ${placeholders.length} segment(s), got ${segs.length}`,
    );
  }
  let out = template;
  for (let i = 0; i < segs.length; i++) {
    out = out.replace(placeholders[i], encodeURIComponent(segs[i]));
  }
  return out;
}

// ── Query-string builder ──────────────────────────────────────────────────

/**
 * Build a query string from a params map. Returns either `""` (no params) or
 * `"?k=v&k2=v2"`. Skips `undefined` / empty-string values, coerces numbers to
 * string, URL-encodes both keys and values.
 *
 *   qs({ status: "open", limit: 50, type: undefined })
 *   → "?status=open&limit=50"
 */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

// ── Usage helpers ─────────────────────────────────────────────────────────

/**
 * Print `usage: rotom <cmd> <hint>` to stderr and exit 1. `hint` is the
 * literal post-`rotom ` text — e.g. `usage("ask list", "rotom ask list --group <id>")`
 * emits `usage: rotom ask list --group <id>` (matching the existing
 * `fail("usage: rotom ...")` strings, so output stays byte-identical).
 */
export function usage(cmd: string, hint?: string): never {
  const hintStr = hint ? ` ${hint}` : "";
  fail(`usage: rotom ${cmd}${hintStr}`);
}

/**
 * Print `unknown <cmd> subcommand: <sub | "(none)">` to stderr and exit 1.
 * Used at the tail of every CLI command's subcommand dispatch.
 */
export function unknownSubcommand(cmd: string, sub: string | undefined): never {
  fail(`unknown ${cmd} subcommand: ${sub || "(none)"}`);
}

// ── Master URL helpers ─────────────────────────────────────────────────────

/**
 * Build a `ws://` (or `wss://`) URL from a master spec that may be either
 * `http://host:port` or `ws://host:port`. The inverse of `masterHttpUrl`.
 * Strips trailing slashes for consistency.
 */
export function masterWsUrl(masterHttpOrWs: string): string {
  return masterHttpOrWs
    .replace(/^http:\/\//, "ws://")
    .replace(/^https:\/\//, "wss://")
    .replace(/\/+$/, "");
}

/** Build `http://host:port` from raw `host` + `port`. */
export function masterHttpBase(host: string, port: string | number): string {
  return `http://${host}:${port}`;
}

/** Build `ws://host:port` from raw `host` + `port`. */
export function masterWsBase(host: string, port: string | number): string {
  return `ws://${host}:${port}`;
}

// ── Bootstrap fetch (no auth) ──────────────────────────────────────────────

export interface MasterFetchResult {
  status: number;
  data: unknown;
}

/**
 * Fetch a master URL without an auth token — for bootstrap paths (init, join)
 * that don't yet have a `ResolvedAgent`. Always sets `Content-Type:
 * application/json` and parses the response as JSON (falling back to the raw
 * text if the body isn't valid JSON). Does NOT retry — callers decide how to
 * handle non-2xx and network errors.
 */
export async function masterFetch(
  url: string,
  init?: RequestInit,
): Promise<MasterFetchResult> {
  const merged: RequestInit = {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  };
  const resp = await fetch(url, merged);
  const text = await resp.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: resp.status, data };
}

export { masterHttpUrl };
