/**
 * dispatch-enrich —— master 在向 worker 发送 WS 消息前,把 `agentProfile` 与
 * `cwd` 注入 msg 的统一入口。
 *
 * 注入字段:
 *  - `agentProfile`: 从 `agents.profile` JSON 解析,worker 收到后更新本地缓存,
 *    供 prompt-composer 渲染 `[Agent 角色]` 层。Dashboard 编辑后下一条 dispatch
 *    即时生效,无需重启 executor。
 *  - `cwd`: 由 `resolveGroupAgentWorkingDir` 派生,worker 收到后若本机存在该路径
 *    则覆盖本地派生(跨机器部署时本机无该路径则静默回落)。
 *
 * 设计为纯函数,只依赖 `db`,ws-hub method bag 与 api 层都能直接调。
 */

import { parseAgentProfile } from "../../shared/agent-profile.js";
import { resolveGroupAgentWorkingDir } from "../group-paths.js";
import type { AgentProfile, ServerMessage } from "../../shared/protocol.js";
import type { MeshDb } from "../db.js";

/** 调用方仅需提供 db(ws-hub method bag 传 this,api 层传 hub 实例)。
 *  agentName / groupId 任一缺失时跳过对应字段的注入(返回 undefined)。 */
export function enrichWorkerDispatch<T extends ServerMessage>(
  self: { db: MeshDb },
  msg: T,
  agentName: string | undefined,
  groupId: string | undefined,
): T {
  const profile: AgentProfile | undefined = agentName
    ? (() => {
        const agent = self.db.getAgentByName(agentName);
        return agent?.profile ? parseAgentProfile(agent.profile) ?? undefined : undefined;
      })()
    : undefined;
  const cwd: string | undefined = agentName && groupId
    ? resolveGroupAgentWorkingDir(self.db, groupId, agentName)
    : undefined;
  return { ...msg, agentProfile: profile, cwd };
}
