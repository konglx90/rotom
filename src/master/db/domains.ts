/**
 * Domains — department CRUD + cross-domain routing rules.
 *
 * Methods attach to a `MeshDb` instance via `Object.assign`. Cross-module
 * mutation: `renameDomainInAgents` writes the agents table (owned by
 * ./agents.ts) — that's just a SQL write, no method call, so no cross-domain
 * coupling beyond the SQL schema.
 */

import type { DomainRow } from "./types.js";
import type { MeshDbSelf } from "./core.js";

export const domainMethods = {
  listDomains(this: MeshDbSelf): DomainRow[] {
    return this.db.prepare("SELECT * FROM domains ORDER BY name").all() as DomainRow[];
  },

  getDomainByName(this: MeshDbSelf, name: string): DomainRow | undefined {
    return this.db.prepare("SELECT * FROM domains WHERE name = ?").get(name) as DomainRow | undefined;
  },

  getDomainById(this: MeshDbSelf, id: string): DomainRow | undefined {
    return this.db.prepare("SELECT * FROM domains WHERE id = ?").get(id) as DomainRow | undefined;
  },

  insertDomain(this: MeshDbSelf, id: string, name: string, description?: string): void {
    this.db.prepare(
      "INSERT INTO domains (id, name, description) VALUES (?, ?, ?)",
    ).run(id, name, description || null);
  },

  updateDomain(this: MeshDbSelf, id: string, meta: { name?: string; description?: string }): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (meta.name !== undefined) { sets.push("name = ?"); values.push(meta.name); }
    if (meta.description !== undefined) { sets.push("description = ?"); values.push(meta.description); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE domains SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  },

  deleteDomain(this: MeshDbSelf, id: string): void {
    this.db.prepare("DELETE FROM domains WHERE id = ?").run(id);
  },

  /** Rename domain in all agents (used when domain name changes). */
  renameDomainInAgents(this: MeshDbSelf, oldName: string, newName: string): void {
    this.db.prepare(
      "UPDATE agents SET domain = ?, updated_at = datetime('now') WHERE domain = ?",
    ).run(newName, oldName);
    // Also update cross_domain_rules
    this.db.prepare("UPDATE cross_domain_rules SET from_domain = ? WHERE from_domain = ?").run(newName, oldName);
    this.db.prepare("UPDATE cross_domain_rules SET to_domain = ? WHERE to_domain = ?").run(newName, oldName);
  },

  /** Count agents belonging to a domain (by domain name). */
  countAgentsByDomain(this: MeshDbSelf, domainName: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM agents WHERE domain = ?",
    ).get(domainName) as { c: number };
    return row.c;
  },

  canCrossDomain(this: MeshDbSelf, from: string | undefined, to: string | undefined): boolean {
    // No domain set → no isolation
    if (!from || !to) return true;
    // Same domain → always OK
    if (from === to) return true;
    // Check explicit rule
    return !!this.db.prepare(
      "SELECT 1 FROM cross_domain_rules WHERE from_domain = ? AND to_domain = ?",
    ).get(from, to);
  },

  /** Add cross-domain rule. Set bidirectional=true to create both A→B and B→A. */
  addCrossDomainRule(this: MeshDbSelf, from: string, to: string, bidirectional = false): void {
    this.db.prepare("INSERT OR IGNORE INTO cross_domain_rules (from_domain, to_domain) VALUES (?, ?)").run(from, to);
    if (bidirectional) {
      this.db.prepare("INSERT OR IGNORE INTO cross_domain_rules (from_domain, to_domain) VALUES (?, ?)").run(to, from);
    }
  },

  /** List all cross-domain rules. */
  listCrossDomainRules(this: MeshDbSelf): { from_domain: string; to_domain: string }[] {
    return this.db.prepare("SELECT from_domain, to_domain FROM cross_domain_rules ORDER BY from_domain, to_domain").all() as { from_domain: string; to_domain: string }[];
  },

  /** Count cross-domain rules referencing a domain (as source or target). */
  countCrossDomainRulesByDomain(this: MeshDbSelf, domainName: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as c FROM cross_domain_rules WHERE from_domain = ? OR to_domain = ?",
    ).get(domainName, domainName) as { c: number };
    return row.c;
  },

  /** Delete a cross-domain rule. */
  deleteCrossDomainRule(this: MeshDbSelf, from: string, to: string): boolean {
    const result = this.db.prepare("DELETE FROM cross_domain_rules WHERE from_domain = ? AND to_domain = ?").run(from, to);
    return result.changes > 0;
  },
};