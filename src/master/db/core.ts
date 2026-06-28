/**
 * MeshDbCore — constructor, schema migration, lifecycle hooks.
 *
 * Domain modules (./agents.ts, ./issues.ts, ...) attach their methods to the
 * `MeshDb` class via `Object.assign(this, ...)` in the subclass constructor.
 * They type their methods against this interface so cross-domain calls
 * (e.g. messages.enqueueOffline → agents.getAgentById) type-check.
 */

import type BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IssueRow, ScheduledTaskRow } from "./types.js";
import type { GroupRow } from "./groups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// better-sqlite3 is optionalDependency (only needed for Master).
// Dynamic import keeps dashboard builds from pulling it in.
let Database: typeof BetterSqlite3 | undefined;
try {
  Database = (await import("better-sqlite3")).default as typeof BetterSqlite3;
} catch {
  // Will remain undefined — MeshDb constructor will throw a clear error.
}

/**
 * Public surface every domain method sees when typed as `this: MeshDbCore`.
 * Domain modules declare method-level signatures against this shape so the
 * TS compiler resolves cross-domain calls (e.g. issues.updateIssueStatus →
 * this._onIssueTerminal) without needing the full MeshDb class.
 */
export interface MeshDbSelf {
  readonly db: BetterSqlite3.Database;
  _onIssueTerminal?: (issueId: string) => void;
  // Methods that span multiple domain modules — declared here so cross-module
  // call sites type-check. Filled in by MeshDb's constructor after Object.assign.
  getAgentById(id: string): unknown;
  listAgents(filter?: unknown): unknown[];
  getConfig(key: string): string | undefined;
  setConfig(key: string, value: string): void;
  getIssueById(id: string): IssueRow | undefined;
  addIssueEvent(event: {
    issueId: string; eventType: string; agentName: string;
    content?: string; metadata?: Record<string, unknown>;
  }): void;
  /** 覆盖式写入 issues.latest_todos_json。供 ws-hub 处理 issue_todos_update 时调用。 */
  updateIssueTodos(issueId: string, todos: unknown[]): void;
  listGroups(): (GroupRow & { member_count: number })[];
  getRoundTracker(issueId: string, round: number): { agent_name: string; has_contributed: number }[];
  getScheduledTask(id: number): ScheduledTaskRow | undefined;
  /** ask_bridges 模块:createAskBridge 内部回查用。 */
  getAskBridge(id: string): unknown;
  /** 取 group_messages.content;scheduler 创建超时 Issue 时复述原问题用。 */
  getGroupMessageContent(msgId: number): string | undefined;
}

export class MeshDbCore {
  readonly db: BetterSqlite3.Database;
  /** Hook fired when an issue transitions to a terminal state. */
  _onIssueTerminal?: (issueId: string) => void;

  constructor(dbPath: string) {
    if (!Database) {
      throw new Error(
        "better-sqlite3 is required for Master mode but not installed.\n" +
        "Run: pnpm install better-sqlite3   (or npm install better-sqlite3)",
      );
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /**
   * Migration with version tracking.
   *
   * Walks ./migrations/ at the project root, applies any *.sql files whose
   * numeric prefix is not yet recorded in schema_version. Falls back to
   * ../migrations if the file was moved (kept for the build artifacts layout
   * where dist/master/db/internal.js resolves one level deeper).
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      )
    `);

    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_version").all() as { version: number }[])
        .map(r => r.version),
    );

    let migDir = path.resolve(__dirname, "../../../../migrations");
    if (!fs.existsSync(migDir)) {
      migDir = path.resolve(__dirname, "../../../migrations");
    }

    const files = fs.readdirSync(migDir).filter(f => f.endsWith(".sql")).sort();
    for (const file of files) {
      const match = file.match(/^(\d+)/);
      if (!match) continue;
      const version = parseInt(match[1], 10);
      if (applied.has(version)) continue;

      const sql = fs.readFileSync(path.join(migDir, file), "utf-8");
      this.db.exec(sql);
      this.db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
    }

    // Inline migration: add endpoint column if missing (safe to re-run).
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN endpoint TEXT");
    } catch {
      // Column already exists — ignore.
    }
  }

  close(): void {
    this.db.close();
  }
}