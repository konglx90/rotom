import fs from "node:fs";
import path from "node:path";
import type { TokenUsage } from "../shared/protocol.js";

/** Shape held in memory and surfaced via listAll(). Persisted to master DB
 *  via session_snapshot pushes; no longer written to local JSON file. */
export interface StoredSession {
  sessionId: string;
  /** Latest usage captured from the CLI backend. undefined until the first
   *  chat turn completes and the executor reports usage. */
  usage?: TokenUsage;
  /** Backend-reported model name. Same lifecycle as usage. */
  model?: string;
  /** 累计成本(USD),跨该 chat session 所有 turn 的 totalCostUsd 之和。
   *  recordUsage 每次把当前 turn 的 totalCostUsd 累加进来;session 失效
   *  重建(sessionId 变更)时清零。undefined 表示从未报告过 cost。 */
  cumulativeCostUsd?: number;
}

/**
 * In-memory registry of conversation sessions per group per CLI.
 *
 * Persistence moved to master DB (`agent_sessions` table). On startup the
 * worker receives a `session_sync_push` from master with all its active
 * sessions; mutations are pushed back via `session_snapshot`. The old
 * `~/.rotom/sessions.json` file is gone — master is the single source of
 * truth, which fixes the multi-worker flush-overwrite bug and lets the
 * dashboard surface full session history (including invalidated ones).
 *
 * Key format: `${cliTool}:${groupId}` → StoredSession
 */
export class SessionStore {
  private sessions = new Map<string, StoredSession>();

  /** Populate from master's session_sync_push on startup. Merges with any
   *  existing in-memory state (e.g. legacy backfill) — master entries only
   *  fill in (cliTool, groupId) pairs the store doesn't already have. */
  hydrate(entries: Array<{ cliTool: string; groupId: string; sessionId: string; usage?: TokenUsage | null; model?: string | null; cumulativeCostUsd?: number }>): void {
    let added = 0;
    for (const e of entries) {
      const k = this.key(e.cliTool, e.groupId);
      if (this.sessions.has(k)) continue;
      const stored: StoredSession = { sessionId: e.sessionId };
      if (e.usage) stored.usage = e.usage;
      if (e.model) stored.model = e.model;
      if (typeof e.cumulativeCostUsd === "number") stored.cumulativeCostUsd = e.cumulativeCostUsd;
      this.sessions.set(k, stored);
      added++;
    }
    if (added > 0) {
      console.log(`[session-store] Hydrated ${added} session(s) from master (of ${entries.length} pushed)`);
    }
  }

  /**
   * One-time migration: read the legacy `~/.rotom/sessions.json` file and
   * populate the in-memory store. The file is deleted after reading so
   * subsequent starts don't re-backfill (which would overwrite newer DB
   * state). Safe to call multiple times — no-op if the file is gone.
   *
   * Called once from executor index.ts after constructing the shared
   * SessionStore. After this, master DB is the source of truth.
   */
  backfillFromLegacyJson(rotomHome: string): void {
    const file = path.join(rotomHome, "sessions.json");
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch {
      return; // file gone or never existed — normal path after first migration
    }
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      let count = 0;
      for (const [k, v] of Object.entries(data)) {
        const sep = k.indexOf(":");
        if (sep === -1) continue;
        const cliTool = k.slice(0, sep);
        const groupId = k.slice(sep + 1);
        if (typeof v === "string") {
          this.sessions.set(k, { sessionId: v });
          count++;
        } else if (v && typeof v === "object" && typeof (v as any).sessionId === "string") {
          const obj = v as any;
          const stored: StoredSession = { sessionId: obj.sessionId };
          if (obj.usage) stored.usage = obj.usage;
          if (obj.model) stored.model = obj.model;
          if (typeof obj.cumulativeCostUsd === "number") stored.cumulativeCostUsd = obj.cumulativeCostUsd;
          this.sessions.set(k, stored);
          count++;
        }
      }
      console.log(`[session-store] Backfilled ${count} session(s) from legacy ${file}`);
      // Delete the file so we never re-backfill (would clobber DB state).
      try {
        fs.unlinkSync(file);
        console.log(`[session-store] Removed legacy ${file}`);
      } catch (err: any) {
        console.warn(`[session-store] Failed to remove legacy ${file}: ${err.message}`);
      }
    } catch (err: any) {
      console.warn(`[session-store] Failed to parse legacy ${file}: ${err.message} (leaving file in place)`);
    }
  }

  private key(cliTool: string, groupId: string): string {
    return `${cliTool}:${groupId}`;
  }

  get(cliTool: string, groupId: string): string | undefined {
    return this.sessions.get(this.key(cliTool, groupId))?.sessionId;
  }

  set(cliTool: string, groupId: string, sessionId: string): void {
    // Preserve existing usage/model when the sessionId is being refreshed
    // (e.g. a new chat turn returned the same sessionId). If the sessionId
    // truly changed, clear stale usage — the new session has no turns yet.
    const k = this.key(cliTool, groupId);
    const existing = this.sessions.get(k);
    if (existing && existing.sessionId === sessionId) {
      this.sessions.set(k, { ...existing, sessionId });
    } else {
      this.sessions.set(k, { sessionId });
    }
  }

  /** Record the latest usage/model captured from the CLI backend for this
   *  session. No-op if no session exists for (cliTool, groupId). */
  recordUsage(cliTool: string, groupId: string, usage: TokenUsage | undefined, model: string | undefined): void {
    const k = this.key(cliTool, groupId);
    const existing = this.sessions.get(k);
    if (!existing) return;
    // Only update if there's something to record — avoids bumping state
    // on every chat turn that reports nothing.
    if (!usage && !model) return;
    // 累加 cost:usage.totalCostUsd 是本次 turn 的成本,加到 cumulativeCostUsd。
    // usage 本身仍整体覆盖(保留"最近一 turn 用量"语义)。
    const turnCost = typeof usage?.totalCostUsd === "number" ? usage.totalCostUsd : 0;
    const newCumulative = (existing.cumulativeCostUsd ?? 0) + turnCost;
    this.sessions.set(k, {
      ...existing,
      ...(usage ? { usage } : {}),
      ...(model ? { model } : {}),
      cumulativeCostUsd: newCumulative,
    });
  }

  delete(cliTool: string, groupId: string): void {
    this.sessions.delete(this.key(cliTool, groupId));
  }

  has(cliTool: string, groupId: string, sessionId: string): boolean {
    return this.sessions.get(this.key(cliTool, groupId))?.sessionId === sessionId;
  }

  /**
   * Return every entry in the store, parsed from the `${cliTool}:${groupId}`
   * keys. Used by the worker's session_snapshot push so master can persist
   * to DB.
   */
  listAll(): Array<{ cliTool: string; groupId: string; sessionId: string; usage?: TokenUsage; model?: string; cumulativeCostUsd?: number }> {
    const out: Array<{ cliTool: string; groupId: string; sessionId: string; usage?: TokenUsage; model?: string; cumulativeCostUsd?: number }> = [];
    for (const [k, stored] of this.sessions) {
      const sep = k.indexOf(":");
      if (sep === -1) continue;
      out.push({
        cliTool: k.slice(0, sep),
        groupId: k.slice(sep + 1),
        sessionId: stored.sessionId,
        ...(stored.usage ? { usage: stored.usage } : {}),
        ...(stored.model ? { model: stored.model } : {}),
        ...(typeof stored.cumulativeCostUsd === "number" ? { cumulativeCostUsd: stored.cumulativeCostUsd } : {}),
      });
    }
    return out;
  }
}
