/**
 * Digital Employee Mesh — Share Token Store
 *
 * Ephemeral, in-memory only. Powers the dashboard's "Share" / visitor mode:
 * any Dashboard user can mint a `share_<hex>` token bound to a single group,
 * copy the resulting URL, and grant a third-party read-only access to the
 * group's messages / issues / artifacts / notes — without exposing the agent
 * token and without persisting anything.
 *
 * Lifetime: process memory only. All tokens vanish on Master restart.
 * Tokens can also be revoked explicitly via `revoke()`. No expiry by default
 * (per requirement: "in-memory only, no persistence"); if a TTL is desired
 * later, add it here without changing the public interface.
 */

import { randomBytes } from "node:crypto";

export interface ShareTokenRecord {
  token: string;        // share_<32 hex>
  groupId: string;
  createdBy: string;    // agent name of the creator
  createdAt: number;    // ms since epoch
}

export class ShareTokenStore {
  private tokens = new Map<string, ShareTokenRecord>();

  /** Mint a new share token bound to `groupId`, created by `createdBy`. */
  create(groupId: string, createdBy: string): ShareTokenRecord {
    const token = `share_${randomBytes(16).toString("hex")}`;
    const record: ShareTokenRecord = {
      token,
      groupId,
      createdBy,
      createdAt: Date.now(),
    };
    this.tokens.set(token, record);
    return record;
  }

  /** Look up a token. Returns undefined if unknown / revoked. */
  resolve(token: string): ShareTokenRecord | undefined {
    return this.tokens.get(token);
  }

  /** Revoke a token. Returns true if a token was removed. */
  revoke(token: string): boolean {
    return this.tokens.delete(token);
  }

  /** List all tokens a given creator has minted (for UI / cleanup). */
  listByCreator(createdBy: string): ShareTokenRecord[] {
    const out: ShareTokenRecord[] = [];
    for (const r of this.tokens.values()) {
      if (r.createdBy === createdBy) out.push(r);
    }
    return out;
  }

  /** List all tokens currently bound to a group. */
  listByGroup(groupId: string): ShareTokenRecord[] {
    const out: ShareTokenRecord[] = [];
    for (const r of this.tokens.values()) {
      if (r.groupId === groupId) out.push(r);
    }
    return out;
  }
}