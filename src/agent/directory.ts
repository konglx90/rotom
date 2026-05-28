/**
 * Digital Employee Mesh — Local directory cache
 *
 * Maintains a local copy of the agent directory, updated via:
 * 1. Full sync on auth_ok
 * 2. Incremental updates via directory_update events
 */

import type { AgentInfo } from "../shared/protocol.js";

export class Directory {
  private agents = new Map<string, AgentInfo>(); // name → AgentInfo

  /** Replace entire directory (called on auth_ok). */
  setAll(agents: AgentInfo[]): void {
    this.agents.clear();
    for (const a of agents) {
      this.agents.set(a.name, a);
    }
  }

  /** Handle a directory_update event from Master. */
  update(event: "join" | "leave" | "update", agent: AgentInfo): void {
    if (event === "leave") {
      const existing = this.agents.get(agent.name);
      if (existing) {
        existing.status = "offline";
      }
    } else {
      // join or update
      this.agents.set(agent.name, agent);
    }
  }

  /** Get all agents. */
  list(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  /** Get online agents. */
  online(): AgentInfo[] {
    return this.list().filter((a) => a.status === "online");
  }

  /** Get agents in a domain. */
  byDomain(domain: string): AgentInfo[] {
    return this.list().filter((a) => a.domain === domain);
  }

  /** Find by name. */
  get(name: string): AgentInfo | undefined {
    return this.agents.get(name);
  }

  /** Count. */
  get size(): number {
    return this.agents.size;
  }
}
