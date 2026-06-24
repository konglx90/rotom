/**
 * Collaboration — multi-agent round-robin tracking on top of the issues table.
 *
 * Methods attach via `Object.assign`. Cross-module:
 *   - `addIssueEvent` (issues.ts) for collaboration lifecycle events
 *   - `getIssueById` (issues.ts) for round advancement
 *
 * Round state lives in two tables:
 *   - `issues` carries `current_round`, `participants`, `collaboration_goal`,
 *     `max_rounds`, `owner`, `summary`
 *   - `collaboration_round_tracker` records per-(issue, round, agent) whether
 *     that agent has contributed yet — drives `isRoundComplete`
 */

import type { IssueRow } from "./types.js";
import type { MeshDbSelf } from "./core.js";

export const collaborationMethods = {
  createCollaborationIssue(this: MeshDbSelf, data: {
    id: string; groupId: string; title: string; collaborationGoal: string;
    participants: string[]; maxRounds: number; owner: string; createdBy: string;
  }): void {
    this.db.prepare(`
      INSERT INTO issues (id, group_id, title, type, status, collaboration_goal,
        max_rounds, current_round, participants, owner, created_by, approval_policy)
      VALUES (?, ?, ?, 'collaboration', 'in_progress', ?, ?, 1, ?, ?, ?, 'rw_allow')
    `).run(
      data.id, data.groupId, data.title, data.collaborationGoal,
      data.maxRounds, JSON.stringify(data.participants),
      data.owner, data.createdBy,
    );
    // Initialize round tracker for round 1
    for (const agent of data.participants) {
      this.db.prepare(`
        INSERT INTO collaboration_round_tracker (issue_id, round, agent_name, has_contributed)
        VALUES (?, 1, ?, 0)
      `).run(data.id, agent);
    }
    this.addIssueEvent({
      issueId: data.id, eventType: "collaboration_started",
      agentName: data.createdBy,
      content: `Collaboration started: ${data.title}`,
      metadata: { goal: data.collaborationGoal, participants: data.participants, maxRounds: data.maxRounds, owner: data.owner },
    });
  },

  getActiveCollaborationsByGroup(this: MeshDbSelf, groupId: string): IssueRow[] {
    return this.db.prepare(
      "SELECT * FROM issues WHERE group_id = ? AND type = 'collaboration' AND status = 'in_progress'",
    ).all(groupId) as IssueRow[];
  },

  recordCollaborationTurn(this: MeshDbSelf, issueId: string, agentName: string, round: number, content?: string): void {
    this.db.prepare(`
      INSERT INTO collaboration_round_tracker (issue_id, round, agent_name, has_contributed)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(issue_id, round, agent_name) DO UPDATE SET has_contributed = 1
    `).run(issueId, round, agentName);
    this.addIssueEvent({
      issueId, eventType: "collaboration_turn", agentName,
      content: content || `${agentName} contributed in round ${round}`,
      metadata: { round },
    });
  },

  /**
   * Collect collaboration context for the next-speaker prompt:
   *  - lastRoundTurns: full content of every turn in (currentRound - 1)
   *  - earlierSpeakers: agent names that spoke in rounds before lastRound
   */
  buildCollaborationContext(this: MeshDbSelf, issueId: string, currentRound: number): {
    lastRoundTurns: { agentName: string; content: string }[];
    earlierSpeakers: string[];
  } {
    const events = this.db.prepare(
      "SELECT agent_name, content, metadata FROM issue_events WHERE issue_id = ? AND event_type = 'collaboration_turn' ORDER BY created_at ASC",
    ).all(issueId) as { agent_name: string; content: string; metadata: string }[];

    const lastRound = currentRound - 1;
    const lastRoundTurns: { agentName: string; content: string }[] = [];
    const earlier = new Set<string>();
    for (const ev of events) {
      let round = 0;
      try { round = (JSON.parse(ev.metadata || "{}").round as number) ?? 0; } catch { /* ignore */ }
      if (round === lastRound) {
        lastRoundTurns.push({ agentName: ev.agent_name, content: ev.content });
      } else if (round > 0 && round < lastRound) {
        earlier.add(ev.agent_name);
      }
    }
    return { lastRoundTurns, earlierSpeakers: Array.from(earlier) };
  },

  hasAgentContributedThisRound(this: MeshDbSelf, issueId: string, agentName: string, round: number): boolean {
    const row = this.db.prepare(
      "SELECT has_contributed FROM collaboration_round_tracker WHERE issue_id = ? AND round = ? AND agent_name = ?",
    ).get(issueId, round, agentName) as { has_contributed: number } | undefined;
    return row?.has_contributed === 1;
  },

  getRoundTracker(this: MeshDbSelf, issueId: string, round: number): { agent_name: string; has_contributed: number }[] {
    return this.db.prepare(
      "SELECT agent_name, has_contributed FROM collaboration_round_tracker WHERE issue_id = ? AND round = ?",
    ).all(issueId, round) as { agent_name: string; has_contributed: number }[];
  },

  isRoundComplete(this: MeshDbSelf, issueId: string, round: number): boolean {
    const rows = this.getRoundTracker(issueId, round);
    return rows.length > 0 && rows.every((r) => r.has_contributed === 1);
  },

  advanceCollaborationRound(this: MeshDbSelf, issueId: string, participants: string[]): void {
    const issue = this.getIssueById(issueId) as { current_round: number | null } | undefined;
    if (!issue) return;
    const nextRound = (issue.current_round ?? 0) + 1;
    this.db.prepare(
      "UPDATE issues SET current_round = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(nextRound, issueId);
    // Initialize tracker for the new round
    for (const agent of participants) {
      this.db.prepare(`
        INSERT INTO collaboration_round_tracker (issue_id, round, agent_name, has_contributed)
        VALUES (?, ?, ?, 0)
      `).run(issueId, nextRound, agent);
    }
    this.addIssueEvent({
      issueId, eventType: "collaboration_round_start", agentName: "system",
      content: `Round ${nextRound} started`,
      metadata: { round: nextRound },
    });
  },

  completeCollaboration(this: MeshDbSelf, issueId: string, summary: string): void {
    this.db.prepare(`
      UPDATE issues SET status = 'completed', summary = ?, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(summary, issueId);
    this.addIssueEvent({
      issueId, eventType: "collaboration_concluded", agentName: "system",
      content: `Collaboration concluded`,
      metadata: { summary },
    });
  },
};