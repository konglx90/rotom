import { nowBeijing, shiftBeijing } from "../../shared/time.js";
import { safeJsonParse } from "../../shared/parse.js";
import { buildUpdate } from "./build-update.js";
/**
 * Issues — task CRUD, event timeline, comments/quotas, approval lifecycle.
 *
 * Methods attach to a `MeshDb` instance via `Object.assign`. Cross-module:
 *   - `updateIssueStatus` fires `_onIssueTerminal` hook (set by server.ts for
 *     E2ED auto-sync).
 *
 * Event timeline pagination (getIssueEvents) keeps the head of progress
 * chunks and tail of recent chunks, with a virtual `progress_truncated`
 * marker in between — see the long-form comment in `getIssueEvents`.
 */

import type { IssueEventRow, IssueRow } from "./types.js";
import type { MeshDbSelf } from "./core.js";

export const issueMethods = {
  createIssue(this: MeshDbSelf, issue: {
    id: string; groupId: string; title: string; description?: string;
    priority?: string; createdBy: string; workingDir?: string;
    slashCommand?: string;
    approvalPolicy?: "r_allow" | "rw_allow";
    type?: string; assignedTo?: string;
    /** issue 级 repo 覆盖(migration 051)。NULL/空 = 沿用 group.repo_url。 */
    repoUrl?: string;
    /** issue 级分支覆盖。NULL/空 = 沿用 group.repo_default_branch。 */
    repoBranch?: string;
  }): void {
    const now = nowBeijing();
    this.db.prepare(`
      INSERT INTO issues (id, group_id, title, description, priority, created_by, working_dir, type, slash_command, approval_policy, assigned_to, created_at, repo_url, repo_branch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      issue.id, issue.groupId, issue.title,
      issue.description || "", issue.priority || "medium",
      issue.createdBy, issue.workingDir || null,
      issue.type || "task",
      issue.slashCommand || null,
      issue.approvalPolicy || "rw_allow",
      issue.assignedTo || null,
      now,
      issue.repoUrl || null,
      issue.repoBranch || null,
    );
    this.db.prepare(`
      INSERT INTO issue_events (issue_id, event_type, agent_name, content, created_at)
      VALUES (?, 'created', ?, '', ?)
    `).run(issue.id, issue.createdBy, now);
  },

  getIssueById(this: MeshDbSelf, id: string): IssueRow | undefined {
    return this.db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined;
  },

  listIssuesByGroup(this: MeshDbSelf, groupId: string, status?: string, type?: string): IssueRow[] {
    let sql = "SELECT * FROM issues WHERE group_id = ?";
    const params: unknown[] = [groupId];
    if (status) { sql += " AND status = ?"; params.push(status); }
    if (type) { sql += " AND type = ?"; params.push(type); }
    sql += " ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'failed' THEN 2 WHEN 'cancelled' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END, created_at DESC";
    return this.db.prepare(sql).all(...params) as IssueRow[];
  },

  listAllIssues(this: MeshDbSelf, status?: string): IssueRow[] {
    let sql = "SELECT * FROM issues";
    const params: unknown[] = [];
    if (status) { sql += " WHERE status = ?"; params.push(status); }
    sql += " ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'failed' THEN 2 WHEN 'cancelled' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END, created_at DESC";
    return this.db.prepare(sql).all(...params) as IssueRow[];
  },

  /**
   * 分页拉取 issue。看板每列独立分页(默认首屏 50 条),避免 completed/cancelled
   * 累积过多时一次性把全表拉到前端。total 是不带 limit/offset 的全量计数,
   * 给列头展示真实总数;items 是当前页。排序与 listAllIssues 保持一致。
   */
  listIssuesPage(
    this: MeshDbSelf,
    opts: { status?: string; limit: number; offset: number },
  ): { items: IssueRow[]; total: number } {
    const orderSql =
      " ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'failed' THEN 2 WHEN 'cancelled' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END, created_at DESC";
    const where = opts.status ? " WHERE status = ?" : "";
    const params: unknown[] = opts.status ? [opts.status] : [];
    const total = (
      this.db.prepare(`SELECT COUNT(*) as n FROM issues${where}`).get(...params) as { n: number }
    ).n;
    const items = this.db
      .prepare(`SELECT * FROM issues${where}${orderSql} LIMIT ? OFFSET ?`)
      .all(...params, opts.limit, opts.offset) as IssueRow[];
    return { items, total };
  },

  updateIssueStatus(this: MeshDbSelf, id: string, status: string, extra?: {
    assignedTo?: string | null;
    result?: string | null;
    errorMessage?: string | null;
    artifacts?: string[];
    /** Update session_id (added in migration 013). `null` clears it. */
    sessionId?: string | null;
    /** Update cli_tool (added in migration 013). `null` clears it. */
    cliTool?: string | null;
    /** Token usage JSON string (added in migration 025). `null` clears it. */
    usage?: string | null;
    /** Model name the backend reported (added in migration 025). */
    model?: string | null;
  }): void {
    const now = nowBeijing();
    const built = buildUpdate({
      table: "issues",
      sets: {
        status,
        assigned_to: extra?.assignedTo,
        result: extra?.result,
        error_message: extra?.errorMessage,
        artifacts: extra?.artifacts !== undefined ? JSON.stringify(extra.artifacts) : undefined,
        session_id: extra?.sessionId,
        cli_tool: extra?.cliTool,
        usage: extra?.usage,
        model: extra?.model,
      },
      where: "id = ?",
      whereParams: [id],
      updatedAt: false,
      extraSets: [
        { sql: "updated_at = ?", params: [now] },
        // started_at 只在第一次进 in_progress 时写,后续 progress 事件不覆盖——
        // 否则最后一次 in_progress(带 result)会把 started_at 推到接近完成时间,
        // 导致总耗时显示成 0。COALESCE 保留已有值,paused → in_progress 续跑时
        // 也保留首次开始时间(总耗时含 paused 段,反映"从开始到结束"的真实时长)。
        ...(status === "in_progress" ? [{ sql: "started_at = COALESCE(started_at, ?)", params: [now] }] : []),
        ...(status === "completed" || status === "failed" || status === "cancelled"
          ? [{ sql: "completed_at = ?", params: [now] }]
          : []),
      ],
    });
    if (built) this.db.prepare(built.sql).run(...built.params);

    // E2ED auto-sync hook: when an issue reaches terminal state, notify
    // registered listeners so e2ed can advance requirement status.
    if (status === "completed" || status === "failed" || status === "cancelled") {
      this._onIssueTerminal?.(id);
    }
  },

  updateIssueWorkingDir(this: MeshDbSelf, id: string, workingDir: string | null): void {
    this.db.prepare(
      "UPDATE issues SET working_dir = ?, updated_at = ? WHERE id = ?",
    ).run(workingDir, nowBeijing(), id);
  },

  /**
   * 覆盖式写入 issues.latest_todos_json。每次 worker 解析到 TodoWrite tool_use
   * 都调一次(全量替换);是否额外落 issue_event 由调用方(ws-hub)按内容 hash
   * 去重决定,这里只管快照列。
   */
  updateIssueTodos(this: MeshDbSelf, id: string, todos: unknown[]): void {
    this.db.prepare(
      "UPDATE issues SET latest_todos_json = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(todos), nowBeijing(), id);
  },

  /**
   * 反查最新绑定到某个 sessionId 的 issue。
   * session_id 由 migration 013 加入,无 session_id 列的旧 DB 走不到这里。
   */
  getLatestIssueBySessionId(this: MeshDbSelf, sessionId: string): IssueRow | undefined {
    return this.db.prepare(
      "SELECT * FROM issues WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(sessionId) as IssueRow | undefined;
  },

  /**
   * 查该 (cliTool, groupId) 下最新的 issue。Debug Sessions 视图用:
   * worker SessionStore 跟 issues.session_id 是两条独立路径(SessionStore
   * 只在 chat 路径更新,issue 执行不写 SessionStore),所以反查
   * session_id 经常落空。改用 (cliTool, groupId) 取最新一条 issue,展示
   * 「上次 claude/codex 在这个群里跑了多少 token」更贴近用户预期。
   */
  getLatestIssueByCliTool(this: MeshDbSelf, cliTool: string, groupId: string): IssueRow | undefined {
    return this.db.prepare(
      "SELECT * FROM issues WHERE cli_tool = ? AND group_id = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(cliTool, groupId) as IssueRow | undefined;
  },

  /** Atomically claim the next unassigned issue for an executor agent. */
  claimNextIssue(this: MeshDbSelf, agentName: string): IssueRow | undefined {
    const issue = this.db.prepare(`
      SELECT i.* FROM issues i
      JOIN groups g ON g.id = i.group_id
      WHERE i.status = 'open' AND i.assigned_to IS NULL AND i.type = 'task'
        AND g.archived_at IS NULL
      ORDER BY
        CASE i.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        i.created_at ASC
      LIMIT 1
    `).get() as IssueRow | undefined;
    if (!issue) return undefined;
    // Atomic update: only claim if still unassigned
    const now = nowBeijing();
    const result = this.db.prepare(
      "UPDATE issues SET assigned_to = ?, status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ? AND assigned_to IS NULL",
    ).run(agentName, now, now, issue.id);
    if (result.changes === 0) return undefined;
    this.db.prepare(`
      INSERT INTO issue_events (issue_id, event_type, agent_name, content, created_at)
      VALUES (?, 'assigned', ?, ?, ?)
    `).run(issue.id, agentName, `Claimed by ${agentName}`, now);
    return this.getIssueById(issue.id);
  },

  addIssueEvent(this: MeshDbSelf, event: {
    issueId: string; eventType: string; agentName: string;
    content?: string; metadata?: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT INTO issue_events (issue_id, event_type, agent_name, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.issueId, event.eventType, event.agentName,
      event.content || "", JSON.stringify(event.metadata || {}),
      nowBeijing(),
    );
  },

  /**
   * Post a comment/message on an issue, optionally replying to a specific
   * event (message quoting). Returns the new event ID.
   */
  addIssueComment(this: MeshDbSelf, issueId: string, agentName: string, content: string, replyToId?: number): number {
    const result = this.db.prepare(`
      INSERT INTO issue_events (issue_id, event_type, agent_name, content, metadata, reply_to_id, created_at)
      VALUES (?, 'comment', ?, ?, '{}', ?, ?)
    `).run(
      issueId, agentName, content, replyToId ?? null,
      nowBeijing(),
    );
    return Number(result.lastInsertRowid);
  },

  /**
   * Get all comment messages for an issue, with reply-to resolution (quoted
   * message content + author embedded in the result).
   */
  getIssueMessages(this: MeshDbSelf, issueId: string): Array<{
    id: number;
    event_type: string;
    agent_name: string;
    content: string;
    created_at: string;
    metadata: string;
    reply_to_id: number | null;
    /** Resolved quoted message, present when reply_to_id is set */
    quoted?: { id: number; agent_name: string; content: string; created_at: string } | null;
  }> {
    const rows = this.db.prepare(`
      SELECT * FROM issue_events
      WHERE issue_id = ? AND event_type = 'comment'
      ORDER BY created_at ASC
    `).all(issueId) as IssueEventRow[];

    return rows.map((r) => {
      const msg: any = {
        id: r.id,
        event_type: r.event_type,
        agent_name: r.agent_name,
        content: r.content,
        created_at: r.created_at,
        metadata: r.metadata,
        reply_to_id: r.reply_to_id,
      };
      if (r.reply_to_id != null) {
        const quoted = this.db.prepare(
          "SELECT id, agent_name, content, created_at FROM issue_events WHERE id = ?",
        ).get(r.reply_to_id) as { id: number; agent_name: string; content: string; created_at: string } | undefined;
        msg.quoted = quoted ?? null;
      }
      return msg;
    });
  },

  // 拉取 issue 的事件流。
  //
  // 旧实现是 SELECT * ORDER BY created_at ASC LIMIT 200,在 issue 跑久了
  // events 累积超过 200 条时(典型如 worker 流式喷了大量 [status:thinking]
  // progress chunk)会把**最新**的事件截掉 —— 用户的追加指令(appended)
  // 即便已经入库、worker 已消费,也永远拉不回来,前端 reload 多少次都看不到。
  // 参见 issue 2284adfa 的复现。
  //
  // 现在:把事件拆成两类分别处理:
  //   - 非 progress(created/assigned/appended/approval_request/completed/failed/...)
  //     是用户关心的关键节点,**全部保留**,不受 limit 影响。
  //   - progress(worker 流式输出)条数最多,保留**最早 headKeep 条 + 最新
  //     tailKeep 条**,中间被省略的部分用 event_type='progress_truncated' 的
  //     虚拟事件标注,前端渲染成「已省略 N 条早期进展」chip。
  getIssueEvents(this: MeshDbSelf, issueId: string, headKeep = 5, tailKeep = 300): IssueEventRow[] {
    const nonProgress = this.db.prepare(
      "SELECT * FROM issue_events WHERE issue_id = ? AND event_type != 'progress' ORDER BY created_at ASC, id ASC",
    ).all(issueId) as IssueEventRow[];

    // 拉全部 progress 在 JS 层过滤纯 status-only 噪声。典型 /plan 任务里
    // 60% 的 progress chunk 是 [status:thinking]Working/Running/Done[/status:thinking]
    // 重复几百次 —— hoistStatus 只取 bucket 内最后一个 status 渲染 pill,
    // 中间的全是冗余。过滤掉它们让 head/tail 截断预算花在有意义的 exec/result/text
    // 上,大幅减少「已省略 N 条早期进展」的 N。保留最后一条 status-only
    // 事件,确保 hoistStatus 能取到最终状态(Done/Answered)而不是过时的 Running。
    const allProgress = this.db.prepare(
      "SELECT * FROM issue_events WHERE issue_id = ? AND event_type = 'progress' ORDER BY id ASC",
    ).all(issueId) as IssueEventRow[];

    const STATUS_OPEN = "[status:thinking]";
    const STATUS_CLOSE = "[/status:thinking]";
    const isStatusOnly = (c: string): boolean => {
      if (!c.startsWith(STATUS_OPEN)) return false;
      const closeIdx = c.indexOf(STATUS_CLOSE, STATUS_OPEN.length);
      if (closeIdx === -1) return false;
      return c.slice(closeIdx + STATUS_CLOSE.length).trim() === "";
    };

    let lastStatusId = -1;
    for (let i = allProgress.length - 1; i >= 0; i--) {
      if (isStatusOnly(allProgress[i].content || "")) {
        lastStatusId = allProgress[i].id;
        break;
      }
    }

    const filtered = allProgress.filter(ev =>
      !isStatusOnly(ev.content || "") || ev.id === lastStatusId,
    );

    const progressCount = filtered.length;

    // 过滤后的有意义事件数不超过 head+tail,直接全返回,不需要 marker。
    if (progressCount <= headKeep + tailKeep) {
      return mergeIssueEvents([...nonProgress, ...filtered]);
    }

    const head = filtered.slice(0, headKeep);
    const tail = filtered.slice(filtered.length - tailKeep);

    // 截断后 tail 的开头可能落在某条 [tool-result:exec] 上 —— 它配对的
    // [tool:exec] 在被丢掉的中间段,Dashboard 拿到这条孤儿 result 会渲染成
    // "(unknown)" 命令卡片(整段子代理输出挂在一条无名的命令下)。从 tail
    // 头部开始丢弃 result chunk,直到遇到第一条 [tool:exec](之后 tail 内部
    // FIFO 配对就能正常工作)。status-thinking / 纯文本等非 result chunk
    // 不影响配对,保留。被丢的 result 计入 omitted,marker 仍提示"已省略"。
    //
    // 用 startsWith 而不是 includes:executor 每条 progress chunk 都以单个
    // tag 开头([tool:exec] / [tool-result:exec] / [status:thinking] / 纯文本),
    // 起始位置 0 的 tag 一定是真 tag。而 includes 会被 result 内容里出现的
    // 字面量 "[tool:exec]"(比如 grep 命令把源码里的 tag 字符串匹配出来)
    // 误判成 exec chunk,导致孤儿 result 没被丢掉。
    let seenExec = false;
    const trimmedTail: IssueEventRow[] = [];
    for (const ev of tail) {
      const c = ev.content || "";
      if (!seenExec && c.startsWith("[tool:exec]")) seenExec = true;
      if (!seenExec && c.startsWith("[tool-result:exec]")) continue;
      trimmedTail.push(ev);
    }

    const omitted = progressCount - head.length - trimmedTail.length;

    // marker 插在 head 最后一条之后、tail 第一条之前。
    // created_at 取 head 末尾 +1ms,确保排序落在 head 和 tail 之间。
    const markerTime = head.length > 0
      ? shiftBeijing(head[head.length - 1].created_at, 1)
      : (trimmedTail[0]?.created_at ?? nowBeijing());

    const marker: IssueEventRow = {
      id: -1,
      issue_id: issueId,
      event_type: "progress_truncated",
      agent_name: "",
      content: "",
      metadata: JSON.stringify({ omitted }),
      created_at: markerTime,
      reply_to_id: null,
    };

    return mergeIssueEvents([...nonProgress, ...head, marker, ...trimmedTail]);
  },

  /** Get a single issue event by its ID. */
  getIssueEventById(this: MeshDbSelf, eventId: number): IssueEventRow | undefined {
    return this.db.prepare(
      "SELECT * FROM issue_events WHERE id = ?",
    ).get(eventId) as IssueEventRow | undefined;
  },

  /** Get all issue events for a group (across all issues in that group) */
  getIssueEventsByGroup(this: MeshDbSelf, groupId: string, limit = 500): IssueEventRow[] {
    return this.db.prepare(
      "SELECT ie.* FROM issue_events ie JOIN issues i ON ie.issue_id = i.id WHERE i.group_id = ? ORDER BY ie.created_at ASC LIMIT ?",
    ).all(groupId, limit) as IssueEventRow[];
  },

  /**
   * Approvals piggy-back on issue_events (event_type='approval_request') —
   * their lifecycle ("pending" → "accepted"/"denied") lives inside the JSON
   * metadata column. Finding one requires a scan + JSON parse since approvalId
   * isn't indexed; the per-issue event count is small (capped at ~200) so this
   * is fine in practice.
   */
  findApprovalEvent(this: MeshDbSelf, issueId: string, approvalId: string): IssueEventRow | undefined {
    const rows = this.db.prepare(
      "SELECT * FROM issue_events WHERE issue_id = ? AND event_type = 'approval_request' ORDER BY created_at DESC",
    ).all(issueId) as IssueEventRow[];
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata || "{}") as Record<string, unknown>;
        if (meta.approvalId === approvalId) return row;
      } catch { /* malformed metadata — skip */ }
    }
    return undefined;
  },

  /** Mark an approval event as resolved. Returns true if the row was updated.
   *  When `feedback` is provided and status is `denied`, it is persisted in
   *  metadata so the dashboard can render the rejection reason on the
   *  resolved card. */
  updateApprovalStatus(
    this: MeshDbSelf,
    eventId: number,
    status: "accepted" | "denied",
    resolvedBy: string,
    feedback?: string,
  ): boolean {
    const row = this.db.prepare("SELECT metadata FROM issue_events WHERE id = ?").get(eventId) as
      | { metadata: string }
      | undefined;
    if (!row) return false;
    const meta = safeJsonParse<Record<string, unknown>>(row.metadata, {});
    meta.status = status;
    meta.resolvedBy = resolvedBy;
    meta.resolvedAt = nowBeijing();
    if (status === "denied" && feedback) meta.feedback = feedback;
    const result = this.db.prepare(
      "UPDATE issue_events SET metadata = ? WHERE id = ?",
    ).run(JSON.stringify(meta), eventId);
    return result.changes > 0;
  },

  deleteIssue(this: MeshDbSelf, id: string): void {
    this.db.prepare("DELETE FROM issue_events WHERE issue_id = ?").run(id);
    this.db.prepare("DELETE FROM issues WHERE id = ?").run(id);
  },

  updateIssuePriority(this: MeshDbSelf, id: string, priority: string): void {
    const built = buildUpdate({
      table: "issues",
      sets: { priority },
      where: "id = ?",
      whereParams: [id],
      updatedAt: "beijing",
    });
    if (built) this.db.prepare(built.sql).run(...built.params);
  },

  // 同时支持 title / description 的部分更新。两个字段都不传时返回 false。
  // 标题在调用方已经做过非空校验，这里只负责落库。
  updateIssueContent(
    this: MeshDbSelf,
    id: string,
    fields: { title?: string; description?: string; slashCommand?: string | null; approvalPolicy?: "r_allow" | "rw_allow" },
  ): boolean {
    const built = buildUpdate({
      table: "issues",
      sets: {
        title: fields.title,
        description: fields.description,
        slash_command: fields.slashCommand,
        approval_policy: fields.approvalPolicy,
      },
      where: "id = ?",
      whereParams: [id],
      updatedAt: "beijing",
    });
    if (!built) return false;
    const result = this.db.prepare(built.sql).run(...(built.params as never[]));
    return result.changes > 0;
  },
};

/**
 * Sort events by created_at then id. Pulled out of getIssueEvents so the
 * head/tail/all paths can share the merge logic without a class-level helper.
 */
function mergeIssueEvents(rows: IssueEventRow[]): IssueEventRow[] {
  return rows.sort((a, b) => {
    const ta = Date.parse(a.created_at);
    const tb = Date.parse(b.created_at);
    if (ta !== tb) return ta - tb;
    return a.id - b.id;
  });
}
