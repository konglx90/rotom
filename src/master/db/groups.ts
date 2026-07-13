import { nowBeijing, shiftBeijing } from "../../shared/time.js";
import { generateShortId } from "../../shared/short-id.js";
/**
 * Groups — group CRUD, member management, per-member working_dir overrides,
 * and the chat log (group_messages + composed_prompt snapshots).
 *
 * Methods attach to a `MeshDb` instance via `Object.assign`. The chat layer
 * (`getGroupMessages`) joins against `chat_message_prompts` for the dashboard
 * "分层组成" view — populated by worker when it runs prompt-composer.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { MeshDbSelf } from "./core.js";

export interface GroupRow {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  working_dir: string | null;
  pinned_at: string | null;
  archived_at: string | null;
  /** 重要少用群标记时间戳;NULL=普通活跃群。starred 群仍可读可写,仅用于侧栏分层展示。 */
  starred_at: string | null;
  type: string | null;
  metadata: string;
  /** 群级别指导 prompt,全群一份;NULL 或空串 = 未设置。 */
  guidance_prompt: string | null;
  /** 内置 repo:主仓库 URL。NULL = 该 group 走现状(无 repo / 无 worktree)。 */
  repo_url: string | null;
  /** 主仓库默认分支(如 main)。NULL 时 worktree 创建用仓库默认分支。 */
  repo_default_branch: string | null;
  /** 额外仓库配置 JSON 数组,形如 [{"id","url","branch","mountPath"}]。NULL = 无。 */
  extra_repos: string | null;
  /** worktree 模式(migration 052):'group'=群共享一个 worktree;'issue'=每 issue 独立。NULL='group'。 */
  worktree_mode: string | null;
  /** 群最近活动时间(毫秒时间戳);每次写消息/收回复更新。a2a_direct pair 群用做 3 天 TTL 续命。NULL=未跟踪(老群或非 pair 群)。 */
  last_activity_at: number | null;
}

export interface GroupMemberRow {
  agent_name: string;
  joined_at: string;
  working_dir: string | null;
  /** 群级别 profile 覆盖, JSON 字符串({position?,bio?,category?}), NULL = 不覆盖。 */
  profile: string | null;
}

/**
 * 群成员 + 其 agent 主键的 JOIN 行。供 ws-hub 广播用 —— 一次性拿到每个成员的
 * agent_id,避免 broadcastToGroup 里对每个成员再单独 getAgentByName(N+1)。
 *
 * 用 INNER JOIN agents:未注册 agent 的成员不会被返回 —— 与旧逻辑里
 * `getAgentByName` 返回 undefined 后 `continue` 跳过 等价。
 */
export interface GroupMemberWithAgentRow extends GroupMemberRow {
  /** agents.id。INNER JOIN 保证非空。 */
  agent_id: string;
}

/**
 * 群成员 + agent 在线状态 / 全局 profile 的 JOIN 行。供 dashboard 群详情成员
 * 列表用,替代「getGroupMembers 后逐个 getAgentByName」的 N+1。
 *
 * 注意 agent_profile 别名:agents.profile 与 GroupMemberRow.profile(群级覆盖)
 * 列名冲突,必须别名。LEFT JOIN + COALESCE(status,'offline') 保证未注册 agent
 * 的成员仍返回(状态 offline、agent_profile null),与原 api handler 的
 * `agent?.status ?? "offline"` / `agent?.profile ? ... : null` 完全等价。
 */
export interface GroupMemberWithAgentStateRow extends GroupMemberRow {
  /** agents.status,COALESCE 成 'offline'(成员无 agent 行时)。 */
  agent_status: string;
  /** agents.profile(全局 agent 档案 JSON),无 agent 行时为 null。 */
  agent_profile: string | null;
}

export interface GroupMessageRow {
  id: number;
  sender: string;
  content: string;
  mentions: string;
  created_at: string;
  cancelled_at: string | null;
  composed_prompt: {
    layers: { layer: string; content: string; source: string }[];
    final: string;
    generated_at: string;
    prompt_version: string;
  } | null;
  // 虚拟 marker 行:head 与 tail 之间被省略的中间段提示。
  // 后端按 issue_events.progress_truncated 同款套路合成,sender='__truncated'。
  truncated?: { omitted: number };
}

// 内部 helper:执行 SELECT 群消息 + LEFT JOIN chat_message_prompts,
// 拼装成 GroupMessageRow[](剥掉 layers/final/generated_at/prompt_version
// 四个字符串列,组装成 composed_prompt 对象)。whereClause 由调用方提供,
// 绑定参数顺序为 groupId,然后再是 LIMIT 值(如果有的话)。
//
// module-level 而非 groupMethods 上的方法,因为只有 getGroupMessages 在用,
// 放在 self 上反而需要扩展 MeshDbSelf interface。
function fetchGroupMessageRows(
  db: BetterSqlite3.Database,
  whereClause: string,
  groupId: string,
  ...bindParams: unknown[]
): GroupMessageRow[] {
  const sql = `SELECT m.id, m.sender, m.content, m.mentions, m.created_at, m.cancelled_at,
                 p.layers, p.final, p.generated_at, p.prompt_version
          FROM group_messages m
          LEFT JOIN chat_message_prompts p ON p.group_message_id = m.id
          ${whereClause}`;
  const rows = db.prepare(sql).all(groupId, ...bindParams) as Array<{
      id: number; sender: string; content: string; mentions: string; created_at: string;
      cancelled_at: string | null;
      layers: string | null; final: string | null; generated_at: string | null; prompt_version: string | null;
    }>;
  return rows.map((r) => {
    let composed_prompt: {
      layers: { layer: string; content: string; source: string }[];
      final: string; generated_at: string; prompt_version: string;
    } | null = null;
    if (r.layers && r.final && r.generated_at && r.prompt_version) {
      composed_prompt = {
        layers: JSON.parse(r.layers),
        final: r.final,
        generated_at: r.generated_at,
        prompt_version: r.prompt_version,
      };
    }
    return {
      id: r.id, sender: r.sender, content: r.content, mentions: r.mentions, created_at: r.created_at,
      cancelled_at: r.cancelled_at,
      composed_prompt,
    };
  });
}

export const groupMethods = {
  createGroup(this: MeshDbSelf, id: string, name: string, createdBy?: string, workingDir?: string): void {
    this.db.prepare(
      "INSERT INTO groups (id, name, created_by, working_dir) VALUES (?, ?, ?, ?)",
    ).run(id, name, createdBy || null, workingDir || null);
  },

  updateGroupWorkingDir(this: MeshDbSelf, id: string, workingDir: string | null): void {
    this.db.prepare("UPDATE groups SET working_dir = ? WHERE id = ?")
      .run(workingDir, id);
  },

  updateGroupName(this: MeshDbSelf, id: string, name: string): void {
    this.db.prepare("UPDATE groups SET name = ? WHERE id = ?")
      .run(name, id);
  },

  /**
   * Toggle (or set explicitly) the per-group pinned_at timestamp.
   * Passing `null` unpins; passing a value pins to "now" (UTC string).
   */
  updateGroupPinned(this: MeshDbSelf, id: string, pinned: boolean): string | null {
    const next = pinned ? nowBeijing() : null;
    this.db.prepare("UPDATE groups SET pinned_at = ? WHERE id = ?")
      .run(next, id);
    return next;
  },

  /**
   * Archive or unarchive a group. Archived groups are read-only: no new messages,
   * issues. Passing `true` sets archived_at to "now";
   * passing `false` clears it.
   */
  updateGroupArchived(this: MeshDbSelf, id: string, archived: boolean): string | null {
    const next = archived ? nowBeijing() : null;
    this.db.prepare("UPDATE groups SET archived_at = ? WHERE id = ?")
      .run(next, id);
    return next;
  },

  /**
   * Returns the archived_at value of a group, or null if not archived.
   */
  isGroupArchived(this: MeshDbSelf, id: string): string | null {
    const row = this.db.prepare("SELECT archived_at FROM groups WHERE id = ?").get(id) as { archived_at: string | null } | undefined;
    return row?.archived_at ?? null;
  },

  /**
   * Toggle (or set explicitly) the per-group starred_at timestamp.
   * Starred groups are "重要少用":可读可写,只是侧栏分层展示。
   * Passing `null` unstars; passing a value stars to "now" (北京时间字符串)。
   */
  updateGroupStarred(this: MeshDbSelf, id: string, starred: boolean): string | null {
    const next = starred ? nowBeijing() : null;
    this.db.prepare("UPDATE groups SET starred_at = ? WHERE id = ?")
      .run(next, id);
    return next;
  },

  /**
   * Returns the starred_at value of a group, or null if not starred.
   */
  isGroupStarred(this: MeshDbSelf, id: string): string | null {
    const row = this.db.prepare("SELECT starred_at FROM groups WHERE id = ?").get(id) as { starred_at: string | null } | undefined;
    return row?.starred_at ?? null;
  },

  /**
   * Backfill working_dir on legacy groups (NULL or empty). Caller supplies the
   * `compute` fn — kept out of db.ts so this module stays free of filesystem
   * conventions (homedir, ARTIFACTS_ROOT, etc.). Returns the list of (id, path)
   * pairs that were written, so the caller can mkdir each one.
   */
  backfillGroupDefaultWorkingDir(
    this: MeshDbSelf,
    compute: (id: string) => string,
  ): { id: string; workingDir: string }[] {
    const rows = this.db.prepare(
      "SELECT id FROM groups WHERE working_dir IS NULL OR working_dir = ''",
    ).all() as { id: string }[];
    if (rows.length === 0) return [];
    const update = this.db.prepare("UPDATE groups SET working_dir = ? WHERE id = ?");
    const filled: { id: string; workingDir: string }[] = [];
    const tx = this.db.transaction((items: { id: string }[]) => {
      for (const { id } of items) {
        const wd = compute(id);
        update.run(wd, id);
        filled.push({ id, workingDir: wd });
      }
    });
    tx(rows);
    return filled;
  },

  listGroups(this: MeshDbSelf): (GroupRow & { member_count: number; last_message_at: string | null })[] {
    return this.db.prepare(`
      SELECT g.*, COUNT(gm.agent_name) as member_count,
             (SELECT MAX(m.created_at) FROM group_messages m WHERE m.group_id = g.id) AS last_message_at
      FROM groups g
      LEFT JOIN group_members gm ON g.id = gm.group_id
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `).all() as (GroupRow & { member_count: number; last_message_at: string | null })[];
  },

  listGroupsWithMembers(this: MeshDbSelf): (GroupRow & { member_count: number; last_message_at: string | null; members: GroupMemberRow[] })[] {
    const groups = this.listGroups();
    const rows = this.db.prepare(`
      SELECT gm.group_id, gm.agent_name, gm.joined_at, gms.working_dir, gms.profile
      FROM group_members gm
      LEFT JOIN group_member_settings gms
        ON gms.group_id = gm.group_id AND gms.agent_name = gm.agent_name
      ORDER BY gm.joined_at
    `).all() as { group_id: string; agent_name: string; joined_at: string; working_dir: string | null; profile: string | null }[];
    const byGroup = new Map<string, GroupMemberRow[]>();
    for (const r of rows) {
      let list = byGroup.get(r.group_id);
      if (!list) {
        list = [];
        byGroup.set(r.group_id, list);
      }
      list.push({ agent_name: r.agent_name, joined_at: r.joined_at, working_dir: r.working_dir, profile: r.profile });
    }
    return groups.map((g) => ({ ...g, members: byGroup.get(g.id) ?? [] } as GroupRow & { member_count: number; last_message_at: string | null; members: GroupMemberRow[] }));
  },

  getGroupById(this: MeshDbSelf, id: string): GroupRow | undefined {
    return this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
  },

  deleteGroup(this: MeshDbSelf, id: string): void {
    this.db.prepare("DELETE FROM group_messages WHERE group_id = ?").run(id);
    this.db.prepare("DELETE FROM group_member_settings WHERE group_id = ?").run(id);
    this.db.prepare("DELETE FROM group_members WHERE group_id = ?").run(id);
    this.db.prepare("DELETE FROM groups WHERE id = ?").run(id);
  },

  /** Create group with type and metadata (for e2ed integration) */
  createGroupTyped(this: MeshDbSelf, opts: {
    id: string;
    name: string;
    type: string;
    createdBy?: string;
    workingDir?: string | null;
    metadata?: string;
  }): void {
    this.db.prepare(
      "INSERT INTO groups (id, name, created_by, working_dir, type, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(opts.id, opts.name, opts.createdBy || null, opts.workingDir || null, opts.type, opts.metadata || '{}');
  },

  /** Get group by id including type and metadata columns */
  getGroupByIdFull(this: MeshDbSelf, id: string): GroupRow | undefined {
    return this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
  },

  /** List groups filtered by type */
  listGroupsByType(this: MeshDbSelf, type: string): GroupRow[] {
    return this.db.prepare(
      "SELECT id, name, created_by, created_at, working_dir, type, metadata FROM groups WHERE type = ? ORDER BY created_at DESC",
    ).all(type) as GroupRow[];
  },

  /** Update group metadata JSON */
  updateGroupMetadata(this: MeshDbSelf, id: string, metadata: string): void {
    this.db.prepare("UPDATE groups SET metadata = ? WHERE id = ?").run(metadata, id);
  },

  /** 群级别指导 prompt;传 null/空串清空。 */
  updateGroupGuidancePrompt(this: MeshDbSelf, id: string, prompt: string | null): void {
    const v = prompt && prompt.trim() ? prompt : null;
    this.db.prepare("UPDATE groups SET guidance_prompt = ? WHERE id = ?").run(v, id);
  },

  /**
   * 更新群的内置 repo 配置(migration 051)。
   *
   * - repoUrl 为空串/null:清空 repo_url,该 group 回退现状(无 worktree)
   * - extraReposJson 为空串/null:清空 extra_repos
   * - 三列独立更新,避免一次只想改 defaultBranch 时把 url 也清掉
   */
  updateGroupRepo(
    this: MeshDbSelf,
    id: string,
    repoUrl: string | null,
    repoDefaultBranch: string | null,
    extraReposJson: string | null,
    worktreeMode: string | null,
  ): void {
    const mode = worktreeMode === "issue" ? "issue" : "group";
    this.db.prepare(
      "UPDATE groups SET repo_url = ?, repo_default_branch = ?, extra_repos = ?, worktree_mode = ? WHERE id = ?",
    ).run(repoUrl || null, repoDefaultBranch || null, extraReposJson || null, mode, id);
  },

  addGroupMembers(this: MeshDbSelf, groupId: string, agentNames: string[]): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO group_members (group_id, agent_name) VALUES (?, ?)",
    );
    for (const name of agentNames) {
      stmt.run(groupId, name);
    }
  },

  removeGroupMembers(this: MeshDbSelf, groupId: string, agentNames: string[]): void {
    const tx = this.db.transaction((names: string[]) => {
      const m = this.db.prepare("DELETE FROM group_members WHERE group_id = ? AND agent_name = ?");
      const s = this.db.prepare("DELETE FROM group_member_settings WHERE group_id = ? AND agent_name = ?");
      for (const name of names) {
        m.run(groupId, name);
        s.run(groupId, name);
      }
    });
    tx(agentNames);
  },

  getGroupMembers(this: MeshDbSelf, groupId: string): GroupMemberRow[] {
    return this.db.prepare(`
      SELECT gm.agent_name, gm.joined_at, gms.working_dir, gms.profile
      FROM group_members gm
      LEFT JOIN group_member_settings gms
        ON gms.group_id = gm.group_id AND gms.agent_name = gm.agent_name
      WHERE gm.group_id = ?
      ORDER BY gm.joined_at
    `).all(groupId) as GroupMemberRow[];
  },

  /**
   * 群成员 + agent 主键,一次 JOIN 返回。供 ws-hub 广播路径用,替代
   * 「getGroupMembers 后逐个 getAgentByName」的 N+1 写法。
   *
   * 行为与 getGroupMembers + 逐个 getAgentByName 等价:
   *  - 仍 LEFT JOIN group_member_settings 拿 working_dir / profile;
   *  - INNER JOIN agents,故未注册 agent 的成员被排除(等价于旧逻辑的 continue);
   *  - 按 gm.joined_at 排序,与 getGroupMembers 一致。
   */
  getGroupMembersWithAgents(this: MeshDbSelf, groupId: string): GroupMemberWithAgentRow[] {
    return this.db.prepare(`
      SELECT gm.agent_name, gm.joined_at, gms.working_dir, gms.profile, a.id AS agent_id
      FROM group_members gm
      JOIN agents a ON a.name = gm.agent_name
      LEFT JOIN group_member_settings gms
        ON gms.group_id = gm.group_id AND gms.agent_name = gm.agent_name
      WHERE gm.group_id = ?
      ORDER BY gm.joined_at
    `).all(groupId) as GroupMemberWithAgentRow[];
  },

  /**
   * 群成员 + agent 在线状态 + 全局 profile,一次 JOIN 返回。供 dashboard 群详情
   * GET /groups/:id 成员列表用,替代「getGroupMembers 后逐个 getAgentByName」的 N+1。
   *
   * LEFT JOIN agents + COALESCE(status,'offline'):未注册 agent 的成员仍返回
   * (status=offline、agent_profile=null),等价于原 handler 的
   * `agent?.status ?? "offline"` / `agent?.profile ? parseAgentProfile : null`。
   */
  getGroupMembersWithAgentState(this: MeshDbSelf, groupId: string): GroupMemberWithAgentStateRow[] {
    return this.db.prepare(`
      SELECT gm.agent_name, gm.joined_at, gms.working_dir, gms.profile,
             COALESCE(a.status, 'offline') AS agent_status,
             a.profile AS agent_profile
      FROM group_members gm
      LEFT JOIN agents a ON a.name = gm.agent_name
      LEFT JOIN group_member_settings gms
        ON gms.group_id = gm.group_id AND gms.agent_name = gm.agent_name
      WHERE gm.group_id = ?
      ORDER BY gm.joined_at
    `).all(groupId) as GroupMemberWithAgentStateRow[];
  },

  getGroupMemberSetting(this: MeshDbSelf, groupId: string, agentName: string): string | null {
    const row = this.db.prepare(
      "SELECT working_dir FROM group_member_settings WHERE group_id = ? AND agent_name = ?",
    ).get(groupId, agentName) as { working_dir: string } | undefined;
    // working_dir 列是 NOT NULL(migration 020);空串表示"只设了 profile,没有
    // working_dir 覆盖",归一化为 null 让上层 falsy 判断正常工作。
    const v = row?.working_dir;
    return v && v.length > 0 ? v : null;
  },

  listGroupMemberSettings(this: MeshDbSelf, groupId: string): { agent_name: string; working_dir: string; updated_at: string; profile: string | null }[] {
    return this.db.prepare(
      "SELECT agent_name, working_dir, updated_at, profile FROM group_member_settings WHERE group_id = ? ORDER BY agent_name",
    ).all(groupId) as { agent_name: string; working_dir: string; updated_at: string; profile: string | null }[];
  },

  getGroupMemberProfile(this: MeshDbSelf, groupId: string, agentName: string): string | null {
    const row = this.db.prepare(
      "SELECT profile FROM group_member_settings WHERE group_id = ? AND agent_name = ?",
    ).get(groupId, agentName) as { profile: string | null } | undefined;
    return row?.profile ?? null;
  },

  upsertGroupMemberProfile(this: MeshDbSelf, groupId: string, agentName: string, profileJson: string | null): void {
    // 群级别 profile 覆盖单独存一列。若该 (group, agent) 还没有 settings 行,
    // INSERT 一行 working_dir=''(NOT NULL 兜底,getGroupMemberSetting 归一化为
    // null 表示无覆盖)再写 profile; 若已有行, UPDATE profile 列(不动 working_dir)。
    this.db.prepare(`
      INSERT INTO group_member_settings (group_id, agent_name, working_dir, profile, updated_at)
      VALUES (?, ?, '', ?, ?)
      ON CONFLICT(group_id, agent_name) DO UPDATE SET
        profile     = excluded.profile,
        updated_at  = excluded.updated_at
    `).run(groupId, agentName, profileJson, nowBeijing());
  },

  upsertGroupMemberSetting(this: MeshDbSelf, groupId: string, agentName: string, workingDir: string): void {
    this.db.prepare(`
      INSERT INTO group_member_settings (group_id, agent_name, working_dir, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, agent_name) DO UPDATE SET
        working_dir = excluded.working_dir,
        updated_at  = excluded.updated_at
    `).run(groupId, agentName, workingDir, nowBeijing());
  },

  clearGroupMemberSetting(this: MeshDbSelf, groupId: string, agentName: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM group_member_settings WHERE group_id = ? AND agent_name = ?",
    ).run(groupId, agentName);
    return result.changes > 0;
  },

  addGroupMessage(
    this: MeshDbSelf,
    groupId: string,
    sender: string,
    content: string,
    mentions: string[] = [],
    options?: { cancelledAt?: string },
  ): number {
    const result = this.db.prepare(
      "INSERT INTO group_messages (group_id, sender, content, mentions, cancelled_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      groupId,
      sender,
      content,
      JSON.stringify(mentions),
      options?.cancelledAt ?? null,
    );
    return Number(result.lastInsertRowid);
  },

  /**
   * 把 worker 算出的 ComposedPrompt 持久化到 chat_message_prompts,keyed by
   * group_messages.id。Dashboard 点击消息时读这张表渲染分层组成。
   */
  addChatMessagePrompt(
    this: MeshDbSelf,
    groupMessageId: number,
    layersJson: string,
    final: string,
    generatedAt: string,
    promptVersion: string,
  ): void {
    this.db.prepare(
      `INSERT INTO chat_message_prompts (group_message_id, layers, final, generated_at, prompt_version)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(groupMessageId, layersJson, final, generatedAt, promptVersion);
  },

  getChatMessagePrompt(this: MeshDbSelf, groupMessageId: number): {
    layers: { layer: string; content: string; source: string }[];
    final: string;
    generated_at: string;
    prompt_version: string;
  } | null {
    const row = this.db.prepare(
      `SELECT layers, final, generated_at, prompt_version
       FROM chat_message_prompts WHERE group_message_id = ?`,
    ).get(groupMessageId) as { layers: string; final: string; generated_at: string; prompt_version: string } | undefined;
    if (!row) return null;
    return {
      layers: JSON.parse(row.layers),
      final: row.final,
      generated_at: row.generated_at,
      prompt_version: row.prompt_version,
    };
  },

  // 内部 helper:执行 SELECT 群消息 + LEFT JOIN chat_message_prompts,
  // 拼装成 GroupMessageRow[](剥掉 layers/final/generated_at/prompt_version
  // 四个字符串列,组装成 composed_prompt 对象)。whereClause 由调用方提供,
  // 绑定参数顺序为 groupId,然后再是 LIMIT 值(如果有的话)。
  // 拉取群消息。和 getIssueEvents 同款 head+tail+marker 思路:
  //   - 总数 <= headKeep+tailKeep:全拿(ASC)。
  //   - 总数超过:head(最早 headKeep 条) + tail(最新 tailKeep 条) + 中间合成一条
  //     truncated marker,sender='__truncated',前端渲染成「已省略 N 条」chip。
  // 旧实现 ORDER BY created_at ASC LIMIT N 会把最新消息截掉,群里消息累积
  // 超过 N 条后新消息永远拉不到——参见群 f080e51e 的复现。
  getGroupMessages(this: MeshDbSelf, groupId: string, headKeep = 5, tailKeep = 295): GroupMessageRow[] {
    const totalCount = this.db.prepare(
      "SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ?",
    ).get(groupId) as { c: number };

    const total = totalCount.c;
    if (total <= headKeep + tailKeep) {
      return fetchGroupMessageRows(
        this.db,
        `WHERE m.group_id = ? ORDER BY m.created_at ASC, m.id ASC`,
        groupId,
      );
    }

    const head = fetchGroupMessageRows(
      this.db,
      `WHERE m.group_id = ? ORDER BY m.created_at ASC, m.id ASC LIMIT ?`,
      groupId,
      headKeep,
    );
    const tail = fetchGroupMessageRows(
      this.db,
      `WHERE m.group_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
      groupId,
      tailKeep,
    );
    tail.reverse();

    const omitted = total - head.length - tail.length;
    // marker 的 created_at 取 head 末尾 +1ms,落在 head 和 tail 之间,
    // 前端按 timestamp 排序时位置正确。
    const markerTime = head.length > 0
      ? shiftBeijing(head[head.length - 1].created_at, 1)
      : (tail[0]?.created_at ?? nowBeijing());
    const marker: GroupMessageRow = {
      id: -1,
      sender: "__truncated",
      content: "",
      mentions: "[]",
      created_at: markerTime,
      cancelled_at: null,
      composed_prompt: null,
      truncated: { omitted },
    };

    return [...head, marker, ...tail];
  },

  /** 按 (groupId, msgId) 取单条群消息完整 row(含 composed_prompt)。
   *  CLI `rotom group message <groupId> <msgId>` 回查被截断的历史用。 */
  getGroupMessageById(this: MeshDbSelf, groupId: string, msgId: number): GroupMessageRow | undefined {
    return fetchGroupMessageRows(
      this.db,
      "WHERE m.group_id = ? AND m.id = ? LIMIT 1",
      groupId,
      msgId,
    )[0];
  },

  /** 按 since 时间过滤群消息(UTC ISO 或北京时间字符串都行,字符串字典序比较)。
   *  不走 head/tail 截断——轮询用,只看新增量。返回 ASC 排序。 */
  getGroupMessagesSince(this: MeshDbSelf, groupId: string, sinceIso: string): GroupMessageRow[] {
    return fetchGroupMessageRows(
      this.db,
      `WHERE m.group_id = ? AND m.created_at > ? ORDER BY m.created_at ASC, m.id ASC`,
      groupId,
      sinceIso,
    );
  },

  /** 按 (asker, target) 找活跃 a2a_direct pair 群(3 天内有活动,未归档)。
   *  用于 `rotom ask` 自动复用对话上下文容器。成员顺序双向匹配——
   *  (A,B) 与 (B,A) 视为同一个 pair 群(由 asker → target 触发,但群本身
   *  无方向性)。返回 last_activity_at DESC 排序的第一条。 */
  findActivePairGroup(this: MeshDbSelf, asker: string, target: string): GroupRow | undefined {
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    return this.db.prepare(`
      SELECT g.*
      FROM groups g
      WHERE g.type = 'a2a_direct'
        AND g.archived_at IS NULL
        AND (g.last_activity_at IS NOT NULL AND g.last_activity_at > ?)
        AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.agent_name = ?)
        AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = g.id AND gm.agent_name = ?)
      ORDER BY g.last_activity_at DESC
      LIMIT 1
    `).get(cutoff, asker, target) as GroupRow | undefined;
  },

  /** 建 a2a_direct pair 群(2 成员)。复用 createGroupTyped + addGroupMembers。
   *  群名形如 "A↔B",由 asker 与 target 名拼接而成。 */
  createPairGroup(this: MeshDbSelf, asker: string, target: string): GroupRow {
    const id = generateShortId();
    const name = `${asker}↔${target}`;
    this.db.prepare(
      "INSERT INTO groups (id, name, created_by, type, metadata, last_activity_at) VALUES (?, ?, ?, 'a2a_direct', '{}', ?)",
    ).run(id, name, asker, Date.now());
    this.db.prepare(
      "INSERT INTO group_members (group_id, agent_name) VALUES (?, ?), (?, ?)",
    ).run(id, asker, id, target);
    return this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow;
  },

  /** 更新群最近活动时间(毫秒时间戳)。每次写群消息(asker 提问 / target 回复)调一次。
   *  用于 a2a_direct pair 群的 3 天 TTL 续命。普通群(chat)也可调,但 TTL sweep 只扫 a2a_direct。 */
  bumpGroupActivity(this: MeshDbSelf, groupId: string): void {
    this.db.prepare("UPDATE groups SET last_activity_at = ? WHERE id = ?")
      .run(Date.now(), groupId);
  },

  /** 列出 last_activity_at 早于 cutoff 的未归档 a2a_direct 群。TTL sweep 用。 */
  listStalePairGroups(this: MeshDbSelf, cutoff: number): GroupRow[] {
    return this.db.prepare(`
      SELECT * FROM groups
      WHERE type = 'a2a_direct'
        AND archived_at IS NULL
        AND last_activity_at IS NOT NULL
        AND last_activity_at < ?
      ORDER BY last_activity_at ASC
    `).all(cutoff) as GroupRow[];
  },

  /** 归档群(archived_at 设为当前北京时间字符串)。TTL sweep 用。 */
  archiveGroup(this: MeshDbSelf, groupId: string): void {
    this.db.prepare("UPDATE groups SET archived_at = ? WHERE id = ?")
      .run(nowBeijing(), groupId);
  },
};
