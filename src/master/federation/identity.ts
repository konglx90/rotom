/**
 * Master identity — masterId 生成、hostname 解析与校验、role 解析。
 *
 * masterId 是 8 字符 base36 小写短 ID(36^8 ≈ 2.8 万亿),首次启动生成、
 * 持久化在 `~/.rotom/master.json`,之后永远稳定。机器换网络 / 改 IP / 改
 * os.hostname 都不影响 masterId —— 它是路由的真正主键,IP 不可靠。
 *
 * hostname 仅作显示用(`alice@hostA`),不是路由键;但启动时强制校验拒绝 IP,
 * 因为移动电脑 IP 会变。优先级:
 *   ROTOM_HOSTNAME 环境变量 > ~/.rotom/hostname 文件 > os.hostname()
 *
 * role 同样每次启动从 ROTOM_MASTER_ROLE 解析;Phase 1 实际只启用 standalone 行为,
 * coordination/member 的语义在 Phase 2 federation 落地后才有意义。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MasterRole = "standalone" | "coordination" | "member";

export interface MasterIdentity {
  /** 8 字符 base36,持久化,永远稳定。真正的路由主键。 */
  id: string;
  /** 人取的稳定机器名(非 IP)。仅作显示用。 */
  hostname: string;
  /** federation 角色。Phase 1 实际只用 standalone。 */
  role: MasterRole;
  /**
   * 团队展示名(人取,如"西花团队")。可能为空字符串 —— 由 OPC bootstrap
   * 兜底:查本机真人 agent(profile.category="真人"),用其 name + "团队" 作默认。
   * 仍然只是 UI 显示,不参与路由。
   */
  teamName: string;
}

interface StoredIdentity {
  id: string;
  hostname: string;
  role: MasterRole;
  teamName?: string;
  createdAt: string;
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 8;
const ID_PATTERN = /^[0-9a-z]{8}$/;

// IPv4 字面量: 192.168.1.1 / 10.0.0.1
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
// IPv6 字面量(粗略:包含 : 的十六进制串)
const IPV6_PATTERN = /^[0-9a-fA-F:]+$/;

const MAX_HOSTNAME_LEN = 63;

/** 生成一个 8 字符 base36 小写 masterId。 */
export function generateMasterId(): string {
  const bytes = crypto.randomBytes(ID_LENGTH);
  let out = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

/**
 * 校验 hostname 是否合法。拒绝 IP 字面量(移动电脑 IP 不稳定)、空串、超长串。
 * 注意:`localhost`、`.local` mDNS 名等不拒绝 —— 由用户判断是否稳定。
 */
export function isValidHostname(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  if (name.length === 0 || name.length > MAX_HOSTNAME_LEN) return false;
  if (IPV4_PATTERN.test(name)) return false;
  if (name.includes(":") && IPV6_PATTERN.test(name)) return false;
  return true;
}

export interface GetMasterIdentityOpts {
  rotomHome?: string;
}

/**
 * 解析本机 master 身份。首次启动会生成 masterId 并写入 `~/.rotom/master.json`;
 * 后续启动读回 masterId(永远稳定),hostname / role 则每次重新解析(可变)。
 *
 * @throws 如果 hostname 校验失败(IP 字面量、空串等)
 */
export function getMasterIdentity(opts: GetMasterIdentityOpts = {}): MasterIdentity {
  const rotomHome = opts.rotomHome || process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
  const masterJsonPath = path.join(rotomHome, "master.json");

  const hostname = resolveHostname(rotomHome);
  if (!isValidHostname(hostname)) {
    throw new Error(
      `Invalid hostname "${hostname}". ` +
      `Set ROTOM_HOSTNAME to a stable machine name ` +
      `(IP literals are not allowed because laptop IPs change across networks).`,
    );
  }

  const role = resolveRole();
  // teamName 优先级:ROTOM_TEAM_NAME 环境变量 > master.json 持久化值 > undefined(由 OPC bootstrap 兜底)
  // OPC bootstrap 会查本机真人 agent,用其 name + "团队" 作默认(如"西花团队")
  const storedTeamName = readStoredIdentity(masterJsonPath)?.teamName;
  const teamName = resolveTeamName() ?? storedTeamName ?? "";

  let stored = readStoredIdentity(masterJsonPath);
  if (!stored || !ID_PATTERN.test(stored.id)) {
    stored = {
      id: generateMasterId(),
      hostname,
      role,
      teamName: teamName || undefined,
      createdAt: new Date().toISOString(),
    };
    writeStoredIdentity(masterJsonPath, stored);
  }

  return { id: stored.id, hostname, role, teamName };
}

/** 解析 ROTOM_HOME(给外部模块用,避免重复实现)。 */
export function resolveRotomHome(): string {
  return process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
}

function resolveHostname(rotomHome: string): string {
  const fromEnv = process.env.ROTOM_HOSTNAME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const hostnameFile = path.join(rotomHome, "hostname");
  try {
    const raw = fs.readFileSync(hostnameFile, "utf-8").trim();
    if (raw) return raw;
  } catch {
    // 文件不存在,fallback
  }
  return os.hostname();
}

function resolveRole(): MasterRole {
  const raw = process.env.ROTOM_MASTER_ROLE;
  if (raw === "standalone" || raw === "coordination" || raw === "member") {
    return raw;
  }
  return "standalone";
}

/** 解析团队展示名。优先 ROTOM_TEAM_NAME 环境变量,否则用 master.json 里的,否则 = hostname。 */
function resolveTeamName(): string | undefined {
  const fromEnv = process.env.ROTOM_TEAM_NAME;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return undefined;
}

function readStoredIdentity(p: string): StoredIdentity | undefined {
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoredIdentity>;
    if (typeof parsed.id === "string" && typeof parsed.hostname === "string" && typeof parsed.role === "string") {
      return parsed as StoredIdentity;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeStoredIdentity(p: string, identity: StoredIdentity): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(identity, null, 2) + "\n", "utf-8");
}
