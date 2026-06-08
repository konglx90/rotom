/**
 * E2ED sync — Automatically advance requirement status based on issue outcomes.
 *
 * Called from MeshDb.updateIssueStatus() when an issue transitions to a
 * terminal state (completed / failed / cancelled) and belongs to an e2ed group.
 */

import type { MeshDb } from '../master/db.js';
import type { RequirementStatusType } from './types.js';
import { getRequirement, updateStatus, setActiveTask, writeMeta, writeArtifactFile, appendDecisionContext } from './requirement.js';
import { orchestrateNextStep, orchestrateFailure, orchestrateReviewFailure } from './orchestrator.js';
import { extractVerdict } from './prompts.js';
import { isRetryable, retryDelay, defaultRetryConfig } from './retry.js';

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
    // Only process terminal states
    if (issue.status !== 'completed' && issue.status !== 'failed' && issue.status !== 'cancelled') continue;

    // ── Handle failures ──────────────────────────────────────────────────
    if (issue.status === 'failed') {
      handleFailure(db, groupId, meta, issue);
      return;
    }

    // ── Handle cancellations (treat as non-retryable failure) ────────────
    if (issue.status === 'cancelled') {
      if (meta.activeTask && meta.activeTask !== 'paused_for_human') {
        setActiveTask(db, groupId, null);
      }
      if (meta.autoPilot) {
        orchestrateFailure(db, groupId, 'cancelled');
      }
      return;
    }

    // ── Handle completed issues ──────────────────────────────────────────

    // Persist review report to artifact directory
    if (issue.type === 'review' && issue.result) {
      const reviewIndex = meta.runCount.reqReview;
      writeArtifactFile(groupId, issue.result, 'req-reviews', `review-v${reviewIndex}`, 'report.md');
    }

    // Update reviewStatus on plan/code versions when a review issue completes
    if (issue.type === 'review' && issue.status === 'completed') {
      updateVersionReviewStatus(db, groupId, issue.title, issue.result ?? undefined);
    }

    // Persist delivery reflection/artifacts as decision context
    if (issue.type === 'delivery' && issue.result) {
      const version = inferVersion(issue.title);
      if (version > 0) {
        appendDecisionContext(db, groupId, {
          phase: 'delivery',
          version,
          at: new Date().toISOString(),
          decisions: [],
          issues: [],
        });
      }
    }

    if (!meta.activeTask) continue;

    const nextStatus = TASK_COMPLETION[meta.activeTask];
    if (!nextStatus) continue;

    // Only advance if the issue was created after the last status change
    const lastEvent = [...meta.timeline].reverse()[0];
    if (lastEvent && new Date(issue.created_at) >= new Date(lastEvent.at)) {
      // Reset retry state on success
      if (meta.retryState) {
        meta.retryState = undefined;
        writeMeta(db, groupId, meta);
      }

      updateStatus(db, groupId, nextStatus);
      setActiveTask(db, groupId, null);

      // Auto-pilot: trigger next step
      orchestrateNextStep(db, groupId);
      return;
    }
  }
}

/** Handle a failed issue — retry if eligible, otherwise orchestrate failure. */
function handleFailure(
  db: MeshDb, groupId: string, meta: ReturnType<typeof getRequirement>,
  issue: any,
): void {
  if (!meta) return;

  const errorMsg = issue.error_message || issue.result || 'unknown error';

  // Store review failure as decision context
  if (issue.type === 'review') {
    const reviewPhase = inferReviewPhase(issue.title);
    const reviewVersion = inferVersion(issue.title);
    if (reviewPhase && reviewVersion > 0) {
      orchestrateReviewFailure(db, groupId, issue.result || '', reviewPhase, reviewVersion);
    }
    return;
  }

  // For delivery failures — check retry
  const retryState = meta.retryState ?? { attempt: 0, lastAttemptAt: '' };
  const config = defaultRetryConfig();

  if (meta.autoPilot && isRetryable(errorMsg) && retryState.attempt < config.maxRetries) {
    // Update retry state
    retryState.attempt++;
    retryState.lastAttemptAt = new Date().toISOString();
    retryState.lastError = errorMsg;
    retryState.issueId = issue.id;
    meta.retryState = retryState;
    writeMeta(db, groupId, meta);

    // Clear active task so orchestrator can re-trigger
    setActiveTask(db, groupId, null);

    const delay = retryDelay(retryState.attempt, config);
    console.log(`[sync] Scheduling retry ${retryState.attempt}/${config.maxRetries} in ${delay}ms for ${groupId}`);

    setTimeout(() => {
      orchestrateNextStep(db, groupId);
    }, delay);
    return;
  }

  // Non-retryable or max retries reached
  setActiveTask(db, groupId, null);
  if (meta.autoPilot) {
    orchestrateFailure(db, groupId, errorMsg);
  }
}

/** Parse issue title and update plan/code version reviewStatus. */
function updateVersionReviewStatus(db: MeshDb, groupId: string, title: string, result?: string): void {
  const meta = getRequirement(db, groupId);
  if (!meta) return;

  let updated = false;

  // Match "Plan Review v3" or "Code Review v1" in title
  const planMatch = title.match(/Plan Review v(\d+)/);
  const codeMatch = title.match(/Code Review v(\d+)/);

  // Determine review result from verdict or default to pass for completed reviews
  let reviewResult: 'pass' | 'fail' | 'needs-review' = 'pass';
  if (result) {
    const verdict = extractVerdict(result);
    reviewResult = verdict.status;
  }

  if (planMatch) {
    const version = parseInt(planMatch[1], 10);
    const pv = meta.planVersions.find((p: { version: number }) => p.version === version);
    if (pv && !pv.reviewStatus) {
      pv.reviewStatus = reviewResult;
      updated = true;
    }
  }

  if (codeMatch) {
    const version = parseInt(codeMatch[1], 10);
    const cv = meta.codeVersions.find((c: { version: number }) => c.version === version);
    if (cv && !cv.reviewStatus) {
      cv.reviewStatus = reviewResult;
      updated = true;
    }
  }

  if (updated) {
    writeMeta(db, groupId, meta);
  }
}

/** Parse review phase from issue title. */
function inferReviewPhase(title: string): 'requirement-review' | 'plan-review' | 'code-review' | null {
  if (/Req Review/i.test(title)) return 'requirement-review';
  if (/Plan Review/i.test(title)) return 'plan-review';
  if (/Code Review/i.test(title)) return 'code-review';
  return null;
}

/** Parse version number from issue title (e.g., "Plan Review v3" → 3). */
function inferVersion(title: string): number {
  const m = title.match(/v(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
