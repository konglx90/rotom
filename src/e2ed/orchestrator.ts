/**
 * E2ED Orchestrator — Auto-pilot flow controller.
 *
 * After sync advances the requirement status, this module decides
 * the next step and triggers it automatically when autoPilot is enabled.
 *
 * Flow: env_check → req_review → plan_delivery → plan_review → code_delivery → code_review → done
 * On failure: retry up to maxRetries, then pause for human.
 */

import type { MeshDb } from '../master/db.js';
import { RequirementStatus } from './types.js';
import type { RequirementMeta, PauseReason } from './types.js';
import {
  getRequirement, pauseForHuman, appendDecisionContext,
} from './requirement.js';
import { startDeliver, startReview } from './pipeline.js';
import { isRetryable, defaultRetryConfig } from './retry.js';
import { extractVerdict } from './prompts.js';

/** Called from sync after a status transition. Triggers next step if autoPilot. */
export function orchestrateNextStep(db: MeshDb, groupId: string): void {
  const meta = getRequirement(db, groupId);
  if (!meta) return;

  // Only auto-proceed when autoPilot is enabled and no task is active
  if (!meta.autoPilot) return;
  if (meta.activeTask && meta.activeTask !== 'paused_for_human') return;

  const next = decideNextStep(meta);
  triggerStep(db, groupId, next);
}

/** Handle an issue failure — retry or pause for human. */
export function orchestrateFailure(
  db: MeshDb, groupId: string, errorMsg: string,
): void {
  const meta = getRequirement(db, groupId);
  if (!meta) return;

  if (!meta.autoPilot) return;

  // Check retry eligibility
  const retryState = meta.retryState ?? { attempt: 0, lastAttemptAt: '' };
  const config = defaultRetryConfig();

  if (isRetryable(errorMsg) && retryState.attempt < config.maxRetries) {
    // Will retry — the sync handler updates retryState and schedules it
    return;
  }

  // Max retries reached or non-retryable error
  pauseForHuman(db, groupId, 'max_retries_reached');
  console.log(`[orchestrator] Paused for human: max retries reached for ${groupId}`);
}

/**
 * Handle a review failure — extract verdict, store decision context,
 * decide whether to auto-fix or pause.
 */
export function orchestrateReviewFailure(
  db: MeshDb, groupId: string, reviewReport: string,
  phase: 'requirement-review' | 'plan-review' | 'code-review', version: number,
): void {
  const meta = getRequirement(db, groupId);
  if (!meta) return;

  // Extract verdict for decision context
  const verdict = extractVerdict(reviewReport);
  appendDecisionContext(db, groupId, {
    phase,
    version,
    at: new Date().toISOString(),
    decisions: verdict.suggestions,
    issues: verdict.issues,
  });

  if (!meta.autoPilot) return;

  // Requirement review failure — always pause (user needs to clarify)
  if (phase === 'requirement-review') {
    pauseForHuman(db, groupId, 'review_failed');
    console.log(`[orchestrator] Paused: requirement review failed for ${groupId}`);
    return;
  }

  // Plan/code review failure — auto-fix if retries remain
  const retryState = meta.retryState ?? { attempt: 0, lastAttemptAt: '' };
  const config = defaultRetryConfig();

  if (retryState.attempt < config.maxRetries) {
    // Trigger fix delivery
    console.log(`[orchestrator] Auto-fix attempt ${retryState.attempt + 1}/${config.maxRetries} for ${groupId}`);
    startDeliver(db, groupId, { fix: true, codeOnly: true });
  } else {
    pauseForHuman(db, groupId, 'review_failed');
    console.log(`[orchestrator] Paused: review still failing after ${config.maxRetries} fix attempts for ${groupId}`);
  }
}

// ── Internal ─────────────────────────────────────────────────────────────

type NextStep =
  | { action: 'env_check'; cwd: string }
  | { action: 'req_review' }
  | { action: 'plan_deliver' }
  | { action: 'plan_review' }
  | { action: 'code_deliver' }
  | { action: 'code_review' }
  | { action: 'done' }
  | { action: 'wait' };

function decideNextStep(meta: RequirementMeta): NextStep {
  // If paused, check if we can resume
  if (meta.activeTask === 'paused_for_human') {
    return { action: 'wait' };
  }

  switch (meta.status) {
    case RequirementStatus.ENV_READY:
      // Env checked, start requirement review
      return { action: 'req_review' };

    case RequirementStatus.REQ_REVIEWED:
      // Requirement reviewed, start plan delivery (plan-only)
      return { action: 'plan_deliver' };

    case RequirementStatus.DELIVERED: {
      // Need to determine: was this plan delivery or code delivery?
      // If latest plan has no review → plan was just delivered → plan review
      // If latest plan has review → code was just delivered → code review
      const latestPlan = meta.planVersions[meta.planVersions.length - 1];
      if (latestPlan && !latestPlan.reviewStatus) {
        return { action: 'plan_review' };
      }
      return { action: 'code_review' };
    }

    case RequirementStatus.PLAN_REVIEWED:
      // Plan reviewed, start code delivery
      return { action: 'code_deliver' };

    case RequirementStatus.REVIEWED:
      // All done!
      return { action: 'done' };

    case RequirementStatus.ENV_BLOCKED:
      // Needs human intervention
      return { action: 'wait' };

    default:
      return { action: 'wait' };
  }
}

function triggerStep(db: MeshDb, groupId: string, step: NextStep): void {
  switch (step.action) {
    case 'req_review':
      console.log(`[orchestrator] Auto-triggering: requirement review for ${groupId}`);
      startReview(db, groupId, { reviewType: 'requirement' });
      break;

    case 'plan_deliver':
      console.log(`[orchestrator] Auto-triggering: plan delivery for ${groupId}`);
      startDeliver(db, groupId, { planOnly: true });
      break;

    case 'plan_review':
      console.log(`[orchestrator] Auto-triggering: plan review for ${groupId}`);
      startReview(db, groupId, { reviewType: 'plan' });
      break;

    case 'code_deliver':
      console.log(`[orchestrator] Auto-triggering: code delivery for ${groupId}`);
      startDeliver(db, groupId, { codeOnly: true });
      break;

    case 'code_review':
      console.log(`[orchestrator] Auto-triggering: code review for ${groupId}`);
      startReview(db, groupId, { reviewType: 'code' });
      break;

    case 'done':
      console.log(`[orchestrator] Pipeline complete for ${groupId}`);
      break;

    case 'wait':
    case 'env_check':
      break;
  }
}
