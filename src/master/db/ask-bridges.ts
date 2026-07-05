/**
 * ask_bridges —— Agent A 提问 B 后的「等回复 + 超时兜底」bridge 记录。
 *
 * 生命周期:pending → answered(B @ A 被检测) / timed_out(5min 到点创建 Issue
 * 给 A) / cancelled(A 主动撤销)。
 *
 * scheduler 每 30s tick 扫 pending 行:先查 B 是否 @ 过 A(json_each 解析
 * mentions JSON 数组),命中则 answered;否则若 expires_at < now,查 B 是否有
 * 非 @ 回复,scheduler 据此创建复述 Issue 或升级 Issue,mark timed_out。
 *
 * 详细设计见 docs/AGENT_ASK_REPLY_TIMER.md 方案 C。
 */

import type { AskBridgeRow } from "./types.js";
import type { GroupMessageRow } from "./groups.js";
import type { MeshDbSelf } from "./core.js";

export const askBridgeMethods = {
  createAskBridge(this: MeshDbSelf, input: {
    id: string;
    groupId: string;
    asker: string;
    target: string;
    questionMsgId: number;
    escalateTo: string | null;
    timeoutMs: number;
    mode: "sync" | "async";
  }): AskBridgeRow {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO ask_bridges
        (id, group_id, asker, target, question_msg_id, escalate_to,
         timeout_ms, created_at, expires_at, status, mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      input.id,
      input.groupId,
      input.asker,
      input.target,
      input.questionMsgId,
      input.escalateTo,
      input.timeoutMs,
      now,
      now + input.timeoutMs,
      input.mode,
    );
    return this.db.prepare("SELECT * FROM ask_bridges WHERE id = ?")
      .get(input.id) as AskBridgeRow;
  },

  getAskBridge(this: MeshDbSelf, id: string): AskBridgeRow | undefined {
    return this.db.prepare("SELECT * FROM ask_bridges WHERE id = ?")
      .get(id) as AskBridgeRow | undefined;
  },

  listAskBridges(this: MeshDbSelf, filter?: {
    groupId?: string;
    asker?: string;
    status?: AskBridgeRow["status"];
  }): AskBridgeRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.groupId) { where.push("group_id = ?"); params.push(filter.groupId); }
    if (filter?.asker) { where.push("asker = ?"); params.push(filter.asker); }
    if (filter?.status) { where.push("status = ?"); params.push(filter.status); }
    const sql = `SELECT * FROM ask_bridges ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
    return this.db.prepare(sql).all(...params) as AskBridgeRow[];
  },

  /** scheduler tick 用:返回所有 pending bridge(不论是否到期,都要先查 @ 回复)。 */
  getPendingAskBridges(this: MeshDbSelf): AskBridgeRow[] {
    return this.db.prepare(
      "SELECT * FROM ask_bridges WHERE status = 'pending' ORDER BY expires_at ASC",
    ).all() as AskBridgeRow[];
  },

  /**
   * 查 B 是否在 question_msg_id 之后 @ 过 A。
   * mentions 是 JSON 数组字符串,用 json_each 精确匹配(避免子串误命中)。
   * 返回最早一条 @ 回复(scheduler 据此 mark answered)。
   */
  findAtReplyForBridge(this: MeshDbSelf, bridge: AskBridgeRow): GroupMessageRow | undefined {
    return this.db.prepare(`
      SELECT m.id, m.group_id, m.sender, m.content, m.mentions, m.created_at, m.cancelled_at
      FROM group_messages m, json_each(m.mentions)
      WHERE m.group_id = ?
        AND m.id > ?
        AND m.sender = ?
        AND json_each.value = ?
      ORDER BY m.id ASC
      LIMIT 1
    `).get(bridge.group_id, bridge.question_msg_id, bridge.target, bridge.asker) as GroupMessageRow | undefined;
  },

  /**
   * 查 B 在 question_msg_id 之后的最新一条非 @ 回复(超时复述用)。
   * 不过滤 mentions——@ 的也包含,因为 @ 的回复若 timer 还没 tick 到,A 的 worker
   * 已被 master 正常 dispatch 触发处理;若 timer tick 到了还没 mark answered,
   * 说明 @ 检测没命中(理论上不应发生,但兜底),仍取最新一条作复述。
   */
  findLatestReplyForBridge(this: MeshDbSelf, bridge: AskBridgeRow): GroupMessageRow | undefined {
    return this.db.prepare(`
      SELECT m.id, m.group_id, m.sender, m.content, m.mentions, m.created_at, m.cancelled_at
      FROM group_messages m
      WHERE m.group_id = ?
        AND m.id > ?
        AND m.sender = ?
        AND m.content != ''
        AND m.cancelled_at IS NULL
      ORDER BY m.id DESC
      LIMIT 1
    `).get(bridge.group_id, bridge.question_msg_id, bridge.target) as GroupMessageRow | undefined;
  },

  markBridgeAnswered(this: MeshDbSelf, id: string, replyMsgId: number): void {
    this.db.prepare(`
      UPDATE ask_bridges
      SET status = 'answered', reply_msg_id = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(replyMsgId, Date.now(), id);
  },

  markBridgeTimedOut(this: MeshDbSelf, id: string, issueId: string | null, replyMsgId: number | null): void {
    this.db.prepare(`
      UPDATE ask_bridges
      SET status = 'timed_out', issue_id = ?, reply_msg_id = ?, resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(issueId, replyMsgId, Date.now(), id);
  },

  cancelBridge(this: MeshDbSelf, id: string): boolean {
    const result = this.db.prepare(`
      UPDATE ask_bridges
      SET status = 'cancelled', resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(Date.now(), id);
    return result.changes > 0;
  },

  /** 取 group_messages.content;scheduler 创建超时 Issue 时复述原问题用。 */
  getGroupMessageContent(this: MeshDbSelf, msgId: number): string | undefined {
    const row = this.db.prepare("SELECT content FROM group_messages WHERE id = ?")
      .get(msgId) as { content: string } | undefined;
    return row?.content;
  },

  /**
   * 事件式检测:给定一条新群消息(sender, mentions),返回这条消息"答中"的 pending bridge。
   * 答中条件:bridge.target = sender AND bridge.asker ∈ mentions AND status=pending。
   * ws-hub 在 addGroupMessage 后调这个,命中即 markBridgeAnswered + disable 对应 schedule。
   * 返回 bridge 列表(理论上最多 1 条,因为同 target 同时只该有 1 个 pending;但
   * 万一有并发,全部返回让上层处理)。
   */
  findBridgesAnsweredByMessage(this: MeshDbSelf, groupId: string, sender: string, mentions: string[]): AskBridgeRow[] {
    if (mentions.length === 0) return [];
    // 用 json_each 反查不太合适(我们要的是 bridge.asker ∈ mentions,不是 mentions ∈ bridge)
    // 直接 SELECT pending bridges where target=sender,然后内存里过滤 asker ∈ mentions
    const placeholders = mentions.map(() => "?").join(",");
    return this.db.prepare(`
      SELECT * FROM ask_bridges
      WHERE group_id = ?
        AND target = ?
        AND status = 'pending'
        AND asker IN (${placeholders})
    `).all(groupId, sender, ...mentions) as AskBridgeRow[];
  },

  /**
   * 按 name 查 scheduled_tasks(legacy,仍保留给历史 task name 兜底)。
   * 新代码请用 findAskBridgeScheduledTask —— name 已改成"星期五 · …"友好文案,
   * 不再适合做 lookup key。
   */
  findScheduledTaskByName(this: MeshDbSelf, name: string): { id: number; enabled: number } | undefined {
    return this.db.prepare("SELECT id, enabled FROM scheduled_tasks WHERE name = ? ORDER BY id DESC LIMIT 1")
      .get(name) as { id: number; enabled: number } | undefined;
  },

  /**
   * 按 bridgeId 查对应的 ask-bridge scheduled_task(handler_key='ask-bridge-check'
   * 且 handler_payload 里含该 bridgeId)。name 改成"星期五 · 等待 X 回复"友好文案后,
   * 这是 cancel 路径的权威查找方式。bridgeId 是 UUID,LIKE 不会误匹配。
   */
  findAskBridgeScheduledTask(this: MeshDbSelf, bridgeId: string): { id: number; enabled: number } | undefined {
    return this.db.prepare(
      "SELECT id, enabled FROM scheduled_tasks WHERE handler_key = 'ask-bridge-check' AND handler_payload LIKE ? ORDER BY id DESC LIMIT 1",
    ).get(`%"bridgeId":"${bridgeId}"%`) as { id: number; enabled: number } | undefined;
  },

  /** 查是否有 pending bridge where asker+target 匹配(用于 autoCreate 防重 + 区分提问/回复)。 */
  findPendingBridge(this: MeshDbSelf, groupId: string, asker: string, target: string): AskBridgeRow | undefined {
    return this.db.prepare(
      "SELECT * FROM ask_bridges WHERE group_id = ? AND asker = ? AND target = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    ).get(groupId, asker, target) as AskBridgeRow | undefined;
  },
};
