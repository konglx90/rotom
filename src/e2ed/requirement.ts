/**
 * E2ED — Requirement management module.
 *
 * Data layer: Rotom SQLite (groups table) + group artifact directories.
 * Replaces the original e2ed JSON file storage.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MeshDb } from '../master/db.js';
import { defaultGroupWorkingDir, resolveGroupArtifactRoot } from '../master/group-paths.js';
import type {
  RequirementMeta,
  RequirementStatusType,
  PlanVersionMeta,
  CodeVersionMeta,
  CompositeVersion,
} from './types.js';
import { RequirementStatus } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function metaDir(groupId: string): string {
  return defaultGroupWorkingDir(groupId);
}

function plansDir(groupId: string): string {
  return path.join(metaDir(groupId), 'plans');
}

function codeDir(groupId: string): string {
  return path.join(metaDir(groupId), 'code');
}

function reqReviewsDir(groupId: string): string {
  return path.join(metaDir(groupId), 'req-reviews');
}

function readMeta(db: MeshDb, groupId: string): RequirementMeta | null {
  const group = db.getGroupById(groupId);
  if (!group || group.type !== 'e2ed') return null;

  let meta: RequirementMeta;
  try {
    meta = JSON.parse(group.metadata || '{}');
  } catch {
    meta = {} as RequirementMeta;
  }

  // Ensure required fields
  meta.reqId ??= groupId;
  meta.status ??= RequirementStatus.CREATED;
  meta.planVersions ??= [];
  meta.codeVersions ??= [];
  meta.runCount ??= { deliver: 0, review: 0, reqReview: 0, planReview: 0, codeReview: 0 };
  meta.timeline ??= [];
  meta.source ??= 'manual';
  meta.links ??= [];
  meta.compositeVersion ??= computeCompositeVersion(meta);

  return meta;
}

function writeMeta(db: MeshDb, groupId: string, meta: RequirementMeta): void {
  meta.compositeVersion = computeCompositeVersion(meta);
  db.updateGroupMetadata(groupId, JSON.stringify(meta));
}

function computeCompositeVersion(meta: RequirementMeta): string {
  const r = 1; // requirement version tracking can be added later
  const p = meta.planVersions?.length || 0;
  const c = meta.codeVersions?.length || 0;
  return `R${r}.P${p}.C${c}`;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Requirement CRUD ─────────────────────────────────────────────────────

export function createRequirement(
  db: MeshDb,
  opts: { title: string; text: string; source?: string; workingDir?: string },
): { groupId: string; meta: RequirementMeta } {
  const groupId = randomUUID();
  const now = new Date().toISOString();
  const title = opts.title || opts.text.substring(0, 60);

  // Create group in SQLite
  db.createGroupTyped({
    id: groupId,
    name: title,
    type: 'e2ed',
    workingDir: opts.workingDir || null,
    metadata: JSON.stringify({
      reqId: groupId,
      status: RequirementStatus.CREATED,
      compositeVersion: 'R1.P0.C0',
      planVersions: [],
      codeVersions: [],
      runCount: { deliver: 0, review: 0, reqReview: 0, planReview: 0, codeReview: 0 },
      timeline: [{ status: RequirementStatus.CREATED, at: now }],
      source: opts.source || 'manual',
      links: [],
    }),
  });

  // Create artifact directories
  const dir = metaDir(groupId);
  ensureDir(dir);
  ensureDir(plansDir(groupId));
  ensureDir(codeDir(groupId));
  ensureDir(reqReviewsDir(groupId));

  // Write requirement.md
  fs.writeFileSync(path.join(dir, 'requirement.md'), opts.text);

  const meta = readMeta(db, groupId)!;
  return { groupId, meta };
}

export function getRequirement(db: MeshDb, groupId: string): RequirementMeta | null {
  return readMeta(db, groupId);
}

export function listRequirements(db: MeshDb): RequirementMeta[] {
  const groups = db.listGroupsByType('e2ed');
  return groups
    .map((g) => {
      try { return JSON.parse(g.metadata || '{}') as RequirementMeta; } catch { return null; }
    })
    .filter((m): m is RequirementMeta => m !== null);
}

export function updateStatus(db: MeshDb, groupId: string, status: RequirementStatusType): RequirementMeta {
  const meta = readMeta(db, groupId);
  if (!meta) throw new Error(`Requirement ${groupId} not found`);

  const now = new Date().toISOString();
  meta.status = status;
  meta.timeline.push({ status, at: now });

  writeMeta(db, groupId, meta);
  return meta;
}

export function getRequirementText(groupId: string): string | null {
  const filePath = path.join(metaDir(groupId), 'requirement.md');
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

// ── Plan Version Management ──────────────────────────────────────────────

export function createPlanVersion(
  db: MeshDb,
  groupId: string,
  opts: { parentReqVersion?: number } = {},
): { version: number; dirName: string; planDir: string } {
  const meta = readMeta(db, groupId);
  if (!meta) throw new Error(`Requirement ${groupId} not found`);

  const version = meta.planVersions.length + 1;
  const dirName = `plan-v${version}`;
  const planDir = path.join(plansDir(groupId), dirName);
  ensureDir(planDir);
  ensureDir(path.join(planDir, 'review'));

  const now = new Date().toISOString();
  const planMeta: PlanVersionMeta = {
    version,
    dirName,
    parentReqVersion: opts.parentReqVersion || 1,
    createdAt: now,
    reviewStatus: null,
  };

  meta.planVersions.push(planMeta);
  writeMeta(db, groupId, meta);

  return { version, dirName, planDir };
}

export function getLatestPlanVersion(db: MeshDb, groupId: string): PlanVersionMeta | null {
  const meta = readMeta(db, groupId);
  if (!meta || meta.planVersions.length === 0) return null;
  return meta.planVersions[meta.planVersions.length - 1];
}

export function updatePlanVersionStatus(
  db: MeshDb,
  groupId: string,
  planVersion: number,
  status: 'pass' | 'fail' | 'needs-review',
): void {
  const meta = readMeta(db, groupId);
  if (!meta) return;

  const pv = meta.planVersions.find((p) => p.version === planVersion);
  if (pv) pv.reviewStatus = status;

  writeMeta(db, groupId, meta);
}

// ── Code Version Management ──────────────────────────────────────────────

export function createCodeVersion(
  db: MeshDb,
  groupId: string,
  opts: {
    parentPlanVersion: number;
    author?: 'ai' | 'human';
    isFix?: boolean;
    fixForCodeVersion?: number | null;
  },
): { version: number; dirName: string; codeDirPath: string } {
  const meta = readMeta(db, groupId);
  if (!meta) throw new Error(`Requirement ${groupId} not found`);

  const version = meta.codeVersions.length + 1;
  const dirName = `code-v${version}`;
  const codeDirPath = path.join(codeDir(groupId), dirName);
  ensureDir(codeDirPath);
  ensureDir(path.join(codeDirPath, 'artifacts'));
  ensureDir(path.join(codeDirPath, 'review'));

  const now = new Date().toISOString();
  const codeMeta: CodeVersionMeta = {
    version,
    dirName,
    parentPlanVersion: opts.parentPlanVersion,
    author: opts.author || 'ai',
    isFix: opts.isFix || false,
    fixForCodeVersion: opts.fixForCodeVersion ?? null,
    createdAt: now,
    reviewStatus: null,
  };

  meta.codeVersions.push(codeMeta);
  writeMeta(db, groupId, meta);

  return { version, dirName, codeDirPath };
}

export function getLatestCodeVersion(db: MeshDb, groupId: string): CodeVersionMeta | null {
  const meta = readMeta(db, groupId);
  if (!meta || meta.codeVersions.length === 0) return null;
  return meta.codeVersions[meta.codeVersions.length - 1];
}

export function updateCodeVersionStatus(
  db: MeshDb,
  groupId: string,
  codeVersion: number,
  status: 'pass' | 'fail' | 'needs-review',
): void {
  const meta = readMeta(db, groupId);
  if (!meta) return;

  const cv = meta.codeVersions.find((c) => c.version === codeVersion);
  if (cv) cv.reviewStatus = status;

  writeMeta(db, groupId, meta);
}

// ── Requirement Reviews ──────────────────────────────────────────────────

export function createReqReview(
  db: MeshDb,
  groupId: string,
): { reviewIndex: number; dirName: string; reviewDir: string } {
  const meta = readMeta(db, groupId);
  if (!meta) throw new Error(`Requirement ${groupId} not found`);

  meta.runCount.reqReview++;
  const reviewIndex = meta.runCount.reqReview;
  const dirName = `review-v${reviewIndex}`;
  const reviewDir = path.join(reqReviewsDir(groupId), dirName);
  ensureDir(reviewDir);

  writeMeta(db, groupId, meta);

  return { reviewIndex, dirName, reviewDir };
}

// ── File Helpers ─────────────────────────────────────────────────────────

export function readArtifactFile(groupId: string, ...segments: string[]): string | null {
  const filePath = path.join(metaDir(groupId), ...segments);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeArtifactFile(groupId: string, content: string, ...segments: string[]): void {
  const filePath = path.join(metaDir(groupId), ...segments);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}

export function getWorkingDir(db: MeshDb, groupId: string): string {
  return resolveGroupArtifactRoot(db, groupId);
}

// ── Close Requirement ─────────────────────────────────────────────────────

const CLOSEABLE_STATES: RequirementStatusType[] = [
  RequirementStatus.REVIEWED,
  RequirementStatus.DELIVERED,
  RequirementStatus.PLAN_REVIEWED,
  RequirementStatus.REQ_REVIEWED,
];

export function closeRequirement(db: MeshDb, groupId: string): RequirementMeta {
  const meta = readMeta(db, groupId);
  if (!meta) throw new Error(`Requirement ${groupId} not found`);

  if (!CLOSEABLE_STATES.includes(meta.status)) {
    throw new Error(`Cannot close requirement in state ${meta.status}. Allowed: ${CLOSEABLE_STATES.join(', ')}`);
  }

  return updateStatus(db, groupId, RequirementStatus.CLOSED);
}
