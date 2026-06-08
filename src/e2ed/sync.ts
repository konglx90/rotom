/**
 * E2ED sync — Automatically advance requirement status based on issue outcomes.
 *
 * Called from MeshDb.updateIssueStatus() when an issue transitions to a
 * terminal state (completed / failed / cancelled) and belongs to an e2ed group.
 */

import type { MeshDb } from '../master/db.js';
import type { RequirementStatusType } from './types.js';
import { getRequirement, updateStatus, setActiveTask, writeMeta, writeArtifactFile } from './requirement.js';

// Mapping: activeTask → next status when the task completes
const TASK_COMPLETION: Record<string, RequirementStatusType> = {
  env_checking:    'ENV_READY',
  req_reviewing:   'REQ_REVIEWED',
  planning:        'DELIVERED',
  plan_reviewing:  'PLAN_REVIEWED',
  delivering:      'DELIVERED',
  code_reviewing:  'REVIEWED',
};

export function syncRequirementFromIssues(db: MeshDb, groupId: string): void {
  const meta = getRequirement(db, groupId);
  if (!meta) return;

  const allIssues = db.listIssuesByGroup(groupId);

  for (const issue of allIssues) {
    if (issue.status !== 'completed' && issue.status !== 'failed' && issue.status !== 'cancelled') continue;

    // Persist review report to artifact directory
    if (issue.type === 'review' && issue.result) {
      const reviewIndex = meta.runCount.reqReview; // latest review index
      writeArtifactFile(groupId, issue.result, 'req-reviews', `review-v${reviewIndex}`, 'report.md');
    }

    // Update reviewStatus on plan/code versions when a review issue completes
    if (issue.type === 'review' && (issue.status === 'completed')) {
      updateVersionReviewStatus(db, groupId, issue.title);
    }

    if (!meta.activeTask) continue;

    const nextStatus = TASK_COMPLETION[meta.activeTask];
    if (!nextStatus) continue;

    // Only advance if the issue was created after the last status change
    const lastEvent = [...meta.timeline].reverse()[0];
    if (lastEvent && new Date(issue.created_at) >= new Date(lastEvent.at)) {
      updateStatus(db, groupId, nextStatus);
      setActiveTask(db, groupId, null);
      return;
    }
  }
}

/** Parse issue title and update plan/code version reviewStatus to 'pass'. */
function updateVersionReviewStatus(db: MeshDb, groupId: string, title: string): void {
  const meta = getRequirement(db, groupId);
  if (!meta) return;

  let updated = false;

  // Match "Plan Review v3" or "Code Review v1" in title
  const planMatch = title.match(/Plan Review v(\d+)/);
  const codeMatch = title.match(/Code Review v(\d+)/);

  if (planMatch) {
    const version = parseInt(planMatch[1], 10);
    const pv = meta.planVersions.find((p: { version: number }) => p.version === version);
    if (pv && !pv.reviewStatus) {
      pv.reviewStatus = 'pass';
      updated = true;
    }
  }

  if (codeMatch) {
    const version = parseInt(codeMatch[1], 10);
    const cv = meta.codeVersions.find((c: { version: number }) => c.version === version);
    if (cv && !cv.reviewStatus) {
      cv.reviewStatus = 'pass';
      updated = true;
    }
  }

  if (updated) {
    writeMeta(db, groupId, meta);
  }
}
