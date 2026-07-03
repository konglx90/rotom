/**
 * Patrol-group bootstrap — extracted from api/groups.ts createGroup handler
 * so the API layer stays thin. Owns the side-effects that fire when a group
 * with `type === "patrol"` is created:
 *   - create the recurring `issue-patrol` scheduled task (default interval 7200s = 2h)
 *   - bind the `issue-patrol-rules` skill to the patrol agent (if it exists)
 *
 * Failed skill binding is non-fatal — the schedule still runs, the agent
 * just doesn't get the rules prompt injected.
 */

import type { Logger } from "../../shared/logger.js";
import type { MeshDb } from "../db.js";

// 默认 2 小时一次:巡检本质是观察 + 预警,1h 太频反而是噪音;2h 留出足够的处理窗口
// 又不至于错过新 issue(常见新 issue 在群聊触发,2h 内会被人工认领)。
const PATROL_DEFAULT_INTERVAL_SEC = 2 * 60 * 60;

export interface PatrolBootstrapPayload {
  patrolGroupId: string;
  patrolAgentName: string;
  throughputCap: number;
  candidateCap: number;
  scanBatch: number;
}

/**
 * Build the handler payload used by both the scheduled task and the
 * dashboard's "what does this patrol do?" view. Pulled out so the shape
 * stays in one place if the patrol handler evolves.
 */
export function buildPatrolPayload(groupId: string, agentName: string): PatrolBootstrapPayload {
  return {
    patrolGroupId: groupId,
    patrolAgentName: agentName,
    throughputCap: 3,
    candidateCap: 3,
    scanBatch: 10,
  };
}

/**
 * Create the recurring `issue-patrol` schedule and bind the
 * `issue-patrol-rules` skill to the patrol agent. No-op if `agentName`
 * is empty.
 */
export function bootstrapPatrolGroup(
  db: MeshDb,
  log: Logger,
  groupId: string,
  agentName: string,
): void {
  if (!agentName) return;

  const payload = buildPatrolPayload(groupId, agentName);
  db.createScheduledTask({
    name: "Issue 巡检",
    groupId,
    mode: "agent", // handler 模式下 mode 不被使用,但 schema NOT NULL,保留 agent
    agentName,
    scheduleKind: "interval",
    intervalSec: PATROL_DEFAULT_INTERVAL_SEC,
    prompt: "", // handler 模式不用 prompt,但 schema NOT NULL
    enabled: true,
    handlerKey: "issue-patrol",
    handlerPayload: JSON.stringify(payload),
  });

  const skill = db.getSkillByName("issue-patrol-rules");
  if (skill) {
    db.bindSkill({
      groupId,
      agentName,
      skillId: skill.id,
      createdBy: "system:patrol-bootstrap",
    });
    log.info(`Patrol group ${groupId}: bound issue-patrol-rules to ${agentName}`);
  } else {
    log.warn(`Patrol group ${groupId}: issue-patrol-rules skill not found, skip binding`);
  }
  log.info(`Patrol group ${groupId}: auto-created issue-patrol schedule (interval ${PATROL_DEFAULT_INTERVAL_SEC}s, enabled)`);
}
