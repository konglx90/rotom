/**
 * E2ED — Prompt templates for three review types and delivery.
 * Ported from e2ed/src/lib/prompts.js
 */

import type { Verdict } from './types.js';

export function buildRequirementReviewPrompt(requirementText: string, reqTitle: string): string {
  return `You are an Independent Requirement Reviewer. You ONLY review — you do NOT modify anything.

## Requirement Title
${reqTitle}

## Requirement Text
${requirementText}

## Review Checklist
Evaluate EACH item. State PASS or FAIL with a brief reason.

### 1. Clarity (25%)
- [ ] Requirement is unambiguous and has a single interpretation
- [ ] Technical terms are defined or used consistently
- [ ] Scope boundaries are clearly stated (what is in/out of scope)
- [ ] No contradictory statements

### 2. Completeness (25%)
- [ ] All functional requirements are listed with specifics (not vague)
- [ ] Non-functional requirements (performance, security, etc.) are addressed
- [ ] Error/edge cases are described
- [ ] Dependencies on external systems/interfaces are identified
- [ ] User roles and permissions are specified

### 3. Testability (25%)
- [ ] Acceptance criteria are measurable and verifiable
- [ ] Each requirement point can be tested with a concrete test case
- [ ] Expected behaviors are stated for normal and abnormal inputs
- [ ] Success metrics are defined

### 4. Ambiguity Check (25%)
- [ ] No words like "should", "might", "could" where "shall"/"must" is needed
- [ ] No unspecified ranges ("fast", "large", "many" without concrete values)
- [ ] No implicit assumptions that different readers might interpret differently
- [ ] No missing "what if" scenarios

## Output Format
Write your review, then end with EXACTLY:

VERDICT_JSON_START
{"score": <0-100>,"status": "<pass|fail|needs-review>","issues": ["..."],"suggestions": ["..."]}
VERDICT_JSON_END

Scoring: 80-100 pass | 50-79 needs-review | 0-49 fail`;
}

export function buildPlanReviewPrompt(requirementText: string, planText: string, planVersion: number): string {
  return `You are an Independent Plan Reviewer. You ONLY review — you do NOT modify anything.

## Original Requirement
${requirementText}

## Delivery Plan (v${planVersion})
${planText}

## Review Checklist
Evaluate EACH item. State PASS or FAIL with a brief reason.

### 1. Feasibility (25%)
- [ ] Technical approach is viable with the stated constraints
- [ ] Dependencies are available and compatible
- [ ] Estimated complexity matches the scope
- [ ] No unrealistic assumptions

### 2. Requirement Coverage (25%)
- [ ] Every explicitly stated requirement point is addressed in the plan
- [ ] Edge cases mentioned in the requirement are handled
- [ ] Error handling strategy is defined
- [ ] All user-facing states (loading, empty, error) are planned

### 3. Risk Assessment (25%)
- [ ] Technical risks are identified with mitigation strategies
- [ ] Potential impact on existing functionality is assessed
- [ ] Performance implications are considered
- [ ] Rollback strategy exists for risky changes

### 4. Approach Quality (25%)
- [ ] Implementation steps are concrete and actionable
- [ ] File/module changes are identified
- [ ] Data model changes are specified
- [ ] API interface changes are defined
- [ ] Test strategy is outlined

## Output Format
Write your review, then end with EXACTLY:

VERDICT_JSON_START
{"score": <0-100>,"status": "<pass|fail|needs-review>","issues": ["..."],"suggestions": ["..."]}
VERDICT_JSON_END

Scoring: 80-100 pass | 50-79 needs-review | 0-49 fail`;
}

export function buildCodeReviewPrompt(
  requirementText: string,
  planText: string,
  reflection: string,
  changedFiles: string[],
  diff: string,
): string {
  return `You are an Independent Code Reviewer. You ONLY review — you do NOT modify any code.

## Original Requirement
${requirementText}

## Delivery Plan
${planText}

## Delivery Self-Reflection
${reflection}

## Changed Files
${changedFiles.length > 0 ? changedFiles.map((f) => `- ${f}`).join('\n') : '(none detected)'}

## Code Diff
${diff || '(no diff available)'}

## Review Checklist
Evaluate EACH item. State PASS or FAIL with a brief reason.

### 1. Requirement Coverage
- [ ] All explicitly stated requirement points implemented
- [ ] Edge cases and boundary conditions handled
- [ ] Error/exception handling complete
- [ ] All user-facing states (loading, empty, error) covered

### 2. Code Quality
- [ ] No obvious security vulnerabilities (XSS, injection, sensitive data)
- [ ] Naming/structure follows project conventions
- [ ] No redundant or dead code
- [ ] No hardcoded values that should be configurable

### 3. Boundary Validation ("两侧同时阅读")
- [ ] API interface definitions match frontend types
- [ ] State transitions match UI behavior
- [ ] Data model shapes match business logic
- [ ] Props/parameters between modules consistent

### 4. Maintainability
- [ ] No hidden technical debt introduced
- [ ] No over-abstraction or premature optimization
- [ ] Test coverage sufficient for the changes
- [ ] Comments explain WHY not WHAT

### 5. Requirement Deviation
- [ ] Implementation matches the delivery plan
- [ ] Risks in reflection are reasonable
- [ ] No scope creep
- [ ] Deviations from plan justified

## Output Format
Write your review, then end with EXACTLY:

VERDICT_JSON_START
{"score": <0-100>,"status": "<pass|fail|needs-review>","issues": ["..."],"suggestions": ["..."]}
VERDICT_JSON_END

Scoring: 80-100 pass | 50-79 needs-review | 0-49 fail`;
}

export function buildDeliveryPrompt(requirement: string, planPath: string, reflectionPath: string, reviewFeedback?: string): string {
  let prompt = `You are a Delivery Agent. Complete the following requirement with self-reflection.

## Requirement
${requirement}

## Your Tasks (execute in order)

### Phase 1: Plan
1. Analyze the requirement and understand the codebase
2. Read existing files, understand project conventions and patterns
3. Write a detailed implementation plan to: ${planPath}
   Format (write as markdown):
   - 需求摘要: one paragraph summary
   - 影响范围: files/modules affected
   - 技术方案: concrete implementation approach
   - 风险点: potential issues
   - 验收标准: how to verify completion

### Phase 2: Implement
1. Implement the plan by editing code files
2. Follow existing project conventions
3. Run any available tests to verify

### Phase 3: Reflect
1. Write self-reflection to: ${reflectionPath}
   Use this template:
   # Delivery Reflection
   ## Key Decisions (table: Decision | WHY | Alternative)
   ## Uncertainties & Unknowns
   ## Known Risks
   ## Deviations from Original Requirement
   ## Files Changed
   ## What I Would Do Differently

## Constraints
- Do NOT self-evaluate quality (that is the Reviewer's job)
- Write the plan BEFORE coding, not after
- Every file change must be intentional`;

  if (reviewFeedback) {
    prompt += `

## IMPORTANT: Fix Required
A previous review found issues. Fix ALL issues identified below. Do NOT start from scratch.

### Review Feedback
${reviewFeedback}`;
  }

  return prompt;
}

/** Extract verdict JSON from review report text */
export function extractVerdict(text: string): Verdict {
  const m1 = text.match(/VERDICT_JSON_START\s*(\{[\s\S]*?\})\s*VERDICT_JSON_END/);
  if (m1) try { return normalizeVerdict(JSON.parse(m1[1])); } catch { /* fall through */ }

  const m2 = text.match(/```(?:verdict|json)?\s*(\{"score"[\s\S]*?\})\s*```/);
  if (m2) try { return normalizeVerdict(JSON.parse(m2[1])); } catch { /* fall through */ }

  const m3 = text.match(/\{"score"\s*:\s*\d+[\s\S]*?\}/);
  if (m3) try { return normalizeVerdict(JSON.parse(m3[0])); } catch { /* fall through */ }

  return { score: 0, status: 'needs-review', issues: ['Could not parse verdict'], suggestions: ['Manual review required'] };
}

function normalizeVerdict(v: any): Verdict {
  return {
    score: typeof v.score === 'number' ? v.score : 0,
    status: ['pass', 'fail', 'needs-review'].includes(v.status) ? v.status : 'needs-review',
    issues: Array.isArray(v.issues) ? v.issues : [],
    suggestions: Array.isArray(v.suggestions) ? v.suggestions : [],
  };
}

export const REFLECTION_TEMPLATE = `# Delivery Reflection

## Key Decisions

| Decision | WHY | Alternative Considered |
|----------|-----|----------------------|
| ... | ... | ... |

## Uncertainties & Unknowns
- ...

## Known Risks
- ...

## Deviations from Original Requirement
- ...

## Files Changed
- ...

## What I Would Do Differently
- ...
`;
