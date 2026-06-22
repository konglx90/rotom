/**
 * Scheduler unit tests — covers:
 *   - migration 027 creates scheduled_tasks
 *   - DB CRUD: list/get/getDue/create/update/delete/reschedule/markRun/disable
 *   - Scheduler.dispatch:
 *       - message mode → posts to group
 *       - agent mode online → creates Issue + pushes to agent
 *       - agent mode offline → skipped (next_run_at still advanced)
 *       - agent mode + prev issue in_progress → skipped
 *       - once schedule_kind → auto-disable after run
 *       - repeat_times reached → auto-disable
 *       - grace fast-forward when stale
 *       - once expired → disable
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MeshDb } from "../src/master/db.js";
import { Scheduler, type SchedulerHub } from "../src/master/scheduler.js";

const TEST_DB = `/tmp/mesh-test-scheduler-${Date.now()}.db`;

let db: MeshDb;

// ── In-memory hub stub ─────────────────────────────────────────────────────
class StubHub implements SchedulerHub {
  postedToGroup: { groupId: string; content: string }[] = [];
  pushed: { issueId: string; agentName: string }[] = [];
  /** When set, pushIssueAssignment returns this instead of true. */
  pushShouldFail = false;

  postSystemToGroup(groupId: string, content: string): void {
    this.postedToGroup.push({ groupId, content });
  }

  pushIssueAssignment(issueId: string, agentName: string): boolean {
    if (this.pushShouldFail) return false;
    this.pushed.push({ issueId, agentName });
    return true;
  }
}

function makeAgent(name: string, status: "online" | "offline" = "online"): void {
  db.insertAgent({
    id: randomUUID(),
    name,
    tokenHash: "h",
    token: "t",
  });
  if (status === "online") {
    db.setAgentOnline(db.getAgentByName(name)!.id);
  }
}

/** 每个 dispatch 测试前清掉 scheduled_tasks,避免上轮测试的 due 任务残留干扰。 */
function clearScheduledTasks(): void {
  db.db.prepare("DELETE FROM scheduled_tasks").run();
}

describe("Scheduler", () => {
  before(() => {
    db = new MeshDb(TEST_DB);
  });

  after(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(`${TEST_DB}-shm`); } catch {}
    try { fs.unlinkSync(`${TEST_DB}-wal`); } catch {}
  });

  // ── Migration + basic CRUD ─────────────────────────────────────────────
  it("migration 027 creates scheduled_tasks", () => {
    const row = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'")
      .get() as { name: string } | undefined;
    assert.ok(row, "scheduled_tasks table should exist");
    const idx = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_scheduled_tasks_due'")
      .get() as { name: string } | undefined;
    assert.ok(idx, "idx_scheduled_tasks_due should exist");
  });

  it("interval task: createScheduledTask computes first next_run_at", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-int", "tester");
    const before = Date.now();
    const t = db.createScheduledTask({
      name: "every-30s",
      groupId,
      mode: "agent",
      agentName: "Alice",
      scheduleKind: "interval",
      intervalSec: 60,
      prompt: "tick",
    });
    const after = Date.now();
    assert.equal(t.schedule_kind, "interval");
    assert.equal(t.interval_sec, 60);
    assert.equal(t.repeat_count, 0);
    assert.equal(t.enabled, 1);
    assert.ok(t.next_run_at >= before + 60_000, "next_run_at should be ≥ now + 60s");
    assert.ok(t.next_run_at <= after + 60_000, "next_run_at should be ≤ now + 60s");
  });

  it("once task: next_run_at = run_at exactly", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-once", "tester");
    const target = Date.now() + 5_000;
    const t = db.createScheduledTask({
      name: "shoot-once",
      groupId,
      mode: "message",
      scheduleKind: "once",
      runAt: target,
      prompt: "hello",
    });
    assert.equal(t.next_run_at, target);
    assert.equal(t.run_at, target);
  });

  it("getDueScheduledTasks returns enabled tasks with next_run_at <= now", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-due", "tester");
    const past = Date.now() - 1_000;
    db.createScheduledTask({
      name: "due-now",
      groupId, mode: "message", scheduleKind: "once", runAt: past, prompt: "p",
    });
    const future = Date.now() + 60_000;
    db.createScheduledTask({
      name: "later",
      groupId, mode: "message", scheduleKind: "once", runAt: future, prompt: "p",
    });
    const due = db.getDueScheduledTasks(Date.now());
    const names = due.map((t) => t.name);
    assert.ok(names.includes("due-now"));
    assert.ok(!names.includes("later"));
  });

  it("updateScheduledTask with schedule change recomputes next_run_at", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-up", "tester");
    const t = db.createScheduledTask({
      name: "freq", groupId, mode: "message",
      scheduleKind: "interval", intervalSec: 60, prompt: "p",
    });
    const origNext = t.next_run_at;
    // bump to 120s; next_run_at should be roughly now+120s (>= origNext if clock advanced)
    const before = Date.now();
    const updated = db.updateScheduledTask(t.id, { intervalSec: 120 })!;
    const after = Date.now();
    assert.equal(updated.interval_sec, 120);
    assert.ok(updated.next_run_at >= before + 120_000);
    assert.ok(updated.next_run_at <= after + 120_000);
  });

  it("triggerScheduledTask sets next_run_at to now", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-trig", "tester");
    const t = db.createScheduledTask({
      name: "trig", groupId, mode: "message",
      scheduleKind: "interval", intervalSec: 3600, prompt: "p",
    });
    const before = Date.now();
    db.triggerScheduledTask(t.id);
    const after = Date.now();
    const reread = db.getScheduledTask(t.id)!;
    assert.ok(reread.next_run_at >= before && reread.next_run_at <= after);
  });

  // ── Scheduler dispatch ─────────────────────────────────────────────────
  it("message mode: posts to group, next_run_at advances, repeat_count increments", async () => {
    clearScheduledTasks();
    const groupId = randomUUID();
    db.createGroup(groupId, "g-msg", "tester");
    const hub = new StubHub();
    const sched = new Scheduler(db, hub);

    const t = db.createScheduledTask({
      name: "msg-tick", groupId, mode: "message",
      scheduleKind: "interval", intervalSec: 30, prompt: "整点报时",
    });
    // Move next_run_at to now so it's due
    db.rescheduleTask(t.id, Date.now() - 1);
    await sched["tick"]();

    const myPosts = hub.postedToGroup.filter((p) => p.groupId === groupId);
    assert.equal(myPosts.length, 1, "exactly one post to our group");
    assert.equal(myPosts[0].content, "整点报时");
    assert.equal(hub.pushed.length, 0, "message mode should not push issue");

    const after = db.getScheduledTask(t.id)!;
    assert.equal(after.last_status, "ok");
    assert.equal(after.repeat_count, 1);
    assert.ok(after.next_run_at > Date.now() - 100, "next_run_at should advance");
    assert.equal(after.enabled, 1, "interval with no repeat_times stays enabled");

    sched.stop();
  });

  it("agent mode online: creates Issue, pushes to agent", async () => {
    clearScheduledTasks();
    const groupId = randomUUID();
    db.createGroup(groupId, "g-agent", "tester");
    makeAgent("OnlineOne", "online");
    const hub = new StubHub();
    const sched = new Scheduler(db, hub);

    const t = db.createScheduledTask({
      name: "agent-tick", groupId, mode: "agent", agentName: "OnlineOne",
      scheduleKind: "interval", intervalSec: 30, prompt: "do thing",
    });
    db.rescheduleTask(t.id, Date.now() - 1);
    await sched["tick"]();

    assert.equal(hub.pushed.length, 1);
    assert.equal(hub.pushed[0].agentName, "OnlineOne");
    assert.equal(hub.postedToGroup.length, 0, "agent mode should not post to group");

    const after = db.getScheduledTask(t.id)!;
    assert.equal(after.last_status, "ok");
    assert.equal(after.repeat_count, 1);
    assert.ok(after.last_issue_id, "last_issue_id should be set");
    const issue = db.getIssueById(after.last_issue_id!)!;
    assert.ok(issue, "issue should be created in DB");
    assert.equal(issue.title, "[定时] agent-tick");
    assert.equal(issue.created_by, "system:scheduler");
    assert.equal(issue.description, "do thing");

    sched.stop();
  });

  it("agent mode offline: skipped, but next_run_at still advances", async () => {
    clearScheduledTasks();
    const groupId = randomUUID();
    db.createGroup(groupId, "g-off", "tester");
    makeAgent("OfflineOne", "offline");
    const hub = new StubHub();
    const sched = new Scheduler(db, hub);

    const t = db.createScheduledTask({
      name: "agent-off", groupId, mode: "agent", agentName: "OfflineOne",
      scheduleKind: "interval", intervalSec: 30, prompt: "p",
    });
    const origNext = Date.now() - 1;
    db.rescheduleTask(t.id, origNext);
    await sched["tick"]();

    assert.equal(hub.pushed.length, 0);
    const after = db.getScheduledTask(t.id)!;
    assert.equal(after.last_status, "skipped");
    assert.match(after.last_error ?? "", /offline|not found/);
    assert.equal(after.repeat_count, 1, "repeat_count still increments on skip");
    assert.ok(after.next_run_at > origNext, "next_run_at must advance even on skip");
    assert.equal(after.enabled, 1);

    sched.stop();
  });

  it("agent mode + prev issue in_progress: skipped, last_issue_id preserved for next round", async () => {
    clearScheduledTasks();
    const groupId = randomUUID();
    db.createGroup(groupId, "g-prev", "tester");
    makeAgent("Busy", "online");
    const hub = new StubHub();
    const sched = new Scheduler(db, hub);

    const t = db.createScheduledTask({
      name: "agent-busy", groupId, mode: "agent", agentName: "Busy",
      scheduleKind: "interval", intervalSec: 30, prompt: "p",
    });
    // Simulate previous round: an issue is still in_progress
    const prevIssueId = randomUUID();
    db.createIssue({
      id: prevIssueId,
      groupId,
      title: "[定时] agent-busy (prev)",
      createdBy: "system:scheduler",
    });
    db.updateIssueStatus(prevIssueId, "in_progress");
    db.markScheduledTaskRun(t.id, Date.now() - 5_000, "ok", null, prevIssueId, 1);

    db.rescheduleTask(t.id, Date.now() - 1);
    await sched["tick"]();

    assert.equal(hub.pushed.length, 0, "must not push a new issue while previous is still running");
    const after = db.getScheduledTask(t.id)!;
    assert.equal(after.last_status, "skipped");
    assert.match(after.last_error ?? "", /in_progress/);
    assert.equal(after.last_issue_id, prevIssueId, "last_issue_id preserved so next round keeps checking");

    // Second round: prev issue still in_progress → still skipped, still preserved
    db.rescheduleTask(t.id, Date.now() - 1);
    await sched["tick"]();
    const after2 = db.getScheduledTask(t.id)!;
    assert.equal(after2.last_status, "skipped");
    assert.equal(after2.last_issue_id, prevIssueId);
    assert.equal(hub.pushed.length, 0);

    // Third round: prev issue completes → next round dispatches a new issue
    db.updateIssueStatus(prevIssueId, "completed");
    db.rescheduleTask(t.id, Date.now() - 1);
    await sched["tick"]();
    assert.equal(hub.pushed.length, 1, "after prev completes, dispatch a new issue");
    const after3 = db.getScheduledTask(t.id)!;
    assert.equal(after3.last_status, "ok");
    assert.notEqual(after3.last_issue_id, prevIssueId, "last_issue_id now points to the new issue");

    sched.stop();
  });

  it("once task: auto-disable after run", async () => {
    clearScheduledTasks();
    const groupId = randomUUID();
    db.createGroup(groupId, "g-once-run", "tester");
    const hub = new StubHub();
    const sched = new Scheduler(db, hub);

    const t = db.createScheduledTask({
      name: "shoot", groupId, mode: "message",
      scheduleKind: "once", runAt: Date.now() - 100, prompt: "fire",
    });
    await sched["tick"]();

    const after = db.getScheduledTask(t.id)!;
    assert.equal(after.last_status, "ok");
    assert.equal(after.enabled, 0, "once task should disable itself");
    assert.equal(after.repeat_count, 1);

    sched.stop();
  });

  it("repeat_times reached: auto-disable", async () => {
    clearScheduledTasks();
    const groupId = randomUUID();
    db.createGroup(groupId, "g-rep", "tester");
    const hub = new StubHub();
    const sched = new Scheduler(db, hub);

    const t = db.createScheduledTask({
      name: "thrice", groupId, mode: "message",
      scheduleKind: "interval", intervalSec: 30, prompt: "p",
      repeatTimes: 3,
    });
    // Simulate already ran twice; this is the 3rd run
    db.markScheduledTaskRun(t.id, Date.now() - 60_000, "ok", null, null, 2);
    db.rescheduleTask(t.id, Date.now() - 1);
    await sched["tick"]();

    const after = db.getScheduledTask(t.id)!;
    assert.equal(after.last_status, "ok");
    assert.equal(after.repeat_count, 3);
    assert.equal(after.enabled, 0, "repeat_times reached → disabled");

    sched.stop();
  });

  it("grace fast-forward: stale recurring task jumps to next future slot, no run", async () => {
    clearScheduledTasks();
    const groupId = randomUUID();
    db.createGroup(groupId, "g-stale", "tester");
    const hub = new StubHub();
    const sched = new Scheduler(db, hub);

    const t = db.createScheduledTask({
      name: "stuck", groupId, mode: "message",
      scheduleKind: "interval", intervalSec: 60, prompt: "p",
    });
    // Backdate next_run_at by 10 minutes (well past the 60s/2=30s grace)
    const stale = Date.now() - 10 * 60 * 1000;
    db.rescheduleTask(t.id, stale);
    const beforeTick = Date.now();
    await sched["tick"]();

    const myPosts = hub.postedToGroup.filter((p) => p.groupId === groupId);
    assert.equal(myPosts.length, 0, "stale task should not run");
    const after = db.getScheduledTask(t.id)!;
    assert.ok(after.next_run_at >= beforeTick + 60_000 - 100, "next_run_at moved forward");
    assert.equal(after.repeat_count, 0, "repeat_count not bumped on fast-forward");
    assert.equal(after.last_status, null, "no run was recorded");

    sched.stop();
  });

  it("once expired past grace: disabled without running", async () => {
    clearScheduledTasks();
    const groupId = randomUUID();
    db.createGroup(groupId, "g-exp", "tester");
    const hub = new StubHub();
    const sched = new Scheduler(db, hub);

    const t = db.createScheduledTask({
      name: "expired", groupId, mode: "message",
      scheduleKind: "once", runAt: Date.now() - 10 * 60 * 1000, prompt: "p",
    });
    await sched["tick"]();

    const myPosts = hub.postedToGroup.filter((p) => p.groupId === groupId);
    assert.equal(myPosts.length, 0);
    const after = db.getScheduledTask(t.id)!;
    assert.equal(after.enabled, 0, "expired once task disabled");

    sched.stop();
  });

  it("pushIssueAssignment failure: marked as error, next_run_at still advanced", async () => {
    clearScheduledTasks();
    const groupId = randomUUID();
    db.createGroup(groupId, "g-push-fail", "tester");
    makeAgent("PushFail", "online");
    const hub = new StubHub();
    hub.pushShouldFail = true;
    const sched = new Scheduler(db, hub);

    const t = db.createScheduledTask({
      name: "push-fail", groupId, mode: "agent", agentName: "PushFail",
      scheduleKind: "interval", intervalSec: 30, prompt: "p",
    });
    db.rescheduleTask(t.id, Date.now() - 1);
    await sched["tick"]();

    const after = db.getScheduledTask(t.id)!;
    assert.equal(after.last_status, "error");
    assert.match(after.last_error ?? "", /pushIssueAssignment/);
    assert.equal(after.last_issue_id, null);
    assert.ok(after.next_run_at > Date.now() - 100);

    sched.stop();
  });
});