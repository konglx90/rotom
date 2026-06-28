/**
 * MeshDb facade.
 *
 * Public re-export so existing callers (`from "../db.js"`) keep working
 * without modification. The actual `MeshDb` class still lives in
 * `./internal.ts` while method-by-method extraction lands in follow-up PRs.
 *
 * Once extraction is complete this file can become the composition root —
 * each domain module (agents / groups / issues / ...) contributes its
 * methods to a single `MeshDb` instance.
 */

export { MeshDb } from "./internal.js";
export type {
  AgentRow,
  AskBridgeRow,
  AuditLogRow,
  DomainRow,
  IssueEventRow,
  IssueRow,
  MessageLogRow,
  NoteRow,
  OfflineMessageRow,
  ScheduledTaskRow,
} from "./types.js";

export type { GuidanceTemplateRow } from "./guidance-templates.js";
export type { SchedulePatternRow } from "./schedule-patterns.js";