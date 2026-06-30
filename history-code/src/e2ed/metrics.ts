/**
 * E2ED — Metrics collection and computation.
 *
 * Computes pipeline metrics from issue records and requirement metadata.
 */

import type { MeshDb } from '../master/db.js';
import type { RequirementMeta, E2edMetrics, RoundMetrics } from './types.js';
import { getRequirement } from './requirement.js';

/** Compute aggregate metrics for a requirement */
export function computeMetrics(db: MeshDb, groupId: string): E2edMetrics | null {
  const meta = getRequirement(db, groupId);
  if (!meta) return null;

  const issues = db.listIssuesByGroup(groupId);

  const planRounds: RoundMetrics[] = [];
  const codeRounds: RoundMetrics[] = [];

  for (const pv of meta.planVersions) {
    const delivery = findIssueDurationByTitle(issues, 'delivery', `Plan v${pv.version}`);
    const review = findIssueDurationByTitle(issues, 'review', `Plan Review v${pv.version}`);

    planRounds.push({
      version: pv.version,
      deliveryDuration: delivery,
      reviewDuration: review,
      result: pv.reviewStatus || 'needs-review',
    });
  }

  for (const cv of meta.codeVersions) {
    const delivery = findIssueDurationByTitle(issues, 'delivery', `Code v${cv.version}`);
    const review = findIssueDurationByTitle(issues, 'review', `Code Review v${cv.version}`);

    codeRounds.push({
      version: cv.version,
      deliveryDuration: delivery,
      reviewDuration: review,
      result: cv.reviewStatus || 'needs-review',
    });
  }

  // Total duration from earliest to latest issue creation
  const timestamps = issues
    .map((i) => new Date(i.created_at).getTime())
    .filter((t) => !isNaN(t));
  const totalDuration = timestamps.length >= 2
    ? Math.max(...timestamps) - Math.min(...timestamps)
    : 0;

  return { totalDuration, planRounds, codeRounds };
}

/** Get timeline events for a requirement */
export function getTimeline(db: MeshDb, groupId: string): Array<{
  eventType: string;
  agentName: string;
  content: string;
  createdAt: string;
}> {
  const events = db.getIssueEventsByGroup(groupId);
  return events.map((e) => ({
    eventType: e.event_type,
    agentName: e.agent_name,
    content: e.content,
    createdAt: e.created_at,
  }));
}

// ── Helpers ──────────────────────────────────────────────────────────────

function findIssueDurationByTitle(
  issues: Array<{ type: string; title: string; created_at: string; completed_at: string | null }>,
  type: string,
  titleFragment: string,
): number {
  const issue = issues.find(
    (i) => i.type === type && i.title.includes(titleFragment) && i.completed_at,
  );
  if (!issue) return 0;
  const start = new Date(issue.created_at).getTime();
  const end = new Date(issue.completed_at!).getTime();
  if (isNaN(start) || isNaN(end)) return 0;
  return end - start;
}
