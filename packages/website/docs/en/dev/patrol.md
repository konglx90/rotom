# Patrol System — Issue Patrol + Link Patrol

Rotom uses scheduled tasks to drive a "patrol" agent that periodically checks issue-queue health / classifies links, persisting structured conclusions.

## 1. Concept

Two patrol kinds, each with its own patrol group + patrol agent + rules skill:

- **Issue patrol**: scans open unassigned issues, verdicts `ready / not_ready / uncertain` (can it be claimed directly). Prevents stale issues piling up or large needs being claimed blindly.
- **Link patrol**: scans unclassified links, assigns `category + tags + title + rationale`.

Both are **mode=agent scheduled_tasks**: at fire time a patrol issue is created + `pushIssueAssignment` dispatches to the patrol agent; the agent runs and produces a JSON result; when the issue goes terminal, master parses the result and persists it.

## 2. Data model

- `issue_patrol_runs` / `issue_patrol_logs` — issue patrol run + per-candidate verdicts
- `link_patrol_runs` / `link_patrol_logs` — link patrol run + per-link classifications
- `scheduled_tasks` — the patrol task (handler_key distinguishes; default interval below)
- Seed skills: `sk_issue_patrol_rules_seed` / `sk_link_patrol_rules_seed`

## 3. Default intervals (gotcha)

- **issue-patrol default interval is 7200s (2h), not 3600s**
- **link-patrol default interval is 18000s (5h), not 3600s**

Changing defaults requires syncing the `bootstrap` constant + dashboard patrol-tab default, or the two sides drift.

## 4. Key files

- `src/master/scheduler-handlers.ts` — `issue-patrol` / `link-patrol` handlers: candidate scan + priority sort + create patrol issue + fire-and-forget dispatch; includes overlap guard, agent-online check, global in_progress throughput cap
- `src/master/patrol-terminal.ts` — **unified entry `dispatchPatrolTerminal(db, issue)`**: on issue terminal, reverse-lookup via `getLinkPatrolRunByIssueId`; hit → link flow, else → issue flow. Called by `server.ts`'s `_onIssueTerminal` hook
- `src/master/api/issues-patrol.ts` / `links-patrol.ts` / `links.ts` — patrol state / run / log / config REST
- `src/master/services/link-collector.ts` — inline hook after group messages, collects links into `links`
- `migrations/001-schema.sql` — the above tables + seed skills

## 5. Terminal persistence

`dispatchPatrolTerminal` dispatches:
- issue flow: `handleIssuePatrolTerminal` parses result JSON → writes `issue_patrol_logs`
- link flow: `handleLinkPatrolIssueTerminal` → `UPDATE links` + writes `link_patrol_logs` + writes memory (few-shot rules)

## 6. Relationships

- **Scheduler**: patrol is the two big mode=agent use cases.
- **Skills**: rules live as skills, spliced into the patrol issue prompt by the handler.
- **Memory**: link-patrol conclusions sediment into memory.
- **Links KB**: link-patrol writes back to the `links` main table.
