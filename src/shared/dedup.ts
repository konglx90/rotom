/**
 * Message deduplication — in-memory requestId → timestamp map with TTL cleanup.
 */

export class MessageDedup {
  private seen = new Map<string, number>();
  private ttlMs: number;

  constructor(ttlMs: number = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /** Returns true if this requestId was seen recently (within TTL). */
  isDuplicate(requestId: string): boolean {
    const ts = this.seen.get(requestId);
    if (!ts) return false;
    if (Date.now() - ts > this.ttlMs) {
      this.seen.delete(requestId);
      return false;
    }
    return true;
  }

  /** Mark a requestId as seen. */
  mark(requestId: string): void {
    this.seen.set(requestId, Date.now());
  }

  /** Evict entries older than TTL. Call periodically (e.g. every 60s). */
  cleanup(): void {
    const now = Date.now();
    for (const [id, ts] of this.seen) {
      if (now - ts > this.ttlMs) this.seen.delete(id);
    }
  }
}
