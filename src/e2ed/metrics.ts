/**
 * E2ED — Metrics collection and computation.
 *
 * Computes pipeline metrics from issue events and requirement metadata.
 */

import type { MeshDb } from '../master/db.js';
import type { RequirementMeta, E2edMetrics, RoundMetrics } from './types.js';
import { getRequirement } from './requirement.js';

/** Compute aggregate metrics for a requirement */
export function computeMetrics(db: MeshDb, groupId: string): E2edMetrics | null {
  const meta = getRequirement(db, groupId);
  if (!meta) return null;

  const events = db.getIssueEventsByGroup(groupId);

  const planRounds: RoundMetrics[] = [];
  const codeRounds: RoundMetrics[] = [];

  for (const pv of meta.planVersions) {
    const delivery = findIssueDuration(events, 'plan-delivery', pv.version);
    const review = findIssueDuration(events, 'plan-review', pv.version);

    planRounds.push({
      version: pv.version,
      deliveryDuration: delivery,
      reviewDuration: review,
      result: pv.reviewStatus || 'needs-review',
    });
  }

  for (const cv of meta.codeVersions) {
    const delivery = findIssueDuration(events, 'code-delivery', cv.version);
    const review = findIssueDuration(events, 'code-review', cv.version);

    codeRounds.push({
      version: cv.version,
      deliveryDuration: delivery,
      reviewDuration: review,
      result: cv.reviewStatus || 'needs-review',
    });
  }

  // Total duration from first event to last
  const timestamps = events
    .map((e) => new Date(e.created_at).getTime())
    .filter((t) => !isNaN(t));
  const totalDuration = timestamps.length >= 2
    ? timestamps[timestamps.length - 1] - timestamps[0]
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

function findIssueDuration(
  events: Array<{ metadata: string; created_at: string; event_type: string }>,
  phase: string,
  version: number,
): number {
  let start: number | null = null;
  let end: number | null = null;

  for (const e of events) {
    let meta: any;
    try { meta = JSON.parse(e.metadata || '{}'); } catch { continue; }
    if (meta.phase !== phase || meta.version !== version) continue;

    const t = new Date(e.created_at).getTime();
    if (isNaN(t)) continue;

    if (e.event_type === 'created' || e.event_type === 'assigned') {
      start ??= t;
    }
    if (e.event_type === 'completed' || e.event_type === 'status_changed') {
      end = t;
    }
  }

  if (start && end) return end - start;
  return 0;
}
