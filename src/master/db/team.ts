/**
 * team / team_peers / human_membership CRUD。
 *
 * - team 表存"本机 master 加入了哪些团队"(本机视角,每行一个团队)
 * - team_peers 存"团队里有哪些其他 master"(协调侧权威 + member 侧缓存)
 * - human_membership 存"本机真人加入了哪些团队"
 *
 * agent_visibility 在 ./agent-visibility.ts(单独模块,方法较多)。
 *
 * 历史命名:Phase 2 叫 department,migration 058 改名 team。所有 department_id
 * 列同步改为 team_id。底层 federation 协议字段 departmentId → teamId。
 */

import { buildUpdate } from "./build-update.js";
import type { MeshDbSelf } from "./core.js";
import type { TeamRow, TeamPeerRow, HumanMembershipRow } from "./types.js";

export const teamMethods = {
  // ─── team ──────────────────────────────────────────────────────────────

  listTeams(this: MeshDbSelf): TeamRow[] {
    return this.db.prepare("SELECT * FROM team ORDER BY name").all() as TeamRow[];
  },

  getTeam(this: MeshDbSelf, id: string): TeamRow | undefined {
    return this.db.prepare("SELECT * FROM team WHERE id = ?").get(id) as TeamRow | undefined;
  },

  insertTeam(
    this: MeshDbSelf,
    input: {
      id: string;
      name: string;
      description?: string;
      my_role: "coordination" | "member";
      coord_endpoints: string;
    },
  ): void {
    this.db.prepare(
      "INSERT INTO team (id, name, description, my_role, coord_endpoints) VALUES (?, ?, ?, ?, ?)",
    ).run(input.id, input.name, input.description ?? null, input.my_role, input.coord_endpoints);
  },

  updateTeamMeta(this: MeshDbSelf, id: string, meta: { name?: string; description?: string }): void {
    const built = buildUpdate({
      table: "team",
      sets: { name: meta.name, description: meta.description },
      where: "id = ?",
      whereParams: [id],
      updatedAt: false,
    });
    if (built) this.db.prepare(built.sql).run(...built.params);
  },

  deleteTeam(this: MeshDbSelf, id: string): void {
    this.db.prepare("DELETE FROM team WHERE id = ?").run(id);
  },

  // ─── team_peers ────────────────────────────────────────────────────────

  listPeers(this: MeshDbSelf, teamId: string): TeamPeerRow[] {
    return this.db.prepare(
      "SELECT * FROM team_peers WHERE team_id = ? ORDER BY hostname",
    ).all(teamId) as TeamPeerRow[];
  },

  getPeer(this: MeshDbSelf, teamId: string, masterId: string): TeamPeerRow | undefined {
    return this.db.prepare(
      "SELECT * FROM team_peers WHERE team_id = ? AND master_id = ?",
    ).get(teamId, masterId) as TeamPeerRow | undefined;
  },

  /** hostname 冲突检测:团队内同 hostname 是否已有 peer */
  findPeerByHostname(this: MeshDbSelf, teamId: string, hostname: string): TeamPeerRow | undefined {
    return this.db.prepare(
      "SELECT * FROM team_peers WHERE team_id = ? AND hostname = ?",
    ).get(teamId, hostname) as TeamPeerRow | undefined;
  },

  upsertPeer(
    this: MeshDbSelf,
    input: {
      team_id: string;
      master_id: string;
      hostname: string;
      endpoint?: string | null;
      role: "coordination" | "member";
    },
  ): void {
    const existing = this.db.prepare(
      "SELECT 1 FROM team_peers WHERE team_id = ? AND master_id = ?",
    ).get(input.team_id, input.master_id);
    if (existing) {
      this.db.prepare(`
        UPDATE team_peers SET
          hostname = ?,
          endpoint = COALESCE(?, endpoint),
          role = ?,
          last_seen_at = datetime('now')
        WHERE team_id = ? AND master_id = ?
      `).run(
        input.hostname,
        input.endpoint ?? null,
        input.role,
        input.team_id,
        input.master_id,
      );
      return;
    }
    this.db.prepare(`
      INSERT INTO team_peers (team_id, master_id, hostname, endpoint, role, last_seen_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(
      input.team_id,
      input.master_id,
      input.hostname,
      input.endpoint ?? null,
      input.role,
    );
  },

  touchPeerHeartbeat(this: MeshDbSelf, teamId: string, masterId: string): void {
    this.db.prepare(
      "UPDATE team_peers SET last_seen_at = datetime('now') WHERE team_id = ? AND master_id = ?",
    ).run(teamId, masterId);
  },

  deletePeer(this: MeshDbSelf, teamId: string, masterId: string): void {
    this.db.prepare(
      "DELETE FROM team_peers WHERE team_id = ? AND master_id = ?",
    ).run(teamId, masterId);
  },

  /** member 离开团队时清掉所有本地缓存的 peer */
  clearPeers(this: MeshDbSelf, teamId: string): void {
    this.db.prepare("DELETE FROM team_peers WHERE team_id = ?").run(teamId);
  },

  // ─── human_membership ──────────────────────────────────────────────────

  listHumanMemberships(this: MeshDbSelf, agentId: string): HumanMembershipRow[] {
    return this.db.prepare(
      "SELECT * FROM human_membership WHERE agent_id = ? ORDER BY joined_at",
    ).all(agentId) as HumanMembershipRow[];
  },

  addHumanMembership(this: MeshDbSelf, agentId: string, teamId: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO human_membership (agent_id, team_id) VALUES (?, ?)",
    ).run(agentId, teamId);
  },

  removeHumanMembership(this: MeshDbSelf, agentId: string, teamId: string): void {
    this.db.prepare(
      "DELETE FROM human_membership WHERE agent_id = ? AND team_id = ?",
    ).run(agentId, teamId);
  },
};
