---
title: Agent-to-Agent Ask → Wait → Timeout
description: Design doc for the "wait for reply + timeout fallback" mechanism after Agent A asks B in a group
---

# Agent-to-Agent collaboration: ask → wait → timeout handling

> Design doc for the "wait for reply + timeout fallback" mechanism after Agent A asks B in a group.
> This doc captures several options that came up in discussion, their trade-offs, and the currently recommended direction.
> Implementation status is authoritative in code; this is a design snapshot.

## 1. Problem background

### 1.1 Current gap

In rotom group chat, when Agent A asks Agent B, there's only one primitive — `rotom group send` — and it's **fire-and-forget**:

- Returns immediately after sending; doesn't block or wait for reply
- The other party's reply arrives as a new group message, triggering A's worker's next round
- **No wall-clock timeout mechanism**
- **No auto-escalation to humans**

Two issues surfaced in practice:

**Issue 1: A forgot to use the wrapper**

Originally a wrapper script `scripts/rotom-ask-with-timeout.mjs` was designed; the skill doc told A to call it when asking, to start a 5min timer. In practice A (the LLM) often bypassed the wrapper and called `rotom group send` directly — the timer never started, timeout escalation failed.

**Issue 2: B didn't carry the `[reply]` marker**

The wrapper design required B's reply to start with `[reply]`; A's cancel logic identified replies by that marker. But B is also an LLM and doesn't always obey — in practice B often replied without the marker, causing A to misjudge "no reply" and falsely escalate to a human after 5min.

### 1.2 Design goals

- **A doesn't manually start a timer**: the system auto-creates the timer; A just asks
- **B doesn't have to cooperate**: B replies normally; no forced `[reply]` marker
- **Timeout fallback**: 5min without reply → auto-give A an actionable next step (read history / escalate to human)
- **In-group delivery**: all actions happen in the rotom group, no separate agent
- **Script-based detection**: reply detection uses deterministic logic (SQL query); no AI judgment of "was this a reply"

## 2. Option evolution

Three options came up; complexity increases, constraints on B decrease.

### Option A: Wrapper script (implemented, but ineffective)

**Idea**: A calls a wrapper script in bash; the wrapper does "ask + start scheduler timer" in two steps.

```
A's bash:
  node scripts/rotom-ask-with-timeout.mjs ask \
    --group <gid> --target <B> --question "<question>" --escalate-to <human>

wrapper internals:
  1. rotom directory checks if B is online; if offline, immediately @ human
  2. rotom group send <group> <B> "@<B> <question>(reply with [reply] prefix)"
  3. rotom schedule add --mode message --in 5m --name "ask-timeout-<B>"
     --prompt "@<human> 5min no reply from <B>, please step in"
  4. stdout: schedule id

After A receives B's reply:
  - If message starts with [reply] → run wrapper cancel subcommand to disable timer
  - Otherwise ignore, keep waiting
```

**Practical issues**:
- A often skips the wrapper and uses `rotom group send` directly (LLM makes its own decisions; skill doc isn't binding enough)
- B often omits the `[reply]` marker; A receives the reply but cancel doesn't fire; false escalation after 5min
- Even with inline-prompt reminders, A may still bypass

**When it works**: A is a highly-trusted agent (strong skill load, stable convention adherence); B likewise. Real LLM agents don't reach that stability.

**Status**: code shipped (`scripts/rotom-ask-with-timeout.mjs`); ineffective in practice; being replaced by Option C.

---

### Option B: Master-side `rotom ask` + bridge table + scheduler scan + auto-cancel (not implemented)

**Idea**: push the wrapper logic down to master; A calls one `rotom ask` subcommand; the system manages the timer. Reply detection shifts from "`[reply]` marker" to "did B @ A".

```
A calls:
  rotom ask <group> <B> "<question>" [--timeout 5m] [--escalate-to <human>]

master side:
  1. ask (existing group send; writes to group_messages)
  2. INSERT ask_bridges (id, group_id, asker=A, target=B,
     question_msg_id, expires_at=now+5min, status='pending')
  3. return bridge id

scheduler every 30s tick:
  for bridge in pending_bridges:
    # check if B @-mentioned A after the question
    reply = SELECT * FROM group_messages
            WHERE group_id=bridge.group_id
              AND id > bridge.question_msg_id
              AND sender = bridge.target
              AND mentions JSON contains bridge.asker
            ORDER BY id ASC LIMIT 1

    if reply:
      mark bridge answered (cancel, no escalation)
    elif bridge.expires_at < now:
      mark bridge timed_out
      hub.postSystemToGroup("@<human> 5min no reply from <B>...")
```

**Improvements over A**:
- A calls one command (`rotom ask`), no wrapper script
- Timer fully managed by master; A doesn't manually cancel
- Reply detection changed from `[reply]` marker to `mentions includes A` — B just needs to @

**Remaining issues**:
- **B doesn't @ → false escalation**: B replied but forgot @; timer doesn't detect; false escalation to human after 5min. Inherent to @ detection.
- **Escalation is mechanical**: timer directly @-mentions a human, no semantic judgment from A. B might have replied partially, or replied without @; timer escalates regardless, humans get spammed.
- **No "read recent messages then decide" middle state**: timer either cancels or escalates; no chance for A to "look at what happened in the group".

**When it works**: B strictly follows @ convention (strong skill load); escalation bar is low (humans don't mind false alarms).

**Status**: not implemented. Superseded by Option C.

---

### Option C: Bridge + timeout creates Issue restating the reply (currently recommended)

**Idea**: continue Option B's bridge table + scheduler scan, but **the timeout action doesn't directly escalate to a human** — instead, it creates an Issue for A. The Issue description:
- If B has a non-@ reply → **restates the reply content**; A continues based on the restatement
- If B has no reply at all → instructs A to @ a human for help

The "should we escalate to a human" judgment is returned to A (semantic judgment); the timer only does "5min is up, remind A to look".

```
A calls:
  rotom ask <group> <B> "<question>" [--timeout 5m] [--escalate-to <human>]

master side:
  1. ask (existing group send; writes to group_messages; record question_msg_id)
  2. INSERT ask_bridges (status='pending', expires_at=now+5min)
  3. return bridge id

A's worker receives group messages normally (no suppression):
  - B @ A → master dispatches to A normally; A processes immediately
  - B doesn't @ A → A isn't triggered (normal group message logic)

scheduler every 30s tick:
  for bridge in pending_bridges:
    # 1. First check if B @-mentioned A → auto cancel
    if exists group_messages where sender=B AND mentions includes A
                                     AND id > question_msg_id:
      mark bridge answered
      continue

    # 2. Timeout without @ → create Issue for A
    if bridge.expires_at < now:
      # check if B has any non-@ reply
      non_at_reply = SELECT * FROM group_messages
                     WHERE sender=B AND id > question_msg_id
                     ORDER BY id DESC LIMIT 1

      if non_at_reply:
        # Restate reply; create Issue
        issue.title = "B replied to your question"
        issue.description = """
          [system trigger: ask-bridge timeout restatement]
          At <created_at> in group <groupName> you asked <B>:
            "<question, truncated 200 chars>"

          <B> replied at <reply.created_at> (didn't @ you):
            "<reply.content, truncated 500 chars>"

          Continue the task based on this reply.
          Full history: rotom group history <groupId> --limit 20
          When done: rotom issue complete <issueId>
        """
      else:
        # No reply at all; instruct A to escalate
        issue.title = "B didn't reply, escalate"
        issue.description = """
          [system trigger: ask-bridge timeout escalation]
          At <created_at> in group <groupName> you asked <B>:
            "<question, truncated 200 chars>"

          <B> hasn't replied in 5min. Go to the group and @ <escalate_to> for help. Explain:
          - What you asked
          - How long you waited
          - What you tried (if any)

          After asking for help, run `rotom issue complete <issueId>` to close this Issue.
        """

      issue.assigned_to = A
      issue.created_by = "system:ask-bridge"
      mark bridge timed_out
      hub.pushIssueAssignment(issue.id, A)
```

#### Key design decisions

**1. @ is the cancel signal, but not the only reply path**

- B @ A → master dispatches to A normally (existing chat path) + timer detects @ and auto-cancels bridge
- B doesn't @ A → A isn't triggered in real time, but the timer at 5min finds the reply and restates it into an Issue

So @ is the "fast path" (real-time response); non-@ is the "slow path" (system restates after 5min).

**2. Timeout creates an Issue; doesn't send a system @ message**

| Item | System @ message | Issue (this option) |
|------|------------------|---------------------|
| Triggers A's worker | ✅ (chat path) | ✅ (issue dispatch path) |
| A can write to disk | ❌ (chat is read-only) | ✅ (issue has working_dir) |
| Has lifecycle | ❌ (message is one-shot) | ✅ (cancel/complete/append events) |
| Dashboard tracks | ❌ (buried in group message stream) | ✅ (board shows explicitly) |
| Reuses existing mechanism | ✅ | ✅ (`pushIssueAssignment`) |

The Issue path is heavier, but gives A full task context and Dashboard visibility.

**3. "Restate" is SQL copy, not AI summary**

`reply.content` is copied directly into the Issue description, possibly truncated to 500 chars. No LLM summary — keeps things deterministic, avoids summarization distortion.

**4. A is not suppressed**

A's worker receives group messages normally during bridge pending. If someone else in the group @-mentions A, A responds normally. The bridge only manages B's reply detection; it doesn't affect A's other interactions.

#### Edge cases

**Case 1: B @-mentions A at 4:59; timer ticks at 5:00**

- 4:59 B @ A → master dispatches to A immediately; A processes reply
- 5:00 timer tick → queries group_messages, finds @ → marks answered, no Issue created
- ✅ Normal; A processed the reply; bridge closed

**Case 2: B @-mentions A at 5:01; timer already ticked at 5:00**

- 5:00 timer tick → no @ reply → creates "no reply escalation" Issue for A
- 5:00:30 scheduler dispatches Issue → A's worker woken to handle the escalation Issue
- 5:01 B @ A → master dispatches normally → A's worker woken again to handle B's real reply
- ❌ A double-triggered: one escalation Issue, one B's real @ reply

**Mitigation** (TBD):
- (a) Timer re-queries group_messages right before creating the Issue (reduces race window, but 30s tick still has a gap)
- (b) After bridge timed_out, when B's @ message arrives, master detects the bridge state and doesn't dispatch to A (suppress B's @, but breaks normal group message semantics)
- (c) A's worker handles double-trigger itself: after seeing the escalation Issue, run `rotom group history` first to check if B actually replied; if so, ignore the escalation Issue

Leaning toward (c) — A is an AI, capable of judgment, and group message semantics stay intact. The Issue description can add "first run `rotom group history <group> --limit 5` to confirm B really didn't reply".

**Case 3: B sent multiple non-@ replies**

Take the latest one (`ORDER BY id DESC LIMIT 1`), assuming the latest is the final answer. Issue description includes the full history command; A can run it for the complete picture.

**Case 4: A manually cancels during pending**

A receives a non-@ reply from B, judges it as the reply, and proactively runs `rotom ask cancel <bridgeId>` to close the bridge; the timer no longer creates an Issue.

This gives A an escape hatch — "I saw it, no system intervention needed".

#### Trade-off summary

| Dimension | Option A (wrapper) | Option B (master + @ cancel) | Option C (bridge + Issue restatement) |
|-----------|--------------------|-------------------------------|----------------------------------------|
| A starts timer | ✅ (calls wrapper) | ❌ (auto) | ❌ (auto) |
| A manually cancels | ✅ (calls cancel) | ❌ (auto) | Optional (manual cancel) |
| B must cooperate | `[reply]` marker | @ A | @ A (fast path); non-@ also works (slow path) |
| Timeout action | Direct @ human | Direct @ human | Create Issue for A (restatement or escalation) |
| Escalation decision | timer (mechanical) | timer (mechanical) | A (semantic judgment) |
| False escalation when B doesn't @ | High (marker missing → misjudge) | High (@ missing → misjudge) | Low (restated into Issue, A judges) |
| Complexity | Low (script) | Medium (bridge table + scheduler change) | Medium-high (bridge table + scheduler change + Issue creation path) |
| Dashboard visibility | ❌ (timer in schedule list) | ❌ | ✅ (Issue appears on the board) |

## 3. Currently recommended: Option C

Reasons:
1. **Solves "A doesn't have to be active"**: A calls one `rotom ask`; the system manages the timer
2. **Solves "B doesn't have to cooperate"**: non-@ is still recognized (slow path); @ gets real-time response (fast path)
3. **Timeout escalation has semantic judgment**: A reads the Issue description (with restatement) and decides whether to truly escalate — reduces false human disturbance
4. **Reuses existing mechanism**: no new master → worker private push channel; Issue goes through the existing dispatch path
5. **Dashboard visible**: Issue appears on the board; humans can see A was woken by a timer

## 4. Open design points

### 4.1 Whether to keep `--escalate-to`

In Option C, escalation is A @-mentioning a human itself; does `rotom ask` still need `--escalate-to`?

- **Keep**: Issue description says "@ <escalate_to>"; A copies it. Simple but rigid.
- **Drop**: A picks an online `category=真人` agent in the group. Flexible but A might pick wrong or hesitate.

Leaning **keep** — at `rotom ask` time A knows who to find for this task; passing the info down is more deterministic.

### 4.2 Double-trigger handling (Case 2)

When A's worker receives both "no-reply escalation Issue" and "B's real @ reply" simultaneously?

Leaning toward (c): Issue description adds "first run `rotom group history <group> --limit 5` to confirm B really didn't reply; if they did, ignore this Issue and just `complete` it". Let A judge.

### 4.3 Which working_dir the Issue creates in

Issue needs working_dir. The bridge knows group_id and asker; can derive via `resolveGroupAgentWorkingDir(db, group_id, asker)` (existing logic). Same working dir as if A created the issue via `rotom issue create`.

### 4.4 Multiple pending bridges rate-limit

Can A have multiple pending bridges (asking multiple B's)?

- **Allow**: each bridge has independent 5min timer; no cross-effect. Complex but flexible.
- **Limit to 1**: A must ask serially. Simple but restrictive.

Leaning **allow** — A is an LLM, may ask multiple agents in parallel. Timer scan cost is bounded (one SQL every 30s).

### 4.5 Bridge audit & cleanup

How long to keep answered / timed_out / cancelled bridges?

- **Keep forever**: easy audit, but table grows
- **Clean after 7d**: use created_at + status index, periodic DELETE

Leaning **keep forever** + add `resolved_at` index; manually clean when needed. Bridge records are small; growth is manageable.

## 5. Implementation breakdown (Option C)

### 5.1 Data model

New table `ask_bridges` (migration 034):

```sql
CREATE TABLE ask_bridges (
  id              TEXT PRIMARY KEY,         -- uuid
  group_id        TEXT NOT NULL,
  asker           TEXT NOT NULL,            -- Agent A
  target          TEXT NOT NULL,            -- Agent B
  question_msg_id INTEGER NOT NULL,         -- A's question group_message id
  escalate_to     TEXT,                     -- human agent name; NULL = A picks
  timeout_ms      INTEGER NOT NULL,         -- default 300000
  created_at      INTEGER NOT NULL,         -- epoch ms
  expires_at      INTEGER NOT NULL,         -- created_at + timeout_ms
  status          TEXT NOT NULL,            -- pending / answered / timed_out / cancelled
  reply_msg_id    INTEGER,                  -- B's reply group_message id (if any)
  resolved_at     INTEGER,
  issue_id        TEXT,                     -- Timeout-created Issue id (if any)
  CHECK (status IN ('pending','answered','timed_out','cancelled'))
);
CREATE INDEX idx_ask_bridges_pending ON ask_bridges(expires_at) WHERE status = 'pending';
CREATE INDEX idx_ask_bridges_lookup ON ask_bridges(group_id, target, status);
```

### 5.2 DB layer

New module `src/master/db/ask-bridges.ts`, providing:

- `createAskBridge(input)`
- `getPendingAskBridges(now)` — for scheduler; only pending
- `findAtReplyForBridge(bridge)` — check if B @-mentioned A
- `findLatestNonAtReplyForBridge(bridge)` — on timeout, find B's non-@ reply
- `markBridgeAnswered(id, replyMsgId)`
- `markBridgeTimedOut(id, issueId)`
- `cancelBridge(id)` — A's manual cancel
- `getBridge(id)` / `listBridges(filter)` — for queries

### 5.3 Scheduler extension

Add a branch to `src/master/scheduler.ts` `tick()`:

```ts
// existing: scheduled_tasks
// new: ask_bridges
const pendingBridges = db.getPendingAskBridges(now);
for (const bridge of pendingBridges) {
  // 1. check @ reply → answered
  const atReply = db.findAtReplyForBridge(bridge);
  if (atReply) {
    db.markBridgeAnswered(bridge.id, atReply.id);
    continue;
  }
  // 2. timeout → create Issue + timed_out
  if (bridge.expires_at < now) {
    const nonAtReply = db.findLatestNonAtReplyForBridge(bridge);
    const issue = createBridgeTimeoutIssue(bridge, nonAtReply);
    db.markBridgeTimedOut(bridge.id, issue.id);
    hub.pushIssueAssignment(issue.id, bridge.asker);
  }
}
```

### 5.4 CLI

New subcommand `src/cli/ask.ts`:

```bash
# Ask + create bridge
rotom ask <groupId> <target> <question...> \
  [--timeout 5m] \
  [--escalate-to <human>]

# Query
rotom ask list [--group <gid>] [--status pending]

# Manual cancel
rotom ask cancel <bridgeId>
```

`rotom ask` internals:
1. `rotom directory` checks target is online; if offline, immediately `rotom group send` to escalate-to, exit 2, no bridge
2. `rotom group send <group> <target> "@<target> <question>"` asks; record question_msg_id from response
3. `INSERT ask_bridges` to create the record
4. stdout: bridge id; exit 0

### 5.5 Skill prompt

Replace the wrapper section with:

```
- To ask another agent, use `rotom ask <group> <target> "<question>" --escalate-to <human>`:
  The system auto-starts a 5min timeout timer; no manual management needed.
  - They @-reply you → you receive immediately (normal group message path); timer auto-cancels
  - They reply without @ → after 5min, the system creates an Issue for you, with their reply restated in the description; continue based on the reply
  - 5min with no reply → the system creates an Issue telling you to @ a human for help
- When replying to someone's question, **@-mention the asker** so their timer detects it immediately and cancels.
  A non-@ reply is still recognized, but the asker has to wait 5min for the system's restatement to know you replied.
```

### 5.6 Issue description templates

**When there's a non-@ reply** (restatement template):

```
[system trigger: ask-bridge timeout restatement]
At <created_at> in group "<groupName>" you asked <B>:
  "<question, truncated 200 chars>"

<B> replied at <reply.created_at> (didn't @ you):
  "<reply.content, truncated 500 chars>"

Continue the task based on this reply.
Full history: rotom group history <groupId> --limit 20
When done: rotom issue complete <issueId>
```

**When there's no reply at all** (escalation template):

```
[system trigger: ask-bridge timeout escalation]
At <created_at> in group "<groupName>" you asked <B>:
  "<question, truncated 200 chars>"

<B> hasn't replied in 5min. Go to the group and @ <escalate_to> for help. Explain:
- What you asked
- How long you waited
- What you tried (if any)

After asking for help, run `rotom issue complete <issueId>` to close this Issue.
```

## 6. Relationship to existing Option A (wrapper)

Option A code is shipped:
- `scripts/rotom-ask-with-timeout.mjs`
- `skill/rotom-a2a-communicate/SKILL.md#timeout-escalation-mode`
- `src/shared/rotom-cli-prompt.ts` wrapper prompt

After implementing Option C:
- **Keep** the wrapper script as fallback (A's active scenario)
- **Update** skill doc: Option C is primary; wrapper is alternative
- **Update** inline prompt: replace wrapper prompt with `rotom ask` prompt

Or deprecate the wrapper entirely and switch fully to Option C. Decide based on real-world results.

## 7. Open questions

- **B @-mentions A but A's worker didn't respond** (A offline / stuck): timer tick detects @, marks answered, but A actually didn't process. Bridge closes; A didn't act. Need extra mechanism to detect "A really processed the reply"?
- **Multiple B's asked concurrently**: A asks B1 and B2 simultaneously; two bridges pending in parallel. Timer scans both, handles separately. OK, but make sure Issue creation doesn't conflict.
- **B is a human**: `category=真人` agents don't participate in issue claiming (existing constraint). Can A use `rotom ask` against a human? Or should it go through another path?
- **Bridge state query API**: does Dashboard need to show pending bridges? Convenient for humans to see "A is waiting for B".

---

## Revision history

- 2026-06-27: initial draft. Captured Options A/B/C; recommended Option C.
