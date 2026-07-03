import { toBeijing } from "../shared/time.js";
/**
 * rotom ask —— ask-bridge 查询/取消(提问用 #reply 标记,系统自动建 bridge)。
 *
 * 子命令:
 *   list --group <gid> [--status pending|answered|timed_out|cancelled]
 *   show <bridgeId>
 *   cancel <bridgeId>
 */

import {
  type ResolvedAgent,
  api,
  printJson,
  printTable,
  fail,
  flagStr,
  pretty,
} from "./common.js";
import { route, qs, usage } from "./routes.js";

function formatBridgeRow(b: any) {
  return {
    id: b.id.slice(0, 8),
    group: b.group_id.slice(0, 8),
    asker: b.asker,
    target: b.target,
    status: b.status,
    escalate_to: b.escalate_to || "-",
    created: b.created_at ? toBeijing(b.created_at).slice(11, 19) : "-",
    expires: b.expires_at ? toBeijing(b.expires_at).slice(11, 19) : "-",
    reply_msg: b.reply_msg_id ?? "-",
    issue: b.issue_id ? b.issue_id.slice(0, 8) : "-",
  };
}

export async function cmdAsk(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];

  if (sub === "list") {
    const gid = flagStr(flags, "group");
    const status = flagStr(flags, "status");
    // /groups 列群不列 bridge;bridge 走 /groups/:id/asks
    if (!gid) usage("ask list", "--group <id> [--status pending|answered|timed_out|cancelled]");
    const data = await api(agent, "GET", `${route("/groups/:groupId/asks", gid)}${qs({ status })}`);
    if (pretty) {
      printTable((data as any[]).map(formatBridgeRow), ["id", "group", "asker", "target", "status", "escalate_to", "created", "expires", "reply_msg", "issue"]);
    } else {
      printJson(data);
    }
    return;
  }

  if (sub === "show") {
    const id = rest[1]; if (!id) usage("ask show", "<bridgeId>");
    const data = await api(agent, "GET", route("/asks/:id", id));
    printJson(data);
    return;
  }

  if (sub === "cancel") {
    const id = rest[1]; if (!id) usage("ask cancel", "<bridgeId>");
    const data = await api(agent, "POST", route("/asks/:id/cancel", id));
    printJson(data);
    return;
  }

  // ask 子命令已废弃——提问用 #reply 标记(系统自动建 bridge)。
  // 保留 list/show/cancel 供 agent 主动查询/取消。
  fail(`rotom ask 子命令已废弃。提问直接在回复里 @ 对方 + #reply 标记,系统自动起 timer。\n可用:rotom ask list | show <id> | cancel <id>`);
}
