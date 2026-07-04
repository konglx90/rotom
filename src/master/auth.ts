/**
 * Digital Employee Mesh — Authentication
 *
 * Flow: registration token → sha256 verify → JWT (7d)
 * Reconnect: JWT verify (no raw token needed)
 */

import jwt from "jsonwebtoken";
import { randomBytes, createHash, timingSafeEqual, randomUUID } from "node:crypto";
import type { MeshDb } from "./db.js";
import { JWT_EXPIRY, JWT_ALGORITHM } from "../shared/constants.js";
import { REAL_PERSONS } from "../shared/protocol/enums.js";

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
   * Returns null on failure. token 可能为 undefined(OPC 本机模式),此时一定失败 ——
   * 本机信任走 `authenticateLocal`。
   */
  authenticate(
    token: string | undefined,
    name: string,
  ): { jwt: string; agent: Record<string, unknown> } | null {
    if (!token) return null;
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
    token: string | undefined,
  ): { jwt: string; agent: Record<string, unknown> } | null {
    if (!token) return null;
    const inputHash = hashToken(token);
    const agent = this.db.getAgentByTokenHash(inputHash);
    if (!agent) return null;

    const jwtToken = this.issueJwt(agent.id, agent.name, agent.domain || undefined);
    return { jwt: jwtToken, agent: agent as unknown as Record<string, unknown> };
  }

  /**
   * 免 token 本机信任认证:绕过 token / JWT 校验,直接按 name 查本机 agent 并签发 JWT。
   *
   * 仅当调用方能确保来源 IP 是 loopback(`isLoopback(req.socket.remoteAddress)`)时才能调此方法 ——
   * 这是 OPC(本地 master + 本机 executor)开箱即用的关键路径,免去手写 mesh_token 配置。
   *
   * Agent 不存在时**自动注册一个**(本机即真人接入,允许建立任意 name 的 agent):
   *   - name 来自 executor / CLI / 用户指定 —— 没有限制
   *   - hostname 用本机 master_node 的 hostname
   *   - profile.category = "Agent"(区别于真人 agent)
   *   - token_hash 留空(走 localTrust)
   *
   * 仍会拒绝 `enabled = 0` 的禁用 agent(已存在但被禁用)。
   */
  authenticateLocal(name: string): { jwt: string; agent: Record<string, unknown> } | null {
    let agent = this.db.getLocalAgentByName(name) ?? this.db.getAgentByName(name);
    if (agent) {
      if ((agent.enabled as number | undefined) === 0) return null;
    } else {
      // 本机即信任 —— agent 不存在则自动建一个。
      const localHostname = this.db.getLocalHostname() ?? undefined;
      const isRealPerson = (REAL_PERSONS as readonly string[]).includes(name);
      const profile = JSON.stringify(isRealPerson ? { category: "真人" } : { category: "Agent" });
      const id = randomUUID();
      this.db.insertAgent({
        id,
        name,
        hostname: localHostname,
        tokenHash: "",
        token: "",
        profile,
      });
      agent = this.db.getAgentById(id);
      if (!agent) return null;
    }

    const jwtToken = this.issueJwt(
      agent.id as string,
      agent.name as string,
      (agent.domain as string) || undefined,
    );
    return { jwt: jwtToken, agent: agent as unknown as Record<string, unknown> };
  }

  /** Generate a new registration token (for API use). */
  generateToken(): string {
    return `mesh_${randomBytes(16).toString("hex")}`;
  }
}
