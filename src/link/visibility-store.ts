/**
 * InMemoryVisibilityStore —— rotom-link 用的内存版 agent_visibility 缓存。
 *
 * FedClient 在 handleDirectorySync 里只调 3 个方法:
 *   - removeVisibleAgent(teamId, masterId, name)
 *   - listVisibleAgents(teamId)
 *   - upsertVisibleAgent({...})
 *
 * 这套结构刚好够 FedClient 缓存协调 master 广播的目录,不需要 better-sqlite3。
 * 通过 `as unknown as MeshDb` 喂给 FedClient(FedClient 不会调其他方法)。
 */

import type { AgentVisibilityRow } from "../master/db/types.js";

interface Entry {
  team_id: string;
  master_id: string;
  agent_name: string;
  hostname: string;
  display_name: string | null;
  is_human: number;
  online: number;
  last_heartbeat: string | null;
}

export class InMemoryVisibilityStore {
  private byTeam = new Map<string, Map<string, Entry>>();
  private key(masterId: string, name: string): string {
    return `${masterId}::${name}`;
  }

  listVisibleAgents(teamId: string): AgentVisibilityRow[] {
    const map = this.byTeam.get(teamId);
    if (!map) return [];
    return Array.from(map.values()).map((e) => ({ ...e }));
  }

  upsertVisibleAgent(input: {
    team_id: string;
    master_id: string;
    agent_name: string;
    hostname: string;
    display_name?: string | null;
    is_human: boolean;
    online: boolean;
  }): void {
    let map = this.byTeam.get(input.team_id);
    if (!map) {
      map = new Map();
      this.byTeam.set(input.team_id, map);
    }
    map.set(this.key(input.master_id, input.agent_name), {
      team_id: input.team_id,
      master_id: input.master_id,
      agent_name: input.agent_name,
      hostname: input.hostname,
      display_name: input.display_name ?? null,
      is_human: input.is_human ? 1 : 0,
      online: input.online ? 1 : 0,
      last_heartbeat: new Date().toISOString(),
    });
  }

  removeVisibleAgent(teamId: string, masterId: string, agentName: string): boolean {
    const map = this.byTeam.get(teamId);
    if (!map) return false;
    return map.delete(this.key(masterId, agentName));
  }

  /** 给 /fed/directory HTTP 端点用:返回所有可见 agent(简化展示字段) */
  listForHttp(teamId: string): Array<{
    masterId: string;
    hostname: string;
    name: string;
    displayName?: string;
    isHuman: boolean;
    online: boolean;
    ref: string;
  }> {
    return this.listVisibleAgents(teamId).map((v) => ({
      masterId: v.master_id,
      hostname: v.hostname,
      name: v.agent_name,
      displayName: v.display_name ?? undefined,
      isHuman: v.is_human !== 0,
      online: v.online !== 0,
      ref: `${v.agent_name}@${v.hostname}`,
    }));
  }
}
