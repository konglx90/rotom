# Skills System

Rotom "skills" are reusable markdown rules/workflows injected into agent prompts on demand, driving patrol and normative-execution scenarios.

## 1. Concept

A skill = a markdown `content` + metadata (category / source_type / source_ref). Skills don't execute directly; they are associated to (group, agent, skill) via **bindings**, then injected into the prompt for the underlying CLI agent to read and follow. This bypasses provider-side skill mechanisms — master only stores + triggers injection; the agent is what actually "understands" the rule.

## 2. Data model

**`agent_skills`** — main table

| Column | Meaning |
|---|---|
| `id` | UUID; seed skills use fixed ids (e.g. `sk_issue_patrol_rules_seed`) |
| `name` | unique name |
| `content` | markdown rule body |
| `category` | workflow / patrol / … |
| `source_type` | manual / memory (promoted from a memory) |
| `source_ref` | origin reference (memory id when promoted) |
| `active` | soft-delete flag |
| `view_count` / `last_viewed_at` | stats |

**`agent_skill_bindings`** — binding table (granularity: group + agent + skill)

| Column | Meaning |
|---|---|
| `group_id` / `agent_name` / `skill_id` | triple, UNIQUE |
| `created_at` | bind time |

## 3. Key files

- `src/master/api/skills.ts` — REST CRUD + binding
- `src/master/db/skills.ts` — skill / binding data access
- `src/master/db/memory.ts` `promoteMemoryToSkill` — promote a playbook memory into a skill (`source_ref` points back to the memory)
- `tests/skills.test.ts` — binding / count / isolation / soft-delete
- Seed skills: `migrations/001-schema.sql`

## 4. REST & CLI

REST: `GET/POST/PUT/DELETE /skills`, `/skills/:id/bind`, `/skills/:id/unbind`, `/skills/bindings`, `/skills/mine`.
CLI: `rotom skill list|search|get|create|update|remove|bind|unbind|bindings|mine`.

## 5. Prompt injection

On group-message dispatch, `enrichWorkerDispatch` (ws-hub) splices active bound skills' content into the worker's instruction layer. In patrol scenarios, the handler actively uses the rules skill as few-shot in the patrol issue's prompt.

## 6. Relationships

- **Memory**: a playbook memory can be promoted to a skill.
- **Patrol**: the issue-patrol / link-patrol rules are two seed skills.
