/**
 * Digital Employee Mesh — Authentication
 *
 * Flow: registration token → sha256 verify → JWT (7d)
 * Reconnect: JWT verify (no raw token needed)
 */

import jwt from "jsonwebtoken";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { MeshDb } from "./db.js";
import { JWT_EXPIRY, JWT_ALGORITHM } from "../shared/constants.js";

// ---------------------------------------------------------------------------
// Token hashing
// ---------------------------------------------------------------------------

/** Hash a registration token with sha256. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Timing-safe comparison of two hex strings. */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

// ---------------------------------------------------------------------------
// JWT payload
// ---------------------------------------------------------------------------

export interface JwtPayload {
  sub: string;   // agent id
  name: string;
  domain?: string;
}

// ---------------------------------------------------------------------------
// Auth service
// ---------------------------------------------------------------------------

export class AuthService {
  private secret: string;

  constructor(private db: MeshDb) {
    let s = db.getConfig("jwt_secret");
    if (!s) {
      s = randomBytes(32).toString("hex");
      db.setConfig("jwt_secret", s);
    }
    this.secret = s;
  }

  /**
   * First-time auth: verify registration token, return JWT.
   * Returns null on failure.
   */
  authenticate(
    token: string,
    name: string,
  ): { jwt: string; agent: Record<string, unknown> } | null {
    const agent = this.db.getAgentByName(name);
    if (!agent?.token_hash) return null;

    const inputHash = hashToken(token);
    if (!safeCompare(inputHash, agent.token_hash as string)) return null;

    const jwtToken = this.issueJwt(agent.id as string, agent.name as string, (agent.domain as string) || undefined);

    return { jwt: jwtToken, agent: agent as unknown as Record<string, unknown> };
  }

  /** Issue a fresh JWT for a given agent. */
  issueJwt(agentId: string, name: string, domain?: string): string {
    const payload: JwtPayload = { sub: agentId, name, domain };
    return jwt.sign(payload, this.secret, {
      expiresIn: JWT_EXPIRY,
      algorithm: JWT_ALGORITHM,
    });
  }

  /** Verify a JWT on reconnect. */
  verify(token: string): JwtPayload | null {
    try {
      return jwt.verify(token, this.secret, {
        algorithms: [JWT_ALGORITHM],
      }) as JwtPayload;
    } catch {
      return null;
    }
  }

  /**
   * Fallback auth: find agent by token hash (ignoring name).
   * Used when agent changed its display name but kept the same token.
   */
  authenticateByToken(
    token: string,
  ): { jwt: string; agent: Record<string, unknown> } | null {
    const inputHash = hashToken(token);
    const agent = this.db.getAgentByTokenHash(inputHash);
    if (!agent) return null;

    const jwtToken = this.issueJwt(agent.id, agent.name, agent.domain || undefined);
    return { jwt: jwtToken, agent: agent as unknown as Record<string, unknown> };
  }

  /** Generate a new registration token (for API use). */
  generateToken(): string {
    return `mesh_${randomBytes(16).toString("hex")}`;
  }
}
