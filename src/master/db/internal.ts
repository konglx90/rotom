/**
 * MeshDb — composition root that wires each domain module's methods onto a
 * single instance. Public API surface (the method names) is unchanged from
 * the pre-split monolithic version, so the 27 call sites across
 * `src/master/*.ts` and `tests/*.ts` need no edits.
 *
 * Each domain module exports a method bag whose `this` is typed as
 * `MeshDbSelf` (see ./core.ts) — a structural shape with the `db` handle
 * plus the cross-module method signatures they reference (e.g.
 * messages.enqueueOffline → agents.getAgentById).
 *
 * Type-wise, the MeshDb interface merges `MeshDbCore` with the intersection
 * of every domain method bag — declaration merging puts the bag methods on
 * the class instance type without 200+ lines of `declare` boilerplate. The
 * runtime instance is built via `Object.assign(this, …bags)` in the
 * constructor; implementations live in the domain modules.
 */

import { MeshDbCore } from "./core.js";
import { agentMethods } from "./agents.js";
import { messageMethods } from "./messages.js";
import { domainMethods } from "./domains.js";
import { groupMethods } from "./groups.js";
import { issueMethods } from "./issues.js";
import { noteMethods } from "./notes.js";
import { memoryMethods } from "./memory.js";
import { skillMethods } from "./skills.js";
import { scheduleMethods } from "./schedules.js";
import { askBridgeMethods } from "./ask-bridges.js";
import { guidanceTemplateMethods } from "./guidance-templates.js";
import { schedulePatternMethods } from "./schedule-patterns.js";
import { agentSessionMethods } from "./agent-sessions.js";
import { issuePatrolMethods } from "./issues-patrol.js";
import { linkMethods } from "./links.js";
import { masterNodeMethods } from "./master-node.js";
import { teamMethods } from "./team.js";
import { agentVisibilityMethods } from "./agent-visibility.js";

/** Intersection of every domain method bag — merged into `MeshDb` below. */
type MethodBags =
  & typeof agentMethods
  & typeof messageMethods
  & typeof domainMethods
  & typeof groupMethods
  & typeof issueMethods
  & typeof noteMethods
  & typeof memoryMethods
  & typeof skillMethods
  & typeof scheduleMethods
  & typeof askBridgeMethods
  & typeof guidanceTemplateMethods
  & typeof schedulePatternMethods
  & typeof agentSessionMethods
  & typeof issuePatrolMethods
  & typeof linkMethods
  & typeof masterNodeMethods
  & typeof teamMethods
  & typeof agentVisibilityMethods;

/**
 * Declaration merge: the `MeshDb` class provides the runtime + base shape
 * (MeshDbCore), and this interface adds every method bag's signature in
 * one line. Replaces the 200+ `declare X: typeof Y` lines the file used
 * to carry.
 */
export interface MeshDb extends MeshDbCore, MethodBags {}

export class MeshDb extends MeshDbCore {
  constructor(dbPath: string) {
    super(dbPath);
    // Each method bag's `this` resolves to this instance at call time.
    // The `MethodBags` intersection on the interface above ensures
    // TypeScript sees the assigned methods as members of MeshDb.
    Object.assign(
      this,
      agentMethods,
      messageMethods,
      domainMethods,
      groupMethods,
      issueMethods,
      noteMethods,
      memoryMethods,
      skillMethods,
      scheduleMethods,
      askBridgeMethods,
      guidanceTemplateMethods,
      schedulePatternMethods,
      agentSessionMethods,
      issuePatrolMethods,
      linkMethods,
      masterNodeMethods,
      teamMethods,
      agentVisibilityMethods,
    );
  }
}
