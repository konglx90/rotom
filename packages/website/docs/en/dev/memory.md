# Memory System

Rotom's agent memory store: facts/decisions/conventions/pitfalls/todos/playbooks sedimented across turns, layered by visibility and either injected into prompts or hidden from agents.

## 1. Concept

Memory is "reusable group knowledge", split by scope (group / global) and visibility (private / group / global). private memory is visible only to the writing agent; group/global to agents in the group. **global + agent-visible** memory must pass `pending_review` and be approved by a human before agents see it — preventing dirty memories from polluting all agents.

## 2. Data model (`agent_memory`)

| Column | Meaning |
|---|---|
| `scope` | group / global (group carries group_id) |
| `category` | fact / decision / convention / pitfall / todo / playbook / note |
| `visibility` | private / group / global |
| `agent_visible` | 0/1, visible to agent path? (note default 0; pending default 0) |
| `pending_review` | 0/1, awaiting human approval (global default 1) |
| `injected_count` | +1 on search hit |
| `view_count` | +1 on get |
| `expires_at` | optional expiry |
| `active` | soft-delete |

## 3. Visibility matrix

| Write | visibility | pending_review | agent_visible | agent-visible? |
|---|---|---|---|---|
| private | private | 0 | 1 | only self |
| group | group | 0 | 1 | group agents |
| global | global | **1** | 0 | no, pending |
| global approved | global | 0 | 1 | all agents |
| note (legacy) | * | 0 | **0** | no |

> Rule: visibility=global + agent_visible=true must pass pending_review. Auto-write rules go to group scope, not global.

## 4. Key files

- `src/master/db/memory.ts` — add/list/search/promote/approve/stats
- `src/master/api/memory.ts` — REST CRUD + approval + stats
- `src/cli/memory.ts` — CLI; `memory stats --stale` warns because `/memory/stale` is unimplemented
- `tests/memory.test.ts` — visibility isolation / pending / counts / promote / approve / legacy note

## 5. Count semantics

- `injected_count`: +1 per `searchMemory` hit (injection count).
- `view_count`: +1 per `getMemory`.
- `memoryStats`: byCategory / byAgentVisible / topViewed.

## 6. Relationships

- **Skills**: a playbook memory can be promoted to a skill.
- **Patrol**: link-patrol writes classification conclusions back to memory.
- **Prompt injection**: visible memories' summaries are injected on dispatch.
