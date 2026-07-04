/**
 * Federation 协议 —— master 与 master 之间的通信。
 *
 * 拓扑(Phase 2):星型,所有跨 master 消息经协调 master 中转。
 *   member ←→ coordination ←→ member
 *
 * 传输:WebSocket(ws://coord-host:port/federation),文本帧 JSON,最大 1MB。
 * 认证:MVP 免认证,假设内网可信;但握手强制声明 masterId/hostname,
 * 协调侧持久化来源便于审计 audit_log。
 *
 * 路由键:masterId(8 字符 base36,持久化在 ~/.rotom/master.json,永远稳定)。
 * 显示键:hostname(可改,仅作展示,形如 alice@hostA)。
 *
 * 消息类型(8 个):
 *   ─ 握手 ─
 *     FedHandshake        member → coord,声明身份
 *     FedHandshakeAck     coord → member,确认接入 / 报错(HOSTNAME_CONFLICT 等)
 *   ─ 可见性发布 ─
 *     FedAgentPublish     member → coord,增量发布本地 agent 状态
 *     FedAgentUnpublish   member → coord,撤销发布(离开部门时)
 *     FedDirectorySync    coord → member,全量/增量同步 agent_visibility
 *   ─ 消息路由 ─
 *     FedRouteMessage     member → coord,请求跨机投递
 *     FedRouteDeliver     coord → member(目标侧),投递消息
 *     FedRouteReply       member → coord → 来源 member,回复消息
 */

/** masterId 校验:8 字符 base36 小写 */
export const MASTER_ID_PATTERN = /^[0-9a-z]{8}$/;

/** hostname 校验:非空、非 IP(详见 src/master/federation/identity.ts isValidHostname) */
export const HOSTNAME_PATTERN = /^[^\s:]+$/;

/** 协议版本 — bump when fed wire format changes */
export const FED_PROTOCOL_VERSION = 1;

// ─── 握手 ──────────────────────────────────────────────────────────────────

export interface FedHandshake {
  type: "fed_handshake";
  /** 8 字符 base36,master_node.id 持久化的值 */
  masterId: string;
  /** 人取的稳定机器名(非 IP) */
  hostname: string;
  /** 在本部门的角色 — 协调 master 也会以 member 身份接入更上级(预留) */
  role: "member" | "coordination";
  protocol: typeof FED_PROTOCOL_VERSION;
}

export type FedHandshakeError =
  | "HOSTNAME_CONFLICT"   // department 内已有同 hostname
  | "PROTOCOL_MISMATCH"   // protocol 版本不一致
  | "ROLE_MISMATCH";      // 角色不匹配(例如 member 接 member)

export interface FedHandshakeAck {
  type: "fed_handshake_ack";
  teamId: string;
  accepted: boolean;
  error?: FedHandshakeError;
  /** 协调 master 自己的 masterId,供 member 端记 peer */
  serverMasterId: string;
  /** 协调 master 自己的 hostname(display) */
  serverHostname: string;
}

// ─── 可见性发布 ────────────────────────────────────────────────────────────

export interface FedVisibleAgent {
  hostname: string;
  name: string;
  displayName?: string;
  isHuman: boolean;
  online: boolean;
}

export interface FedAgentPublish {
  type: "fed_agent_publish";
  teamId: string;
  /** 发布方 masterId(协调侧 UPSERT 用) */
  masterId: string;
  /** 发布方 hostname(display 用,可改) */
  hostname: string;
  agents: FedVisibleAgent[];
}

export interface FedAgentUnpublish {
  type: "fed_agent_unpublish";
  teamId: string;
  masterId: string;
  agents: Array<{ hostname: string; name: string }>;
}

// ─── 目录同步(协调 → member) ──────────────────────────────────────────────

export interface FedDirectorySyncEntry {
  masterId: string;
  hostname: string;
  name: string;
  displayName?: string;
  isHuman: boolean;
  online: boolean;
  /** 协调侧最近一次心跳时间(ISO),member 用来判断 stale */
  lastHeartbeat?: string;
}

export interface FedDirectorySync {
  type: "fed_directory_sync";
  teamId: string;
  /** upsert 全量同步(简单起见 Phase 2 全量,Phase 3 加 diff) */
  upsert: FedDirectorySyncEntry[];
  /** 移除的 agent(masterId+name 复合定位) */
  remove: Array<{ masterId: string; name: string }>;
}

// ─── 消息路由 ──────────────────────────────────────────────────────────────

/** 单条对话上下文(跨 master 投递时透传) */
export interface FedConversationRef {
  type: "single" | "group";
  groupId?: string;
  groupName?: string;
}

/** 跨机路由的目标 agent 标识 */
export interface FedAgentRef {
  hostname: string;
  name: string;
}

/** 文件附件(跨机不传文件内容,只传引用;member 各自解析) */
export interface FedFileRef {
  name: string;
  /** Phase 2 简化:仅 URI 字符串,member 端按需 fetch */
  uri: string;
}

export interface FedRouteMessage {
  /** member → coord:请求投递一条消息到目标 master */
  type: "fed_route";
  teamId: string;
  /** 与现有 router pendingRequests 复用的 requestId */
  requestId: string;
  from: FedAgentRef;
  to: FedAgentRef;
  payload: {
    message: string;
    files?: FedFileRef[];
  };
  conversation?: FedConversationRef;
}

export interface FedRouteDeliver {
  /** coord → 目标 member:实际投递 */
  type: "fed_deliver";
  requestId: string;
  from: FedAgentRef;
  to: FedAgentRef;
  payload: {
    message: string;
    files?: FedFileRef[];
  };
  conversation?: FedConversationRef;
}

export interface FedRouteReply {
  /** member → coord → 来源 member:回复 */
  type: "fed_reply";
  requestId: string;
  from: FedAgentRef;
  payload: {
    message: string;
  };
}

// ─── Union + guard ──────────────────────────────────────────────────────────

export type FedMessage =
  | FedHandshake
  | FedHandshakeAck
  | FedAgentPublish
  | FedAgentUnpublish
  | FedDirectorySync
  | FedRouteMessage
  | FedRouteDeliver
  | FedRouteReply;

const FED_MESSAGE_TYPES = new Set<FedMessage["type"]>([
  "fed_handshake",
  "fed_handshake_ack",
  "fed_agent_publish",
  "fed_agent_unpublish",
  "fed_directory_sync",
  "fed_route",
  "fed_deliver",
  "fed_reply",
]);

export function isFedMessage(x: unknown): x is FedMessage {
  if (!x || typeof x !== "object") return false;
  const msg = x as Record<string, unknown>;
  if (typeof msg.type !== "string") return false;
  return FED_MESSAGE_TYPES.has(msg.type as FedMessage["type"]);
}

/** 解析 "alice@hostA" 形式;无 @ 则只返回 name */
export function parseAgentRef(ref: string): { name: string; hostname?: string } {
  const at = ref.lastIndexOf("@");
  if (at <= 0) return { name: ref };
  return { name: ref.slice(0, at), hostname: ref.slice(at + 1) };
}

/** 组装 "alice@hostA" 形式 */
export function formatAgentRef(name: string, hostname: string): string {
  return `${name}@${hostname}`;
}
