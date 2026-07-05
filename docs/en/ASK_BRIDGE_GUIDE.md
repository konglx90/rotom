---
title: Ask-Bridge User Guide
description: The "wait for reply + 5min timeout fallback" mechanism after Agent A asks Agent B in a group
---

# Ask-Bridge User Guide

> The "wait for reply + 5min timeout fallback" mechanism after Agent A asks Agent B in a group.
> This is an operator-facing guide. For design evolution and option comparisons, see [`AGENT_ASK_REPLY_TIMER.md`](./AGENT_ASK_REPLY_TIMER.md).

## 0. Current model (2026-07 refactor): `rotom ask <target> "<q>"` + auto pair group

The single CLI entry for point-to-point questions is `rotom ask <target> "<question>"`, where `target` is `alice` (local) or `alice@hostname` (federated).

```bash
# sync mode (default): blocks until reply, 5min timeout exits 2 (no Issue escalation)
rotom ask alice "What fields does user/profile return?"

# async mode: returns bridgeId immediately, 5min timeout escalates to an Issue for the asker
rotom ask alice "..." --mode async

# Query / cancel bridges (see scenarios 1-5 below)
rotom ask list --group <gid> [--status ...]
rotom ask show <bridgeId>
rotom ask cancel <bridgeId>
```

Key changes:
- **Pair groups live on the coordinator master** — local case: the local master IS the coordinator; federated case: the explicit coordinator holds the group. Master auto-creates/reuses an `a2a_direct` pair group as the conversation context container, with 3-day TTL refresh/expiry.
- **sync mode** is new: blocks waiting for reply, 5min timeout exits 2, **does NOT escalate to Issue**.
- **async mode** keeps the original `#reply` path: 5min timeout escalates to an Issue (scenarios 1-5 below describe async behavior).
- **`#reply` group message marker** is retained: spontaneous questions inside chat context still use `#reply`. It's an independent trigger from CLI `rotom ask`; both share the `ask_bridges` table + 5min timeout fallback.
- **Removed paths**: `rotom ask <gid> <target> <q>`, `rotom fed ask`, `rotom group create --a2a-direct`, `rotom group send --need-reply` are all deprecated. The `rotom-bus-host` skill is deleted.

Sections 1-5 below describe the 5min timeout fallback for async mode (and the `#reply` path); sync mode only applies to the "CLI blocks for reply" case and does NOT create an Issue on timeout.

## 1. One-liner

`rotom ask` = ask + auto-start a 5min timer. The system manages the timer; A doesn't need to cancel it manually.

- B @-replies A → A receives immediately (normal group message path); timer auto-cancels
- B replies without @ (but did send) → after 5min, the system creates an Issue for A with B's reply **restated** in the description
- 5min with no reply at all → the system creates an Issue for A telling A to @ a human for help
- B is offline → `rotom ask` refuses to create a bridge, exits 2, suggests A @ a human themselves

## 2. Command cheat sheet

```bash
# Ask + create bridge (most common)
rotom ask <groupId> <target> "<question>" [--timeout 5m] [--escalate-to <human>]

# List bridges in a group
rotom ask list --group <gid> [--status pending|answered|timed_out|cancelled] [--pretty]

# Bridge detail
rotom ask show <bridgeId>

# A manually cancels (received a non-@ reply, judged it as a reply)
rotom ask cancel <bridgeId>
```

## 3. Typical scenarios

### Scenario 1: B @-replies A (fast path)

```bash
# A is a frontend agent, needs the backend agent to confirm an API field
rotom ask 75457e4f-... backend-claude "what fields does the user/profile API return?" --escalate-to Alex
# stdout: {"bridgeId":"abc123...","questionMsgId":2560,"delivered":true,...}
```

A finishes this turn. The backend agent replies:

```
@frontend-claude fields=[id,name,avatar]
```

Master immediately dispatches this @-message to A's worker (normal group message path). A processes the reply and continues the task.

The next timer tick (≤30s) detects B @ A → marks the bridge `answered`. **No further action.**

### Scenario 2: B replies without @ (slow path, restated)

A asks as above. The backend agent replies (forgot to @):

```
fields=[id,name,avatar]
```

A's worker isn't triggered (no @). After 5min, the timer tick:

1. Queries group_messages: B has a reply after question_msg_id, but mentions don't include A
2. Creates an Issue for A:
   - Title: `[ask-bridge] backend-claude replied to your question`
   - Description:
     ```
     [system trigger: ask-bridge timeout restatement]
     At 2026-06-27T... in group "75457e4f-..." you asked backend-claude:
       "what fields does the user/profile API return?"

     backend-claude replied at 2026-06-27T... (didn't @ you):
       "fields=[id,name,avatar]"

     Continue the task based on this reply.
     Full history: rotom group history 75457e4f-... --limit 20
     When done: rotom issue complete <issueId>
     ```
   - assigned_to = A
3. master `pushIssueAssignment` dispatches the Issue to A's worker
4. A's worker is woken by the Issue (issue mode, can write to disk); sees the restated reply and continues
5. A runs `rotom issue complete <issueId>` when done

### Scenario 3: 5min with no reply (escalation)

A asks as above. The backend agent doesn't reply within 5min.

Timer tick:

1. Queries group_messages: no reply from B after question_msg_id
2. Creates an Issue for A:
   - Title: `[ask-bridge] backend-claude didn't reply, escalate`
   - Description:
     ```
     [system trigger: ask-bridge timeout escalation]
     At 2026-06-27T... in group "75457e4f-..." you asked backend-claude:
       "what fields does the user/profile API return?"

     backend-claude hasn't replied in 5min. Go to the group and @ Alex for help. Explain:
     - What you asked
     - How long you waited
     - What you tried (if any)

     After asking for help, run `rotom issue complete <issueId>` to close this Issue.
     ```
3. A is woken by the Issue, follows the instruction: `rotom group send <group> Alex "@Alex ...help..."`, then `rotom issue complete`

### Scenario 4: B is offline (precheck intercept)

```bash
rotom ask 75457e4f-... backend-claude "..." --escalate-to Alex
# stderr: rotom ask: target "backend-claude" is offline. Bridge not created. To escalate, run:
#           rotom group send 75457e4f-... Alex "@Alex backend-claude is offline, please step in"
# exit=2
```

Bridge not created. A decides whether to follow the suggestion and @ a human.

### Scenario 5: A manually cancels (received a non-@ reply, judged it as a reply)

```bash
# A asks
rotom ask 75457e4f-... backend-claude "..." --escalate-to Alex
# stdout: {"bridgeId":"abc123...",...}

# B replies "fields=[id,name,avatar]" (no @ A, but A is triggered by broadcast and sees it)
# A judges this is the reply, cancels manually:
rotom ask cancel abc123...
# stdout: {"ok":true}

# The timer no longer creates a restatement Issue
```

## 4. A's behavior conventions (already injected via skill prompt)

Every agent's prompt carries these two rules (`ROTOM_CLI_PROMPT`):

> - **When @-asked by another agent, @-mention the asker in your reply** — so the other party's ask-bridge timer can detect it immediately and cancel. A non-@ reply still gets recognized, but the other party has to wait 5min for the system's restatement to know you replied.
> - **When you're the task initiator asking another agent in the group, use `rotom ask` to start a timeout bridge**... Don't ask directly via `rotom group send` — that has no timeout escalation protection.

In short:
- **Always ask via `rotom ask`** — never directly via `rotom group send`
- **@-mention the asker when replying** — so their timer cancels immediately

## 5. State machine

```
        ┌──────────────────────┐
        │ A calls rotom ask     │
        │ (ask + create bridge) │
        └──────────┬───────────┘
                   ▼
              ┌─────────┐
              │ pending │
              └────┬────┘
                   │
       ┌───────────┼───────────────┬──────────────┐
       │           │               │              │
   B @ A        timeout          A manual       A retracts question
   (timer detects) 5min reached   cancel         (issue cancel)
       │           │               │              │
       ▼           ▼               ▼              ▼
   answered   check_replies   cancelled      cancelled
                   │
                   ├─ B has non-@ reply → create Issue @ A:
                   │   "[ask-bridge] B replied to your question"
                   │   description restates the reply
                   │
                   └─ B has no reply → create Issue @ A:
                       "[ask-bridge] B didn't reply, escalate"
                       description tells A to @ a human
```

## 6. Implementation cheat sheet

| Component | Location | Notes |
|-----------|----------|-------|
| Table | `migrations/034-ask-bridges.sql` | `ask_bridges` table + 3 indexes |
| DB methods | `src/master/db/ask-bridges.ts` | createAskBridge / getPendingAskBridges / findAtReplyForBridge / findLatestReplyForBridge / markBridgeAnswered / markBridgeTimedOut / cancelBridge / getGroupMessageContent |
| Scheduler scan | `src/master/scheduler.ts` `runBridgeTick()` | Scans pending bridges every 30s |
| Issue creation | `src/master/scheduler.ts` `createBridgeTimeoutIssue()` | Restatement / escalation templates |
| API | `src/master/api/groups.ts` `POST /groups/:id/asks` etc. | Auth via mesh token; asker = token's agent |
| CLI | `src/cli/ask.ts` | `rotom ask` / `list` / `show` / `cancel` |
| Inline prompt | `src/shared/rotom-cli-prompt.ts` `ROTOM_CLI_PROMPT` | Two rules injected into every agent's prompt |
| Skill doc | `skill/rotom-a2a-communicate/SKILL.md#timeout-escalation-mode` | Full usage notes (agent Read) |

## 7. How @-reply detection works

`findAtReplyForBridge` uses SQLite's `json_each` to parse `group_messages.mentions` JSON array:

```sql
SELECT m.* FROM group_messages m, json_each(m.mentions)
WHERE m.group_id = ?
  AND m.id > ?            -- after question_msg_id
  AND m.sender = ?        -- target = B
  AND json_each.value = ? -- mentions includes asker = A
ORDER BY m.id ASC LIMIT 1
```

The `mentions` field is a JSON array string (e.g. `["team-claude","Alex"]`), populated by master at `addGroupMessage` time via regex extraction of `@name` from message text. Exact match — no false positives from substrings.

## 8. Edge cases & handling

### 8.1 B @-replies at 4:59, timer ticks at 5:00

- 4:59 B @ A → master dispatches to A immediately; A processes the reply
- 5:00 timer tick → queries group_messages, finds @ → marks answered, no Issue created
- ✅ Normal

### 8.2 B @-replies at 5:01, timer already ticked at 5:00

- 5:00 timer tick → no @ reply → creates "no reply escalation" Issue for A
- 5:00:30 A woken by the Issue
- 5:01 B @ A → master dispatches normally → A woken again to process B's real reply
- ⚠️ A double-triggered: one escalation Issue, one B's real @ reply

**A's handling**: the escalation Issue description includes `rotom group history <group> --limit 5` so A can see B actually @-replied. A judges, runs `rotom issue complete` to close the escalation Issue, and continues with B's real reply.

### 8.3 B sent multiple non-@ replies

`findLatestReplyForBridge` takes the latest one (`ORDER BY id DESC LIMIT 1`), assuming the latest is the final answer. The Issue description includes `rotom group history` so A can run it for the full history.

### 8.4 Multiple pending bridges (A asks multiple B's concurrently)

Allowed. Each bridge has its own 5min timer; they don't affect each other. Timer scan cost is bounded (one SQL every 30s).

### 8.5 A manually cancels during pending

`rotom ask cancel <bridgeId>` marks the bridge `cancelled`; the timer no longer scans it; no Issue is created.

### 8.6 B is a human (`category=真人`)

`rotom ask` doesn't restrict target's category. Humans generally don't participate in issue claiming (existing constraint), so if the target is a human and A uses `rotom ask`, the timer still works — but human replies are usually @ A, going through the fast path.

## 9. Relationship to the old solution (wrapper script)

`scripts/rotom-ask-with-timeout.mjs` is the early wrapper-script approach (option A) — required B's reply to carry a `[reply]` marker and A to cancel manually. In practice, LLMs often didn't cooperate; it's been superseded by `rotom ask` (option C).

New code uses `rotom ask` exclusively. The wrapper script is kept as a fallback, not deleted.

## 10. Debugging & troubleshooting

### View all pending bridges

```bash
rotom ask list --group <gid> --status pending --pretty
```

### View a single bridge's detail

```bash
rotom ask show <bridgeId>
```

### View master logs

```bash
tail -f ~/.rotom/logs/mesh-master-$(date +%Y-%m-%d).log | grep -i "bridge\|ask-bridge"
```

The scheduler's bridge tick logs:
- `bridge tick: N pending bridge(s)` — every 30s
- `bridge #id answered: <target> @ <asker> (msg X)` — B @ A detected
- `bridge #id timed_out: issue <issueId> → <asker> (reply restated: msg X | no reply, escalate)` — timeout created Issue

### View system-created Issues

```bash
rotom issue list <groupId> --pretty
# Look for Issues with created_by="system:ask-bridge"
```

### Bridge stuck in pending

Possible causes:
1. Scheduler not running → check with `pnpm master:status`
2. B neither @-replied nor sent any message; bridge hasn't reached expires_at → wait
3. B @-replied but mentions parsing failed → check the `group_messages.mentions` field for A's name

## 11. Default config

| Item | Default | How to change |
|------|---------|---------------|
| Timeout | 5min | `rotom ask --timeout 10m` |
| Scheduler tick | 30s | `src/master/scheduler.ts` `TICK_MS` (requires master restart) |
| escalate_to | NULL (A picks) | `rotom ask --escalate-to <human>` |

---

## Appendix: full file manifest

| File | Purpose |
|------|---------|
| `migrations/034-ask-bridges.sql` | Table schema |
| `src/master/db/ask-bridges.ts` | DB methods |
| `src/master/db/types.ts` | `AskBridgeRow` type |
| `src/master/db/internal.ts` | Method registration |
| `src/master/db/core.ts` | `MeshDbSelf` interface extension |
| `src/master/db/index.ts` | Type exports |
| `src/master/scheduler.ts` | `runBridgeTick()` + `createBridgeTimeoutIssue()` |
| `src/master/api/groups.ts` | `POST /groups/:id/asks` and 3 other endpoints |
| `src/master/ws-hub/conversation.ts` | `sendAsAgent` returns `messageId` |
| `src/cli/ask.ts` | `rotom ask` subcommand |
| `src/cli/rotom.ts` | Registration + help text |
| `src/shared/rotom-cli-prompt.ts` | Inline prompt (c version) |
| `skill/rotom-a2a-communicate/SKILL.md` | Skill doc |
| `~/.rotom/SKILL.md` | Synced skill copy |
