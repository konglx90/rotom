/**
 * E2ED — End-to-End Requirement Delivery type definitions.
 */

/** Requirement lifecycle status */
export const RequirementStatus = {
  CREATED: 'CREATED',
  ENV_CHECKING: 'ENV_CHECKING',
  ENV_READY: 'ENV_READY',
  ENV_BLOCKED: 'ENV_BLOCKED',
  REQ_REVIEWING: 'REQ_REVIEWING',
  REQ_REVIEWED: 'REQ_REVIEWED',
  PLANNING: 'PLANNING',
  PLAN_REVIEWING: 'PLAN_REVIEWING',
  PLAN_REVIEWED: 'PLAN_REVIEWED',
  DELIVERING: 'DELIVERING',
  DELIVERED: 'DELIVERED',
  REVIEWING: 'REVIEWING',
  REVIEWED: 'REVIEWED',
  CLOSED: 'CLOSED',
} as const;

export type RequirementStatusType = (typeof RequirementStatus)[keyof typeof RequirementStatus];

/** Composite version: R.P.C (Requirement.Plan.Code) */
export interface CompositeVersion {
  r: number;
  p: number;
  c: number;
  label: string; // "R1.P2.C3"
}

/** Plan version metadata */
export interface PlanVersionMeta {
  version: number;
  dirName: string;        // "plan-v1"
  parentReqVersion: number;
  createdAt: string;
  reviewStatus: ReviewResult | null;
}

/** Code version metadata */
export interface CodeVersionMeta {
  version: number;
  dirName: string;        // "code-v1"
  parentPlanVersion: number;
  author: 'ai' | 'human';
  isFix: boolean;
  fixForCodeVersion: number | null;
  createdAt: string;
  reviewStatus: ReviewResult | null;
}

/** Requirement metadata stored in group.metadata JSON */
export interface RequirementMeta {
  reqId: string;          // group id (same as group.id)
  status: RequirementStatusType;
  compositeVersion: string;
  planVersions: PlanVersionMeta[];
  codeVersions: CodeVersionMeta[];
  runCount: {
    deliver: number;
    review: number;
    reqReview: number;
    planReview: number;
    codeReview: number;
  };
  timeline: Array<{ status: RequirementStatusType; at: string }>;
  source: string;
  links: Array<{ type: string; url: string; branch?: string }>;
  deliveryAgent?: string;
  reviewAgent?: string;
}

/** Review result */
export type ReviewResult = 'pass' | 'fail' | 'needs-review';

/** Verdict extracted from review report */
export interface Verdict {
  score: number;          // 0-100
  status: ReviewResult;
  issues: string[];
  suggestions: string[];
}

/** Metrics for a single delivery round */
export interface RoundMetrics {
  version: number;
  deliveryDuration: number;  // ms
  reviewDuration: number;    // ms
  result: ReviewResult;
}

/** Aggregate metrics for a requirement */
export interface E2edMetrics {
  totalDuration: number;
  planRounds: RoundMetrics[];
  codeRounds: RoundMetrics[];
}

/** Issue types for e2ed */
export type E2edIssueType = 'delivery' | 'review';

/** E2ed issue metadata stored in issue metadata JSON */
export interface E2edIssueMeta {
  phase: 'requirement-review' | 'plan-delivery' | 'plan-review' | 'code-delivery' | 'code-review';
  version: number;        // plan or code version
  parentVersion?: number; // code version's parent plan version
}
