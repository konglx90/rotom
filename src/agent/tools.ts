/**
 * Digital Employee Mesh — Agent Tools
 *
 * 7 tools registered for the LLM to use:
 * - mesh_directory: List agents in the mesh
 * - mesh_group_send: Send a message in a group (all members see the reply)
 * - mesh_group_messages: Get latest N messages from a group
 * - mesh_group_members: Get member list of a group
 * - mesh_create_issue: Create an issue for 稳交付组 to handle
 * - mesh_create_collaboration: Create a collaboration issue for multiple agents
 */

import { randomUUID } from "node:crypto";
import type { SocketManager } from "./socket-manager.js";
import type { Directory } from "./directory.js";
import type { ServerMessage, ServerRouteResultMessage, ServerA2AMessage, ServerGroupHistoryResponseMessage, ServerGroupMembersResponseMessage, ServerCreateIssueResponseMessage, ServerCreateCollaborationResponseMessage } from "../shared/protocol.js";

// ---------------------------------------------------------------------------
// Tool definitions for OpenClaw registration
// ---------------------------------------------------------------------------

export const MESH_TOOLS = [
  {
    name: "mesh_directory",
    description: "查看数字员工通讯录。列出 Mesh 网络中所有已注册的数字员工及其状态、岗位、负责内容和技术栈。你可以通过此工具了解其他数字员工的角色和能力，以便精确路由消息。",
    parameters: {
      type: "object" as const,
      properties: {
        domain: {
          type: "string",
          description: "可选：按域过滤（如 'insurance', 'payment'）",
        },
        onlineOnly: {
          type: "boolean",
          description: "是否只显示在线的数字员工（默认 false）",
        },
      },
    },
  },
  {
    name: "mesh_group_send",
    description: "在群里向指定数字员工发送消息（发完即返回，不等待回复）。回复内容群内所有成员可见。用于群聊场景——当你在群消息上下文中需要呼叫某个 agent 时使用此工具。重要：(1) message 内容必须以 @目标名字 开头，例如 target='cx' 则 message 应为 '@cx 你好'。(2) 每轮只能调用一次此工具，调用后立即停止输出，等待对方回复作为新的群消息到达。(3) 绝对不能在同一轮里连续调用多次，也不能自己编造对方的回答。",
    parameters: {
      type: "object" as const,
      properties: {
        target: {
          type: "string",
          description: "目标数字员工的名字（如 '小付'）",
        },
        message: {
          type: "string",
          description: "要发送的消息内容",
        },
        groupId: {
          type: "string",
          description: "群 ID（从群消息上下文中获取）",
        },
        groupName: {
          type: "string",
          description: "群名称（从群消息上下文中获取）",
        },
      },
      required: ["target", "message", "groupId"],
    },
  },
  {
    name: "mesh_group_messages",
    description: "获取指定群的最近 N 条消息历史。用于了解群聊上下文、回顾讨论内容。",
    parameters: {
      type: "object" as const,
      properties: {
        groupId: {
          type: "string",
          description: "群 ID",
        },
        limit: {
          type: "number",
          description: "获取的消息条数（默认 50，最大 200）",
        },
      },
      required: ["groupId"],
    },
  },
  {
    name: "mesh_create_issue",
    description: "创建 Issue 给稳交付组处理。在群中创建一个任务，稳交付组 Agent 会自动领取并执行。创建后可通过群消息接收任务完成通知。注意：必须先通过 mesh_group_members 确认你是指定群的成员才能创建。",
    parameters: {
      type: "object" as const,
      properties: {
        groupId: {
          type: "string",
          description: "群 ID（从群消息上下文中获取，或通过 mesh_group_members 查询）",
        },
        title: {
          type: "string",
          description: "Issue 标题，简洁描述要稳交付组完成的任务",
        },
        description: {
          type: "string",
          description: "可选：任务详细描述，包括背景、需求、验收标准等",
        },
        priority: {
          type: "string",
          description: "可选：优先级（low/medium/high/critical，默认 medium）",
        },
        workingDir: {
          type: "string",
          description: "可选：工作目录路径（默认使用稳交付 Agent 的工作目录）",
        },
      },
      required: ["groupId", "title"],
    },
  },
  {
    name: "mesh_group_members",
    description: "获取指定群的成员列表。返回群里所有成员的名字和加入时间。",
    parameters: {
      type: "object" as const,
      properties: {
        groupId: {
          type: "string",
          description: "群 ID（从群消息上下文中获取）",
        },
      },
      required: ["groupId"],
    },
  },
  {
    name: "mesh_create_collaboration",
    description: "创建一个协作 Issue，邀请多个数字员工围绕一个目标协作完成。协作启动后，Master 只会通知 participants[0]（第一个发言人），由其决策下一步：在群里 @ 下一个人继续，或调用 mesh_conclude_collaboration 主动结束。",
    parameters: {
      type: "object" as const,
      properties: {
        groupId: {
          type: "string",
          description: "群 ID（从群消息上下文中获取，或通过 mesh_group_members 查询）",
        },
        title: {
          type: "string",
          description: "协作标题",
        },
        collaborationGoal: {
          type: "string",
          description: "协作目标/任务描述，说明需要协作完成什么",
        },
        participants: {
          type: "array",
          items: { type: "string" },
          description: "参与协作的数字员工名字列表（至少 2 人）。第一个名字会成为协作的发起人，由其决策协作走向。",
        },
        maxRounds: {
          type: "number",
          description: "最大协作轮数（默认 3）",
        },
        owner: {
          type: "string",
          description: "可选：负责该协作的真人名字。不填则该协作没有负责人。",
        },
      },
      required: ["groupId", "title", "collaborationGoal", "participants"],
    },
  },
  {
    name: "mesh_conclude_collaboration",
    description: "主动结束一个进行中的协作 Issue 并生成总结。当协作目标已达成、或当前发言人判断无需继续时调用。仅协作的参与者可调用。",
    parameters: {
      type: "object" as const,
      properties: {
        issueId: {
          type: "string",
          description: "协作 Issue 的 ID（从 collaboration_started 消息或群消息上下文中获取）",
        },
        summary: {
          type: "string",
          description: "协作的总结：达成了什么、产出是什么、待跟进的内容",
        },
      },
      required: ["issueId", "summary"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export class MeshToolExecutor {
  /** Pending route results / replies, keyed by requestId */
  private pending = new Map<string, {
    resolve: (value: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** RequestIds of group messages sent by this agent (fire-and-forget) */
  private sentGroupRequests = new Set<string>();

  constructor(
    private socket: SocketManager,
    private directory: Directory,
    private selfName?: string,
  ) {}

  /** Handle a server message that might resolve a pending tool call. */
  handleMessage(msg: ServerMessage): boolean {
    // Clean up stale group request tracking on reply
    if (msg.type === "a2a_message" && msg.routeType === "reply") {
      this.sentGroupRequests.delete(msg.requestId);
    }
    if (msg.type === "route_result") {
      return this.resolvePending(msg.requestId, msg);
    }
    if (msg.type === "a2a_message" && msg.routeType === "reply") {
      return this.resolvePending(msg.requestId, msg);
    }
    if (msg.type === "group_history_response") {
      return this.resolvePending(msg.requestId, msg);
    }
    if (msg.type === "group_members_response") {
      return this.resolvePending(msg.requestId, msg);
    }
    if (msg.type === "create_issue_response") {
      return this.resolvePending(msg.requestId, msg);
    }
    if (msg.type === "create_collaboration_response") {
      return this.resolvePending(msg.requestId, msg);
    }
    return false;
  }

  /** Check if a requestId was a group message sent by this agent. */
  isSentGroupRequest(requestId: string): boolean {
    return this.sentGroupRequests.has(requestId);
  }

  /** Execute a tool call. Returns the result string. */
  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case "mesh_directory":
        return this.execDirectory(args);
      case "mesh_group_send":
        return this.execGroupSend(args);
      case "mesh_group_messages":
        return this.execGroupMessages(args);
      case "mesh_group_members":
        return this.execGroupMembers(args);
      case "mesh_create_issue":
        return this.execCreateIssue(args);
      case "mesh_create_collaboration":
        return this.execCreateCollaboration(args);
      case "mesh_conclude_collaboration":
        return this.execConcludeCollaboration(args);
      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  }

  stop(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ error: "Mesh shutting down" });
    }
    this.pending.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool implementations
  // ═══════════════════════════════════════════════════════════════════════════

  private execDirectory(args: Record<string, unknown>): string {
    let agents = this.directory.list();

    if (args.domain && typeof args.domain === "string") {
      agents = agents.filter((a) => a.domain === args.domain);
    }
    if (args.onlineOnly) {
      agents = agents.filter((a) => a.status === "online");
    }

    const result = agents.map((a) => ({
      name: a.name,
      domain: a.domain || "无",
      status: a.status,
      description: a.description || "无",
      ...(a.profile?.position ? { position: a.profile.position } : {}),
      ...(a.profile?.responsibilities ? { responsibilities: a.profile.responsibilities } : {}),
      ...(a.profile?.tech_stack ? { tech_stack: a.profile.tech_stack } : {}),
    }));

    return JSON.stringify({
      total: result.length,
      agents: result,
    }, null, 2);
  }

  private execGroupSend(args: Record<string, unknown>): string {
    const target = args.target as string;
    const message = args.message as string;
    const groupId = args.groupId as string;
    const groupName = (args.groupName as string) || groupId;
    if (!target || !message || !groupId) {
      return JSON.stringify({ error: "target、message 和 groupId 必填" });
    }

    if (this.selfName && target === this.selfName) {
      return JSON.stringify({
        error: `不能给自己发消息。你自己就是"${this.selfName}"，群里 @${this.selfName} 就是在叫你回答，直接回答即可，不要调用 mesh_group_send。`,
      });
    }

    const requestId = `grp-tool-${randomUUID()}`;

    const sent = this.socket.send({
      type: "a2a_send",
      requestId,
      target,
      payload: { message },
      conversation: { type: "group" as const, groupId, groupName },
    });

    if (sent) this.sentGroupRequests.add(requestId);

    if (!sent) {
      return JSON.stringify({ error: "未连接到 Mesh Master" });
    }

    return JSON.stringify({ status: "已发送", target, note: "对方的回复会作为新的群消息到达" });
  }

  private async execGroupMessages(args: Record<string, unknown>): Promise<string> {
    const groupId = args.groupId as string;
    const limit = (args.limit as number) || 50;
    if (!groupId) {
      return JSON.stringify({ error: "groupId 必填" });
    }

    const requestId = `tool-${randomUUID()}`;

    const sent = this.socket.send({
      type: "group_history_request",
      requestId,
      groupId,
      limit,
    });

    if (!sent) {
      return JSON.stringify({ error: "未连接到 Mesh Master" });
    }

    const response = await this.waitForMessage(requestId, 15_000) as ServerGroupHistoryResponseMessage | null;
    if (!response) {
      return JSON.stringify({ error: "获取群消息超时" });
    }
    if (response.error) {
      return JSON.stringify({ error: response.error });
    }

    return JSON.stringify({
      groupId,
      total: response.messages.length,
      messages: response.messages,
    }, null, 2);
  }

  private async execGroupMembers(args: Record<string, unknown>): Promise<string> {
    const groupId = args.groupId as string;
    if (!groupId) {
      return JSON.stringify({ error: "groupId 必填" });
    }

    const requestId = `tool-${randomUUID()}`;

    const sent = this.socket.send({
      type: "group_members_request",
      requestId,
      groupId,
    });

    if (!sent) {
      return JSON.stringify({ error: "未连接到 Mesh Master" });
    }

    const response = await this.waitForMessage(requestId, 15_000) as ServerGroupMembersResponseMessage | null;
    if (!response) {
      return JSON.stringify({ error: "获取群成员超时" });
    }
    if (response.error) {
      return JSON.stringify({ error: response.error });
    }

    return JSON.stringify({
      groupId,
      total: response.members.length,
      members: response.members,
    }, null, 2);
  }

  private async execCreateIssue(args: Record<string, unknown>): Promise<string> {
    const groupId = args.groupId as string;
    const title = args.title as string;
    const description = args.description as string | undefined;
    const priority = args.priority as string | undefined;
    const workingDir = args.workingDir as string | undefined;
    if (!groupId || !title) {
      return JSON.stringify({ error: "groupId 和 title 必填" });
    }

    const requestId = `issue-tool-${randomUUID()}`;

    const sent = this.socket.send({
      type: "create_issue",
      requestId,
      groupId,
      title,
      description,
      priority,
      workingDir,
    });

    if (!sent) {
      return JSON.stringify({ error: "未连接到 Mesh Master" });
    }

    const response = await this.waitForMessage(requestId, 15_000) as ServerCreateIssueResponseMessage | null;
    if (!response) {
      return JSON.stringify({ error: "创建 Issue 超时" });
    }
    if (response.error) {
      return JSON.stringify({ error: response.error });
    }

    return JSON.stringify({
      status: "ok",
      issueId: response.issueId,
      title: response.title,
      note: "稳交付组 Agent 将自动领取并执行，完成后群内会收到通知",
    }, null, 2);
  }

  private async execCreateCollaboration(args: Record<string, unknown>): Promise<string> {
    const groupId = args.groupId as string;
    const title = args.title as string;
    const collaborationGoal = args.collaborationGoal as string;
    const participants = args.participants as string[];
    const maxRounds = (args.maxRounds as number) || 3;
    const owner = args.owner as string | undefined;

    if (!groupId || !title || !collaborationGoal || !participants?.length) {
      return JSON.stringify({ error: "groupId、title、collaborationGoal、participants 必填" });
    }

    if (participants.length < 2) {
      return JSON.stringify({ error: "至少需要 2 个参与者" });
    }

    const requestId = `collab-tool-${randomUUID()}`;

    const sent = this.socket.send({
      type: "create_collaboration",
      requestId,
      groupId,
      title,
      collaborationGoal,
      participants,
      maxRounds,
      ...(owner ? { owner } : {}),
    });

    if (!sent) {
      return JSON.stringify({ error: "未连接到 Mesh Master" });
    }

    const response = await this.waitForMessage(requestId, 15_000) as ServerCreateCollaborationResponseMessage | null;
    if (!response) {
      return JSON.stringify({ error: "创建协作 Issue 超时" });
    }
    if (response.error) {
      return JSON.stringify({ error: response.error });
    }

    return JSON.stringify({
      status: "ok",
      issueId: response.issueId,
      title: response.title,
      participants,
      maxRounds,
      ...(owner ? { owner } : {}),
      note: `协作已创建，Master 已通知首位发言人 ${participants[0]} 启动协作。后续由当前发言人自主决策 @ 下一位或调用 mesh_conclude_collaboration 主动结束。`,
    }, null, 2);
  }

  private async execConcludeCollaboration(args: Record<string, unknown>): Promise<string> {
    const issueId = args.issueId as string;
    const summary = args.summary as string;

    if (!issueId || !summary) {
      return JSON.stringify({ error: "issueId 和 summary 必填" });
    }

    const sent = this.socket.send({
      type: "conclude_collaboration",
      issueId,
      summary,
    });

    if (!sent) {
      return JSON.stringify({ error: "未连接到 Mesh Master" });
    }

    return JSON.stringify({
      status: "ok",
      issueId,
      note: "已请求结束协作，Master 会广播结论给所有参与者",
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pending message wait
  // ═══════════════════════════════════════════════════════════════════════════

  private waitForMessage(requestId: string, timeoutMs: number): Promise<ServerMessage | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, timeoutMs);

      this.pending.set(requestId, { resolve, timer });
    });
  }

  private resolvePending(requestId: string, msg: ServerMessage): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(msg);
    return true;
  }
}
