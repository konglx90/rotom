/**
 * Parse helpers for untrusted JSON strings.
 *
 * Use `safeJsonParse(s, fallback)` whenever the caller's contract is
 * "parse if valid, otherwise use a default" — replaces the
 *   try { x = JSON.parse(s || "{}"); } catch { /* fall back *\/ }
 * boilerplate that appears across the codebase.
 */

export function safeJsonParse<T>(
  s: string | null | undefined,
  fallback: T,
): T {
  if (s == null || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
