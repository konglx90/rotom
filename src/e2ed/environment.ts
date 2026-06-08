/**
 * E2ED — Environment readiness checks.
 *
 * Validates working directory and project setup before delivery.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MeshDb } from '../master/db.js';
import { RequirementStatus } from './types.js';
import type { RequirementStatusType } from './types.js';
import { getRequirement, updateStatus, setActiveTask } from './requirement.js';

export interface EnvCheckResult {
  ready: boolean;
  issues: string[];
}

/**
 * Check if the working directory is ready for delivery.
 */
export function checkEnvironment(cwd: string): EnvCheckResult {
  const issues: string[] = [];

  // Check cwd exists
  if (!fs.existsSync(cwd)) {
    issues.push(`Working directory does not exist: ${cwd}`);
    return { ready: false, issues };
  }

  // Check it's a directory
  const stat = fs.statSync(cwd);
  if (!stat.isDirectory()) {
    issues.push(`Working path is not a directory: ${cwd}`);
    return { ready: false, issues };
  }

  // Check for project markers
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
  const hasGoMod = fs.existsSync(path.join(cwd, 'go.mod'));
  const hasCargoToml = fs.existsSync(path.join(cwd, 'Cargo.toml'));
  const hasPomXml = fs.existsSync(path.join(cwd, 'pom.xml'));
  const hasPyProject = fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.py'));

  if (!hasPackageJson && !hasGoMod && !hasCargoToml && !hasPomXml && !hasPyProject) {
    // Not a hard block — could be a new project. Just warn.
    issues.push('No recognized project file found (package.json, go.mod, etc.). Delivery may proceed but verify setup.');
  }

  // Check write permission
  try {
    const testFile = path.join(cwd, '.e2ed-env-check');
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);
  } catch {
    issues.push(`No write permission in working directory: ${cwd}`);
  }

  return { ready: issues.every((i) => !i.startsWith('No write') && !i.startsWith('Working')), issues };
}

/**
 * Transition requirement through ENV_CHECKING → ENV_READY | ENV_BLOCKED.
 */
export function checkAndTransitionEnv(db: MeshDb, groupId: string, cwd: string): {
  status: RequirementStatusType;
  issues: string[];
} {
  const meta = getRequirement(db, groupId);
  if (!meta) throw new Error(`Requirement ${groupId} not found`);

  // Only run env check from CREATED state
  if (meta.status !== RequirementStatus.CREATED) {
    return { status: meta.status, issues: [] };
  }

  setActiveTask(db, groupId, 'env_checking');

  const result = checkEnvironment(cwd);

  if (result.ready) {
    updateStatus(db, groupId, RequirementStatus.ENV_READY);
    setActiveTask(db, groupId, null);
    return { status: RequirementStatus.ENV_READY, issues: result.issues };
  }

  updateStatus(db, groupId, RequirementStatus.ENV_BLOCKED);
  setActiveTask(db, groupId, null);
  return { status: RequirementStatus.ENV_BLOCKED, issues: result.issues };
}
