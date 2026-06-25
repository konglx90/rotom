import path from "node:path";
import fs from "node:fs";
import type { TokenUsage } from "../shared/protocol.js";

/** Shape persisted to ~/.rotom/sessions.json and surfaced via listAll(). */
export interface StoredSession {
  sessionId: string;
  /** Latest usage captured from the CLI backend. undefined until the first
   *  chat turn completes and the executor reports usage. */
  usage?: TokenUsage;
  /** Backend-reported model name. Same lifecycle as usage. */
  model?: string;
}

/**
 * Manages conversation sessions per group per CLI.
 * Persisted to ~/.rotom/sessions.json so sessions survive restarts.
 * Key format: `${cliTool}:${groupId}` → StoredSession
 */
export class SessionStore {
  private sessions = new Map<string, StoredSession>();
  private filePath: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(rotomDir: string) {
    this.filePath = path.join(rotomDir, "sessions.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Record<string, unknown>;
        for (const [k, v] of Object.entries(data)) {
          // Backward compat: old format was Record<string, string> (just sessionId).
          // New format is Record<string, StoredSession>. Accept both.
          if (typeof v === "string") {
            this.sessions.set(k, { sessionId: v });
          } else if (v && typeof v === "object" && typeof (v as any).sessionId === "string") {
            this.sessions.set(k, v as StoredSession);
          }
        }
        console.log(`[session-store] Loaded ${this.sessions.size} session(s) from ${this.filePath}`);
      }
    } catch (err: any) {
      console.warn(`[session-store] Failed to load: ${err.message}`);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 1000);
  }

  private flush(): void {
    if (!this.dirty) return;
    try {
      const obj: Record<string, StoredSession> = {};
      for (const [k, v] of this.sessions) {
        obj[k] = v;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
      this.dirty = false;
    } catch (err: any) {
      console.warn(`[session-store] Failed to flush: ${err.message}`);
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
    this.dirty = true;
    this.scheduleFlush();
  }

  /** Record the latest usage/model captured from the CLI backend for this
   *  session. No-op if no session exists for (cliTool, groupId). */
  recordUsage(cliTool: string, groupId: string, usage: TokenUsage | undefined, model: string | undefined): void {
    const k = this.key(cliTool, groupId);
    const existing = this.sessions.get(k);
    if (!existing) return;
    // Only update if there's something to record — avoids bumping dirty
    // (and triggering a disk flush) on every chat turn that reports nothing.
    if (!usage && !model) return;
    this.sessions.set(k, {
      ...existing,
      ...(usage ? { usage } : {}),
      ...(model ? { model } : {}),
    });
    this.dirty = true;
    this.scheduleFlush();
  }

  delete(cliTool: string, groupId: string): void {
    this.sessions.delete(this.key(cliTool, groupId));
    this.dirty = true;
    this.scheduleFlush();
  }

  has(cliTool: string, groupId: string, sessionId: string): boolean {
    return this.sessions.get(this.key(cliTool, groupId))?.sessionId === sessionId;
  }

  /**
   * Return every entry in the store, parsed from the `${cliTool}:${groupId}`
   * keys. Used by the worker's session_snapshot push so master can cache the
   * full picture without per-group requests.
   */
  listAll(): Array<{ cliTool: string; groupId: string; sessionId: string; usage?: TokenUsage; model?: string }> {
    const out: Array<{ cliTool: string; groupId: string; sessionId: string; usage?: TokenUsage; model?: string }> = [];
    for (const [k, stored] of this.sessions) {
      const sep = k.indexOf(":");
      if (sep === -1) continue;
      out.push({
        cliTool: k.slice(0, sep),
        groupId: k.slice(sep + 1),
        sessionId: stored.sessionId,
        ...(stored.usage ? { usage: stored.usage } : {}),
        ...(stored.model ? { model: stored.model } : {}),
      });
    }
    return out;
  }

  shutdown(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
