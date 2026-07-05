---
title: Dev Delivery Workflow
description: A requirement = one rotom group. Backend leads decisions, frontend collaborates, human fallbacks.
---

# Frontend/Backend Requirement Delivery Workflow (rotom collaboration model)

> One requirement = one rotom group. Backend leads decisions, frontend collaborates, human fallbacks.

## Roles

| Role | Who (example) | Responsibility |
|------|---------------|----------------|
| **Lead backend agent** | team-claude | Requirements manager: tech decisions, task breakdown, schedule estimation, produces the work-split plan |
| **Frontend agent** | team-codex | Frontend research, requests API plan from backend, executes frontend work |
| **Human** | team-member | Fallback: complex implementation, release approval, final acceptance and archival |

## Pipeline overview

```
P0 Create group   → create requirement group + invite members + create note
P1 Dual-side research → backend and frontend each survey current state
P2 Frontend asks 3 questions → backend replies per template: boundary / API / readiness
P3 Confirm + write note → work-split plan written into the note
P4 Each makes a plan → frontend and backend each produce an execution plan
P5 Implementation → simple tasks via issue --run; complex ones @human
P6 Accept + archive → confirm delivery, update note to wrap up
```

---

## P0 — Create group

**Trigger**: a new requirement arrives.

**Actions**:

```bash
# 1. Create group
rotom group create "Req-xxx" --description "xxx feature development"

# 2. Invite roles
rotom group invite <groupId> team-claude   # lead backend agent
rotom group invite <groupId> team-codex    # frontend agent
# you (human) are already in the group

# 3. Create requirement note (continuously updated through lifecycle)
rotom note create <groupId> \
  --title "Req-xxx-work-split" \
  --description "## Requirement\n[TBD]\n\n## Work split\n[TBD]\n\n## API plan\n[TBD]\n\n## Readiness\n[TBD]\n\n## Execution log\n[TBD]"
```

---

## P1 — Dual-side research

The backend and frontend agents **each** survey their own domain's current state, syncing via group messages.

**Backend agent**:

```bash
rotom group send <groupId> all \
  "@all backend research conclusions:
1. Existing XX module already has A/B capability, missing C
2. Need to add a D API
3. Tiange test environment available"
```

**Frontend agent**:

```bash
rotom group send <groupId> all \
  "@all frontend research conclusions:
1. XX page already exists, missing YY component
2. Data flow: page → service → GET /api/..."
```

**Human role**: not involved unless agents hit a business blind spot needing your clarification.

---

## P2 — Frontend asks 3 questions

**The frontend agent proactively asks the lead backend agent**:

```bash
rotom group send <groupId> team-claude \
  "@team-claude for this requirement, I need three things:
1. **Boundary**: how do we split frontend/backend work?
2. **API plan**: what APIs does backend provide? In/out params and implementation rationale?
3. **Readiness**: are APIs ready? Tiange / integration env / docs available?"
```

**Lead backend agent replies with the structured template**:

```bash
rotom group send <groupId> team-codex \
  "@team-codex

[Boundary]
- Frontend: XXX, YYY
- Backend: ZZZ

[API plan]
1. GET /api/xxx
   - In: xxx
   - Out: xxx
   - Rationale: xxx
2. POST /api/yyy
   - In: xxx
   - Out: xxx
   - Rationale: xxx

[Readiness]
- GET is live, PUT lands tomorrow evening
- Integration env: http://xxx
- Tiange appKey: xxx
- Mock data: xxx

[Schedule estimate]
- Backend 1d, frontend 2d, integration 0.5d"
```

---

## P3 — Confirm split + write note

**Frontend agent confirms**:

```bash
rotom group send <groupId> team-claude \
  "@team-claude work split approved, I'll plan accordingly."
```

If disagreeing, PK until consensus.

**Lead backend agent updates the note**:

```bash
rotom note update <noteId> \
  --description "(fill requirement / work split / API plan / readiness fields with P2 template content)"
```

---

## P4 — Each makes a plan

Frontend and backend each post an execution plan:

```bash
# Frontend plan
rotom group send <groupId> all \
  "@all frontend plan:
1. Create XX component
2. Wire into XX page
3. Call GET API to display data
4. Integrate POST API
5. Estimate 2d"

# Backend plan
rotom group send <groupId> all \
  "@all backend plan:
1. Add YY table migration
2. Write GET handler
3. Write POST handler + transaction
4. Deploy to test env
5. Estimate to land tomorrow"
```

---

## P5 — Implementation

**Principle**: simple tasks go via `rotom issue create --run` for auto execution; complex logic @human.

```bash
# Frontend task
rotom issue create <groupId> \
  --title "Implement XX component" \
  --description "..." \
  --assignee team-codex \
  --run

# Backend task
rotom issue create <groupId> \
  --title "Implement YY API" \
  --description "..." \
  --assignee team-claude \
  --run
```

**Human intervention points**:
- Requirement ambiguity needing your call
- Implementation touches external systems needing your coordination
- Code review and acceptance

---

## P6 — Accept + archive

**Auto-announcement when agent completes**. After you accept:

```bash
# Update note to wrap up
rotom note update <noteId> \
  --description "(previous content)\n\n## Execution log\n✅ Frontend and backend shipped, accepted, <date>"
```

---

## Minimum command sequence for a complete requirement

```bash
# === P0 create group ===
rotom group create "Req-role-management"
rotom group invite <gId> team-claude team-codex
rotom note create <gId> --title "Role-mgmt-work-split" --description "## Requirement\n[TBD]..."

# === P1 research (agents post group messages automatically) ===

# === P2 frontend asks 3 questions (agent asks, backend replies per template) ===

# === P3 confirm + write note ===

# === P4 each makes a plan ===

# === P5 implementation ===
rotom issue create <gId> --title "..." --assignee team-codex --run
rotom issue create <gId> --title "..." --assignee team-claude --run

# === P6 acceptance ===
rotom note update <noteId> --description "..."
```

## Design decisions

| Dimension | Choice | Reason |
|-----------|--------|--------|
| Group granularity | One requirement per group | Context isolation, no cross-talk |
| Lead agent | Backend | Backend sets boundary / API / schedule |
| Artifact | rotom note | Structured, traceable, updatable |
| Backend reply template | boundary → API → readiness → schedule | Frontend agent parses programmatically |
| Decision rights | Tech + schedule | Backend also owns task breakdown and effort estimation |
| Fallback | @human intervention | Simple → issue auto-run; complex → you control |
