/**
 * E2ED — Pipeline orchestration.
 *
 * Creates issues in Rotom's system for each agent session.
 * Rotom executor picks up issues and spawns Claude/Codex workers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { MeshDb } from '../master/db.js';
import type { RequirementMeta } from './types.js';
import { RequirementStatus } from './types.js';
import {
  getRequirement, updateStatus, getRequirementText,
  createPlanVersion, getLatestPlanVersion, updatePlanVersionStatus,
  createCodeVersion, getLatestCodeVersion, updateCodeVersionStatus,
  createReqReview, readArtifactFile, writeArtifactFile,
  getWorkingDir, writeMeta,
} from './requirement.js';
import {
  buildDeliveryPrompt,
  buildRequirementReviewPrompt,
  buildPlanReviewPrompt,
  buildCodeReviewPrompt,
  REFLECTION_TEMPLATE,
} from './prompts.js';

interface PipelineOpts {
  cwd?: string;
  fix?: boolean;
  planOnly?: boolean;
  codeOnly?: boolean;
  reviewType?: 'requirement' | 'plan' | 'code';
}

function makeIssueId(): string {
  return randomUUID();
}

function readGitBranch(cwd: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return null; }
}

function recordLink(db: MeshDb, groupId: string, link: { type: string; url: string; branch?: string }): void {
  const meta = getRequirement(db, groupId);
  if (!meta) return;
  const exists = meta.links.some(l => l.type === link.type && l.branch === link.branch && l.url === link.url);
  if (!exists) {
    meta.links.push(link);
    writeMeta(db, groupId, meta);
  }
}

// ── Deliver ──────────────────────────────────────────────────────────────

export function startDeliver(db: MeshDb, groupId: string, opts: PipelineOpts = {}): void {
  const meta = getRequirement(db, groupId);
  if (!meta) throw new Error(`Requirement ${groupId} not found`);

  const cwd = opts.cwd || getWorkingDir(db, groupId);
  const requirement = getRequirementText(groupId) || '';
  const isFix = !!opts.fix;
  const isPlanOnly = !!opts.planOnly;
  const isCodeOnly = !!opts.codeOnly;

  // Record git branch as a link
  const branch = readGitBranch(cwd);
  if (branch) recordLink(db, groupId, { type: 'git-branch', url: '', branch });

  // Phase 1: Plan generation
  if (!isCodeOnly) {
    const { version, dirName, planDir } = createPlanVersion(db, groupId);
    const planPath = path.join(planDir, 'plan.md');

    const prompt = buildDeliveryPrompt(requirement, planPath, '/dev/null', '');

    updateStatus(db, groupId, RequirementStatus.PLANNING);

    const issueId = makeIssueId();
    db.createIssue({
      id: issueId,
      groupId,
      title: `[e2ed] Plan v${version} — ${meta.reqId}`,
      description: prompt,
      createdBy: 'e2ed',
      assignedTo: meta.deliveryAgent || 'claude',
      type: 'delivery',
      workingDir: cwd,
      approvalPolicy: 'rw_allow',
    });

    console.log(`Plan delivery issue created: ${issueId}`);
    console.log(`  Plan output: ${planPath}`);

    if (isPlanOnly) {
      console.log(`\nAfter plan is done, run: rotom e2ed review ${groupId} --type plan`);
      return;
    }

    console.log(`\nAfter plan is done, run: rotom e2ed deliver ${groupId} --code-only`);
    return;
  }

  // Phase 2: Code implementation
  const activePlan = getLatestPlanVersion(db, groupId);
  if (!activePlan) {
    throw new Error('No plan available. Run with --plan-only first.');
  }

  const planText = readArtifactFile(groupId, 'plans', activePlan.dirName, 'plan.md') || '(no plan)';

  let reviewFeedback = '';
  if (isFix) {
    const latestCode = getLatestCodeVersion(db, groupId);
    if (latestCode) {
      reviewFeedback = readArtifactFile(groupId, 'code', latestCode.dirName, 'review', 'report.md') || '';
    }
  }

  const { version, dirName, codeDirPath } = createCodeVersion(db, groupId, {
    parentPlanVersion: activePlan.version,
    author: 'ai',
    isFix,
    fixForCodeVersion: isFix ? getLatestCodeVersion(db, groupId)?.version ?? null : null,
  });

  const reflectionPath = path.join(codeDirPath, 'reflection.md');

  let codePrompt = `You are a Delivery Agent. Implement the following plan.\n\n`;
  codePrompt += `## Requirement\n${requirement}\n\n`;
  codePrompt += `## Approved Plan\n${planText}\n\n`;
  codePrompt += `## Your Tasks\n\n`;
  codePrompt += `### Phase 1: Implement\n1. Implement the plan by editing code files\n2. Follow existing project conventions\n3. Run any available tests to verify\n\n`;
  codePrompt += `### Phase 2: Reflect\n1. Write self-reflection to: ${reflectionPath}\n`;
  codePrompt += `   Use this template:\n${REFLECTION_TEMPLATE}\n\n`;
  codePrompt += `## Constraints\n- Do NOT self-evaluate quality (that is the Reviewer's job)\n- Every file change must be intentional\n- Follow the approved plan strictly`;

  if (reviewFeedback) {
    codePrompt += `\n\n## IMPORTANT: Fix Required\nA previous review found issues. Fix ALL issues identified below.\n\n### Review Feedback\n${reviewFeedback}`;
  }

  updateStatus(db, groupId, RequirementStatus.DELIVERING);

  const issueId = makeIssueId();
  db.createIssue({
    id: issueId,
    groupId,
    title: `[e2ed] Code v${version} — ${meta.reqId}`,
    description: codePrompt,
    createdBy: 'e2ed',
    assignedTo: meta.deliveryAgent || 'claude',
    type: 'delivery',
    workingDir: cwd,
  });

  console.log(`Code delivery issue created: ${issueId}`);
  console.log(`  Reflection: ${reflectionPath}`);
  console.log(`\nAfter code is done, run: rotom e2ed review ${groupId}`);
}

// ── Review ───────────────────────────────────────────────────────────────

export function startReview(db: MeshDb, groupId: string, opts: PipelineOpts = {}): void {
  const meta = getRequirement(db, groupId);
  if (!meta) throw new Error(`Requirement ${groupId} not found`);

  const cwd = opts.cwd || getWorkingDir(db, groupId);
  const type = opts.reviewType || 'code';
  const requirement = getRequirementText(groupId) || '';

  switch (type) {
    case 'requirement':
      startRequirementReview(db, groupId, meta, requirement, cwd);
      break;
    case 'plan':
      startPlanReview(db, groupId, meta, requirement, cwd);
      break;
    case 'code':
      startCodeReview(db, groupId, meta, requirement, cwd);
      break;
  }
}

function startRequirementReview(
  db: MeshDb, groupId: string, meta: RequirementMeta,
  requirement: string, cwd: string,
): void {
  const { reviewIndex, reviewDir } = createReqReview(db, groupId);
  const prompt = buildRequirementReviewPrompt(requirement, meta.reqId);

  updateStatus(db, groupId, RequirementStatus.REQ_REVIEWING);

  const issueId = makeIssueId();
  db.createIssue({
    id: issueId,
    groupId,
    title: `[e2ed] Req Review #${reviewIndex} — ${meta.reqId}`,
    description: prompt,
    createdBy: 'e2ed',
    assignedTo: meta.reviewAgent || 'codex',
    type: 'review',
    workingDir: cwd,
  });

  console.log(`Requirement review issue created: ${issueId}`);
  console.log(`  Report: ${path.join(reviewDir, 'report.md')}`);
}

function startPlanReview(
  db: MeshDb, groupId: string, meta: RequirementMeta,
  requirement: string, cwd: string,
): void {
  const latestPlan = getLatestPlanVersion(db, groupId);
  if (!latestPlan) {
    throw new Error('No plan found. Run deliver --plan-only first.');
  }

  const planText = readArtifactFile(groupId, 'plans', latestPlan.dirName, 'plan.md') || '(no plan content)';
  const prompt = buildPlanReviewPrompt(requirement, planText, latestPlan.version);

  updateStatus(db, groupId, RequirementStatus.PLAN_REVIEWING);

  const issueId = makeIssueId();
  db.createIssue({
    id: issueId,
    groupId,
    title: `[e2ed] Plan Review v${latestPlan.version} — ${meta.reqId}`,
    description: prompt,
    createdBy: 'e2ed',
    assignedTo: meta.reviewAgent || 'codex',
    type: 'review',
    workingDir: cwd,
  });

  console.log(`Plan review issue created: ${issueId}`);
}

function startCodeReview(
  db: MeshDb, groupId: string, meta: RequirementMeta,
  requirement: string, cwd: string,
): void {
  const latestCode = getLatestCodeVersion(db, groupId);
  if (!latestCode) {
    throw new Error('No code delivery found. Run deliver first.');
  }

  const planText = readArtifactFile(groupId, 'plans', `plan-v${latestCode.parentPlanVersion}`, 'plan.md') || '(no plan)';
  const reflection = readArtifactFile(groupId, 'code', latestCode.dirName, 'reflection.md') || '(no reflection)';

  const prompt = buildCodeReviewPrompt(requirement, planText, reflection, [], '');

  updateStatus(db, groupId, RequirementStatus.REVIEWING);

  const issueId = makeIssueId();
  db.createIssue({
    id: issueId,
    groupId,
    title: `[e2ed] Code Review v${latestCode.version} — ${meta.reqId}`,
    description: prompt,
    createdBy: 'e2ed',
    assignedTo: meta.reviewAgent || 'codex',
    type: 'review',
    workingDir: cwd,
  });

  console.log(`Code review issue created: ${issueId}`);
}
