/**
 * Link-patrol group bootstrap —— type=patrol-link 群建群时的副作用。
 *
 * 仿 services/patrol-bootstrap.ts:
 *   - 创建 recurring link-patrol scheduled task(interval 3600s,handler_key="link-patrol")
 *   - 绑定 link-patrol-rules skill 到巡检员 agent(skill seed 在 migration 053 里)
 *
 * Failed skill binding 非致命 —— schedule 仍跑,agent 没规则 prompt 时用兜底判断。
 */

import type { Logger } from "../../shared/logger.js";
import type { MeshDb } from "../db.js";

export interface LinkPatrolPayload {
  patrolGroupId: string;
  patrolAgentName: string;
  scanBatch: number;
}

export function buildLinkPatrolPayload(groupId: string, agentName: string): LinkPatrolPayload {
  return {
    patrolGroupId: groupId,
    patrolAgentName: agentName,
    scanBatch: 20,
  };
}

export function bootstrapLinkPatrolGroup(
  db: MeshDb,
  log: Logger,
  groupId: string,
  agentName: string,
): void {
  if (!agentName) return;

  const payload = buildLinkPatrolPayload(groupId, agentName);
  db.createScheduledTask({
    name: "链接智能分类",
    groupId,
    mode: "agent",
    agentName,
    scheduleKind: "interval",
    intervalSec: 3600,
    prompt: "",
    enabled: true,
    handlerKey: "link-patrol",
    handlerPayload: JSON.stringify(payload),
  });

  const skill = db.getSkillByName("link-patrol-rules");
  if (skill) {
    db.bindSkill({
      groupId,
      agentName,
      skillId: skill.id,
      createdBy: "system:link-patrol-bootstrap",
    });
    log.info(`Link-patrol group ${groupId}: bound link-patrol-rules to ${agentName}`);
  } else {
    log.warn(`Link-patrol group ${groupId}: link-patrol-rules skill not found, skip binding`);
  }
  log.info(`Link-patrol group ${groupId}: auto-created link-patrol schedule (interval 3600s, enabled)`);
}
