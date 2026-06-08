/**
 * E2ED sync — Automatically advance requirement status based on issue outcomes.
 *
 * Called from MeshDb.updateIssueStatus() when an issue transitions to a
 * terminal state (completed / failed / cancelled) and belongs to an e2ed group.
 */

import type { MeshDb } from '../master/db.js';
import { RequirementStatus } from './types.js';
import { getRequirement, updateStatus, writeMeta, writeArtifactFile } from './requirement.js';

// Mapping: (issue.type, requirement.status) → new requirement status
const TRANSITIONS: Record<string, Record<string, string>> = {
  review: {
    [RequirementStatus.REQ_REVIEWING]: RequirementStatus.REQ_REVIEWED,
    [RequirementStatus.PLAN_REVIEWING]: RequirementStatus.PLAN_REVIEWED,
    [RequirementStatus.REVIEWING]: RequirementStatus.REVIEWED,
  },
  delivery: {
    [RequirementStatus.PLANNING]: RequirementStatus.DELIVERED,
    [RequirementStatus.DELIVERING]: RequirementStatus.DELIVERED,
  },
};

export function syncRequirementFromIssues(db: MeshDb, groupId: string): void {
  const meta = getRequirement(db, groupId);
  if (!meta) return;

  const currentStatus = meta.status;
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

    const transitionMap = TRANSITIONS[issue.type || ''];
    if (!transitionMap) continue;

    const nextStatus = transitionMap[currentStatus];
    if (!nextStatus) continue;

    const currentStatusEvent = [...meta.timeline].reverse().find(e => e.status === currentStatus);
    if (currentStatusEvent && new Date(issue.created_at) >= new Date(currentStatusEvent.at)) {
      updateStatus(db, groupId, nextStatus as any);
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
