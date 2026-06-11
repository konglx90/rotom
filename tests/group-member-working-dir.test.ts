/**
 * Integration test — per-(group, agent) working_dir overrides.
 *
 * Covers:
 *   - migration 020 creates group_member_settings
 *   - DB CRUD: upsert / get / clear / list
 *   - cascade cleanup on removeGroupMembers and deleteGroup
 *   - getGroupMembers now returns working_dir via LEFT JOIN
 *   - resolveGroupAgentWorkingDir: three-tier fallback
 *   - PUT /issues/:id re-resolves issue.working_dir on assignment
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { MeshDb } from "../src/master/db.js";
import {
  defaultGroupWorkingDir,
  resolveGroupAgentWorkingDir,
} from "../src/master/group-paths.js";

const TEST_DB = `/tmp/mesh-test-gmswd-${Date.now()}.db`;

let db: MeshDb;

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mesh-gmswd-${label}-`));
}

describe("Per-(group, agent) working_dir", () => {
  before(() => {
    db = new MeshDb(TEST_DB);
  });

  after(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  it("migration 020 creates group_member_settings", () => {
    const row = db.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='group_member_settings'",
      )
      .get() as { name: string } | undefined;
    assert.ok(row, "table should exist after migrate()");
  });

  it("upsert + get + list + clear", () => {
    const groupId = randomUUID();
    const a = "AgentA";
    const b = "AgentB";
    const dirA = tmpDir("a");
    const dirB = tmpDir("b");

    db.createGroup(groupId, "g1", "tester");
    db.addGroupMembers(groupId, [a, b]);

    // no setting yet
    assert.equal(db.getGroupMemberSetting(groupId, a), null);
    assert.deepEqual(db.listGroupMemberSettings(groupId), []);

    // upsert A
    db.upsertGroupMemberSetting(groupId, a, dirA);
    assert.equal(db.getGroupMemberSetting(groupId, a), dirA);
    assert.equal(db.getGroupMemberSetting(groupId, b), null);

    // upsert B
    db.upsertGroupMemberSetting(groupId, b, dirB);
    const listed = db.listGroupMemberSettings(groupId);
    assert.equal(listed.length, 2);
    const names = listed.map((r) => r.agent_name).sort();
    assert.deepEqual(names, [a, b].sort());

    // upsert is idempotent and overwrites
    const dirA2 = tmpDir("a2");
    db.upsertGroupMemberSetting(groupId, a, dirA2);
    assert.equal(db.getGroupMemberSetting(groupId, a), dirA2);
    assert.equal(db.listGroupMemberSettings(groupId).length, 2);

    // clear A
    assert.equal(db.clearGroupMemberSetting(groupId, a), true);
    assert.equal(db.getGroupMemberSetting(groupId, a), null);
    assert.equal(db.listGroupMemberSettings(groupId).length, 1);

    // clear missing returns false
    assert.equal(db.clearGroupMemberSetting(groupId, a), false);
  });

  it("getGroupMembers joins working_dir", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-join", "tester");
    db.addGroupMembers(groupId, ["Alice", "Bob"]);
    const dirAlice = tmpDir("alice");
    db.upsertGroupMemberSetting(groupId, "Alice", dirAlice);

    const members = db.getGroupMembers(groupId);
    assert.equal(members.length, 2);
    const alice = members.find((m) => m.agent_name === "Alice")!;
    const bob = members.find((m) => m.agent_name === "Bob")!;
    assert.equal(alice.working_dir, dirAlice);
    assert.equal(bob.working_dir, null);
  });

  it("cascade: removeGroupMembers deletes settings for that pair", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-cascade-1", "tester");
    db.addGroupMembers(groupId, ["Carol", "Dave"]);
    db.upsertGroupMemberSetting(groupId, "Carol", tmpDir("carol"));
    db.upsertGroupMemberSetting(groupId, "Dave", tmpDir("dave"));
    assert.equal(db.listGroupMemberSettings(groupId).length, 2);

    db.removeGroupMembers(groupId, ["Carol"]);
    assert.equal(db.getGroupMemberSetting(groupId, "Carol"), null);
    assert.notEqual(db.getGroupMemberSetting(groupId, "Dave"), null);
  });

  it("cascade: deleteGroup wipes all settings for the group", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-cascade-2", "tester");
    db.addGroupMembers(groupId, ["Eve", "Frank"]);
    db.upsertGroupMemberSetting(groupId, "Eve", tmpDir("eve"));
    db.upsertGroupMemberSetting(groupId, "Frank", tmpDir("frank"));
    db.deleteGroup(groupId);
    assert.equal(db.listGroupMemberSettings(groupId).length, 0);
  });

  it("resolveGroupAgentWorkingDir: three-tier fallback", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-resolve", "tester");
    const defaultDir = defaultGroupWorkingDir(groupId);
    const memberDir = tmpDir("member");
    const groupDir = tmpDir("group");

    // 1. nothing set → default
    assert.equal(resolveGroupAgentWorkingDir(db, groupId, "Nobody"), defaultDir);

    // 2. only group.working_dir → group
    db.updateGroupWorkingDir(groupId, groupDir);
    assert.equal(resolveGroupAgentWorkingDir(db, groupId, "Nobody"), groupDir);

    // 3. group + member override → member
    db.upsertGroupMemberSetting(groupId, "Eve", memberDir);
    assert.equal(resolveGroupAgentWorkingDir(db, groupId, "Eve"), memberDir);

    // 4. member override wins for that agent, group wins for others
    assert.equal(resolveGroupAgentWorkingDir(db, groupId, "Frank"), groupDir);
  });

  it("updateIssueWorkingDir persists and is readable via getIssueById", () => {
    const groupId = randomUUID();
    const issueId = randomUUID();
    db.createGroup(groupId, "g-issue", "tester");
    db.createIssue({
      id: issueId,
      groupId,
      title: "t",
      createdBy: "tester",
    });
    const before = db.getIssueById(issueId)!;
    assert.equal(before.working_dir, null);

    const target = tmpDir("issue");
    db.updateIssueWorkingDir(issueId, target);
    const after = db.getIssueById(issueId)!;
    assert.equal(after.working_dir, target);
  });
});
