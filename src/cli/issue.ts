/**
 * rotom issue — issue list/show/events/messages/comment/create/update/cancel/delete.
 */

import {
  type ResolvedAgent,
  api,
  printJson,
  printTable,
  fail,
  flagStr,
  flagInt,
  requireFlag,
  pretty,
} from "./common.js";
import { route, qs, usage, unknownSubcommand } from "./routes.js";
import { ISSUE_STATUSES, type IssueStatus } from "../shared/constants.js";

export async function cmdIssue(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];

  if (sub === "list") {
    const groupId = rest[1]; if (!groupId) usage("issue list", "<groupId> [--status S] [--type task]");
    const status = flagStr(flags, "status");
    const type = flagStr(flags, "type");
    const routePath = `${route("/groups/:groupId/issues", groupId)}${qs({ status, type })}`;
    const data = await api(agent, "GET", routePath);
    printTable(
      data.map((i: any) => ({
        id: i.id,
        type: i.type,
        status: i.status,
        priority: i.priority,
        title: (i.title || "").slice(0, 60),
      })),
      ["id", "type", "status", "priority", "title"],
    );
    return;
  }

  if (sub === "show") {
    const id = rest[1]; if (!id) usage("issue show", "<issueId>");
    const data = await api(agent, "GET", route("/issues/:id", id));
    printJson(data);
    return;
  }

  if (sub === "events") {
    const id = rest[1]; if (!id) usage("issue events", "<issueId> [--content-len N] [--no-clean]");
    const contentLen = flagInt(flags, "content-len") ?? 200;
    const clean = flags["clean"] !== false;
    const data = await api(agent, "GET", route("/issues/:id/events", id));
    printTable(
      data.map((e: any) => {
        let content = (e.content || "").replace(/\s+/g, " ");
        if (clean) {
          content = content
            .replace(/\[(\w[\w-]*(?::\w[\w-]*)?)\].*?\[\/\1\]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        }
        return {
          time: e.created_at,
          type: e.event_type,
          agent: e.agent_name,
          content: content.slice(0, contentLen),
        };
      }),
      ["time", "type", "agent", "content"],
    );
    return;
  }

  if (sub === "messages") {
    const id = rest[1]; if (!id) usage("issue messages", "<issueId>");
    const data = await api(agent, "GET", route("/issues/:id/messages", id));
    if (pretty) {
      printTable(
        data.map((m: any) => {
          const quoted = m.quoted
            ? `> ${(m.quoted.agent_name || "").slice(0, 10)}: ${(m.quoted.content || "").slice(0, 30)}`
            : "";
          return {
            id: m.id,
            type: m.event_type,
            agent: m.agent_name,
            content: (m.content || "").slice(0, 60),
            quoted,
            created_at: m.created_at,
          };
        }),
        ["id", "type", "agent", "content", "quoted", "created_at"],
      );
    } else {
      printJson(data);
    }
    return;
  }

  if (sub === "comment") {
    const id = rest[1]; if (!id) usage("issue comment", "<issueId> --message M [--reply-to <eventId>]");
    const message = requireFlag(flags, "message");
    const replyTo = flagInt(flags, "reply-to");
    const data = await api(agent, "POST", route("/issues/:id/comments", id), {
      agentName: agent.name, content: message, replyTo: replyTo ?? undefined,
    });
    printJson(data);
    return;
  }

  if (sub === "create") {
    const groupId = rest[1];
    if (!groupId) usage("issue create", "<groupId> --description D [--title T] [--priority P] [--assignee A] [--approval-policy r_allow|rw_allow] [--run]");
    const title = flagStr(flags, "title");
    const description = flagStr(flags, "description") || "";
    const priority = flagStr(flags, "priority") || "medium";
    const assignee = flagStr(flags, "assignee");
    const approvalPolicyRaw = flagStr(flags, "approval-policy");
    const run = flags.run === true;
    if (!description && !title) {
      fail("--description (or --title) is required");
    }
    if (approvalPolicyRaw && approvalPolicyRaw !== "r_allow" && approvalPolicyRaw !== "rw_allow") {
      fail('--approval-policy must be "r_allow" or "rw_allow"');
    }
    if (run && !assignee) {
      fail("--run requires --assignee (cannot start an unassigned issue)");
    }
    const body: Record<string, unknown> = { description, priority, createdBy: agent.name };
    if (title) body.title = title;
    if (approvalPolicyRaw) body.approvalPolicy = approvalPolicyRaw;
    const created = await api(agent, "POST", route("/groups/:groupId/issues", groupId), body);
    const issueId = created?.id as string | undefined;
    if (!issueId) {
      printJson(created);
      return;
    }
    let assigned = false;
    let runPushed: unknown = null;
    if (assignee) {
      await api(agent, "PUT", route("/issues/:id", issueId), { assignedTo: assignee });
      assigned = true;
    }
    if (run) {
      const prompt = description.trim() || (title || "").trim();
      runPushed = await api(agent, "POST", route("/issues/:id/append", issueId), {
        prompt, appendedBy: agent.name,
      });
    }
    printJson({ ...created, assignedTo: assigned ? assignee : null, run: runPushed });
    return;
  }

  if (sub === "update") {
    const id = rest[1];
    if (!id) usage("issue update", "<issueId> [--title T] [--description D] [--priority low|medium|high|critical] [--assignee A | --unassign] [--approval-policy r_allow|rw_allow] [--status open|in_progress|completed|failed|cancelled]");
    const title = flagStr(flags, "title");
    const description = flagStr(flags, "description");
    const priority = flagStr(flags, "priority");
    const assignee = flagStr(flags, "assignee");
    const unassign = flags.unassign === true;
    const approvalPolicyRaw = flagStr(flags, "approval-policy");
    const statusRaw = flagStr(flags, "status");

    if (assignee !== undefined && unassign) {
      fail("--assignee and --unassign are mutually exclusive");
    }
    if (priority !== undefined && !["low", "medium", "high", "critical"].includes(priority)) {
      fail(`--priority must be one of low|medium|high|critical (got: ${priority})`);
    }
    if (approvalPolicyRaw !== undefined && approvalPolicyRaw !== "r_allow" && approvalPolicyRaw !== "rw_allow") {
      fail(`--approval-policy must be "r_allow" or "rw_allow" (got: ${approvalPolicyRaw})`);
    }
    if (statusRaw !== undefined && !ISSUE_STATUSES.includes(statusRaw as IssueStatus)) {
      fail(`--status must be one of ${ISSUE_STATUSES.join("|")} (got: ${statusRaw})`);
    }

    const body: Record<string, unknown> = {};
    if (title !== undefined) body.title = title;
    if (description !== undefined) body.description = description;
    if (priority !== undefined) body.priority = priority;
    if (assignee !== undefined) body.assignedTo = assignee;
    if (unassign) body.assignedTo = null;
    if (approvalPolicyRaw !== undefined) body.approvalPolicy = approvalPolicyRaw;
    if (statusRaw !== undefined) body.status = statusRaw;
    if (Object.keys(body).length === 0) {
      fail("no fields to update — pass at least one flag");
    }
    const data = await api(agent, "PUT", route("/issues/:id", id), body);
    printJson(data);
    return;
  }

  if (sub === "cancel") {
    const id = rest[1]; if (!id) usage("issue cancel", "<issueId>");
    const data = await api(agent, "PUT", route("/issues/:id", id), { status: "cancelled" });
    printJson(data);
    return;
  }

  if (sub === "delete") {
    const id = rest[1]; if (!id) usage("issue delete", "<issueId>");
    const data = await api(agent, "DELETE", route("/issues/:id", id));
    printJson(data);
    return;
  }

  unknownSubcommand("issue", sub);
}
