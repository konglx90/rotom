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
import { ISSUE_STATUSES, type IssueStatus } from "../shared/constants.js";

export async function cmdIssue(agent: ResolvedAgent, rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const sub = rest[0];

  if (sub === "list") {
    const groupId = rest[1]; if (!groupId) fail("usage: rotom issue list <groupId> [--status S] [--type task|collaboration]");
    const qs = new URLSearchParams();
    const status = flagStr(flags, "status"); if (status) qs.set("status", status);
    const type = flagStr(flags, "type"); if (type) qs.set("type", type);
    const route = `/groups/${encodeURIComponent(groupId)}/issues${qs.toString() ? `?${qs}` : ""}`;
    const data = await api(agent, "GET", route);
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
    const id = rest[1]; if (!id) fail("usage: rotom issue show <issueId>");
    const data = await api(agent, "GET", `/issues/${encodeURIComponent(id)}`);
    printJson(data);
    return;
  }

  if (sub === "events") {
    const id = rest[1]; if (!id) fail("usage: rotom issue events <issueId>");
    const data = await api(agent, "GET", `/issues/${encodeURIComponent(id)}/events`);
    printTable(
      data.map((e: any) => ({
        time: e.created_at,
        type: e.event_type,
        agent: e.agent_name,
        content: (e.content || "").slice(0, 80),
      })),
      ["time", "type", "agent", "content"],
    );
    return;
  }

  if (sub === "messages") {
    const id = rest[1]; if (!id) fail("usage: rotom issue messages <issueId>");
    const data = await api(agent, "GET", `/issues/${encodeURIComponent(id)}/messages`);
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
    const id = rest[1]; if (!id) fail("usage: rotom issue comment <issueId> --message M [--reply-to <eventId>]");
    const message = requireFlag(flags, "message");
    const replyTo = flagInt(flags, "reply-to");
    const data = await api(agent, "POST", `/issues/${encodeURIComponent(id)}/comments`, {
      agentName: agent.name, content: message, replyTo: replyTo ?? undefined,
    });
    printJson(data);
    return;
  }

  if (sub === "create") {
    const groupId = rest[1];
    if (!groupId) fail("usage: rotom issue create <groupId> --description D [--title T] [--priority P] [--assignee A] [--approval-policy r_allow|rw_allow] [--run]");
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
    const created = await api(agent, "POST", `/groups/${encodeURIComponent(groupId)}/issues`, body);
    const issueId = created?.id as string | undefined;
    if (!issueId) {
      printJson(created);
      return;
    }
    let assigned = false;
    let runPushed: unknown = null;
    if (assignee) {
      await api(agent, "PUT", `/issues/${encodeURIComponent(issueId)}`, { assignedTo: assignee });
      assigned = true;
    }
    if (run) {
      const prompt = description.trim() || (title || "").trim();
      runPushed = await api(agent, "POST", `/issues/${encodeURIComponent(issueId)}/append`, {
        prompt, appendedBy: agent.name,
      });
    }
    printJson({ ...created, assignedTo: assigned ? assignee : null, run: runPushed });
    return;
  }

  if (sub === "update") {
    const id = rest[1];
    if (!id) fail("usage: rotom issue update <issueId> [--title T] [--description D] [--priority low|medium|high|critical] [--assignee A | --unassign] [--approval-policy r_allow|rw_allow] [--status open|in_progress|completed|failed|cancelled]");
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
    const data = await api(agent, "PUT", `/issues/${encodeURIComponent(id)}`, body);
    printJson(data);
    return;
  }

  if (sub === "cancel") {
    const id = rest[1]; if (!id) fail("usage: rotom issue cancel <issueId>");
    const data = await api(agent, "PUT", `/issues/${encodeURIComponent(id)}`, { status: "cancelled" });
    printJson(data);
    return;
  }

  if (sub === "delete") {
    const id = rest[1]; if (!id) fail("usage: rotom issue delete <issueId>");
    const data = await api(agent, "DELETE", `/issues/${encodeURIComponent(id)}`);
    printJson(data);
    return;
  }

  fail(`unknown issue subcommand: ${sub || "(none)"}`);
}
