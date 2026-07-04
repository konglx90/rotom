/**
 * agent_visibility CRUD —— 跨 master 可见的 agent 发布记录。
 *
 * 协调侧权威:member 通过 FedAgentPublish 上报,协调侧 upsert。
 * Member 侧缓存:从 FedDirectorySync 同步,只读;Routing 在本机找不到时查这里。
 *
 * PK 是 (team_id, master_id, agent_name),不用 hostname(hostname 只是 display,可改)。
 * 历史命名:Phase 2 叫 department_id,migration 058 改名 team_id。
 */

import type { MeshDbSelf } from "./core.js";
import type { AgentVisibilityRow } from "./types.js";

export const agentVisibilityMethods = {
  listVisibleAgents(this: MeshDbSelf, teamId: string): AgentVisibilityRow[] {
    return this.db.prepare(
      "SELECT * FROM agent_visibility WHERE team_id = ? ORDER BY hostname, agent_name",
    ).all(teamId) as AgentVisibilityRow[];
  },

  /**
   * UPSERT 协调侧权威记录(member 上报时调用)。
   * 若 hostname 改了,只更新 display 列,master_id+name 主键不变。
   */
  upsertVisibleAgent(
    this: MeshDbSelf,
    input: {
      team_id: string;
      master_id: string;
      agent_name: string;
      hostname: string;
      display_name?: string | null;
      is_human: boolean;
      online: boolean;
    },
  ): void {
    this.db.prepare(`
      INSERT INTO agent_visibility
        (team_id, master_id, agent_name, hostname, display_name, is_human, online, last_heartbeat)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(team_id, master_id, agent_name) DO UPDATE SET
        hostname = excluded.hostname,
        display_name = COALESCE(excluded.display_name, agent_visibility.display_name),
        is_human = excluded.is_human,
        online = excluded.online,
        last_heartbeat = datetime('now')
    `).run(
      input.team_id,
      input.master_id,
      input.agent_name,
      input.hostname,
      input.display_name ?? null,
      input.is_human ? 1 : 0,
      input.online ? 1 : 0,
    );
  },

  setVisibleOnline(
    this: MeshDbSelf,
    teamId: string,
    masterId: string,
    agentName: string,
    online: boolean,
  ): void {
    this.db.prepare(`
      UPDATE agent_visibility SET
        online = ?,
        last_heartbeat = datetime('now')
      WHERE team_id = ? AND master_id = ? AND agent_name = ?
    `).run(online ? 1 : 0, teamId, masterId, agentName);
  },

  removeVisibleAgent(
    this: MeshDbSelf,
    teamId: string,
    masterId: string,
    agentName: string,
  ): boolean {
    const r = this.db.prepare(
      "DELETE FROM agent_visibility WHERE team_id = ? AND master_id = ? AND agent_name = ?",
    ).run(teamId, masterId, agentName);
    return r.changes > 0;
  },

  /** member 离开团队 / 协调 master 下线时:清掉该 master 在团队里的所有可见 agent */
  clearVisibleAgentsForMaster(this: MeshDbSelf, teamId: string, masterId: string): number {
    const r = this.db.prepare(
      "DELETE FROM agent_visibility WHERE team_id = ? AND master_id = ?",
    ).run(teamId, masterId);
    return r.changes;
  },

  /** 清掉整个团队的所有可见 agent(member 离开时) */
  clearVisibleAgents(this: MeshDbSelf, teamId: string): number {
    const r = this.db.prepare(
      "DELETE FROM agent_visibility WHERE team_id = ?",
    ).run(teamId);
    return r.changes;
  },

  /** 按 (hostname, name) 反查 —— Router 解析 "alice@hostB" 时用 */
  findVisibleAgentByHostAndName(
    this: MeshDbSelf,
    teamId: string,
    hostname: string,
    agentName: string,
  ): AgentVisibilityRow | undefined {
    return this.db.prepare(
      "SELECT * FROM agent_visibility WHERE team_id = ? AND hostname = ? AND agent_name = ?",
    ).get(teamId, hostname, agentName) as AgentVisibilityRow | undefined;
  },

  /**
   * 按 name 反查(不带 hostname) —— Router 解析裸 "alice" 时用。
   * 若团队内 name 唯一,返回单条;否则返回多条(调用方报歧义错误)。
   */
  findVisibleAgentsByName(
    this: MeshDbSelf,
    teamId: string,
    agentName: string,
  ): AgentVisibilityRow[] {
    return this.db.prepare(
      "SELECT * FROM agent_visibility WHERE team_id = ? AND agent_name = ?",
    ).all(teamId, agentName) as AgentVisibilityRow[];
  },
};
