/**
 * Integration test — per-(group, agent) profile overrides.
 *
 * Covers migration 032 (group_member_settings.profile column) and the
 * merge semantics in dispatch-enrich: group-level fields win over the
 * agent's global profile.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { MeshDb } from "../src/master/db.js";
import { parseAgentProfile } from "../src/shared/agent-profile.js";

const TEST_DB = `/tmp/mesh-test-gmsprof-${Date.now()}.db`;

let db: MeshDb;

describe("Per-(group, agent) profile override", () => {
  before(() => {
    db = new MeshDb(TEST_DB);
  });

  after(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  it("migration 032 adds profile column to group_member_settings", () => {
    const row = db.db
      .prepare("PRAGMA table_info(group_member_settings)")
      .all() as Array<{ name: string }>;
    const cols = row.map((r) => r.name);
    assert.ok(cols.includes("profile"), `expected profile column, got ${JSON.stringify(cols)}`);
  });

  it("upsertGroupMemberProfile + getGroupMemberProfile round-trip", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-prof", "tester");
    db.addGroupMembers(groupId, ["Alice", "Bob"]);

    // initially null
    assert.equal(db.getGroupMemberProfile(groupId, "Alice"), null);

    // upsert a profile
    const prof = JSON.stringify({ position: "后端", bio: "转后端中" });
    db.upsertGroupMemberProfile(groupId, "Alice", prof);
    assert.equal(db.getGroupMemberProfile(groupId, "Alice"), prof);
    assert.equal(db.getGroupMemberProfile(groupId, "Bob"), null);

    // overwrite
    const prof2 = JSON.stringify({ position: "全栈" });
    db.upsertGroupMemberProfile(groupId, "Alice", prof2);
    assert.equal(db.getGroupMemberProfile(groupId, "Alice"), prof2);

    // clear via null
    db.upsertGroupMemberProfile(groupId, "Alice", null);
    assert.equal(db.getGroupMemberProfile(groupId, "Alice"), null);
  });

  it("upsertGroupMemberProfile works even when no prior settings row exists", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-prof-fresh", "tester");
    db.addGroupMembers(groupId, ["Carol"]);
    // No working_dir set yet — INSERT path should still write profile.
    const prof = JSON.stringify({ position: "前端" });
    db.upsertGroupMemberProfile(groupId, "Carol", prof);
    assert.equal(db.getGroupMemberProfile(groupId, "Carol"), prof);
    // working_dir column should still be NULL (not clobbered to empty)
    const setting = db.getGroupMemberSetting(groupId, "Carol");
    assert.equal(setting, null, "working_dir should still be null");
  });

  it("listGroupMemberSettings returns profile column", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-prof-list", "tester");
    db.addGroupMembers(groupId, ["Dave", "Eve"]);
    db.upsertGroupMemberProfile(groupId, "Dave", JSON.stringify({ bio: "hi" }));
    const listed = db.listGroupMemberSettings(groupId);
    const dave = listed.find((r) => r.agent_name === "Dave")!;
    assert.ok(dave.profile);
    assert.deepEqual(JSON.parse(dave.profile!), { bio: "hi" });
  });

  it("getGroupMembers returns profile via LEFT JOIN", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-prof-join", "tester");
    db.addGroupMembers(groupId, ["Frank", "Grace"]);
    db.upsertGroupMemberProfile(groupId, "Frank", JSON.stringify({ position: "前端" }));
    const members = db.getGroupMembers(groupId);
    const frank = members.find((m) => m.agent_name === "Frank")!;
    const grace = members.find((m) => m.agent_name === "Grace")!;
    assert.deepEqual(JSON.parse(frank.profile!), { position: "前端" });
    assert.equal(grace.profile, null);
  });

  it("cascade: removeGroupMembers wipes profile for that pair", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-prof-cascade", "tester");
    db.addGroupMembers(groupId, ["Heidi", "Ivan"]);
    db.upsertGroupMemberProfile(groupId, "Heidi", JSON.stringify({ position: "x" }));
    db.removeGroupMembers(groupId, ["Heidi"]);
    assert.equal(db.getGroupMemberProfile(groupId, "Heidi"), null);
  });

  it("parseAgentProfile only keeps position/bio/category (drops legacy keys)", () => {
    // 旧 profile JSON 含 tech_stack / responsibilities, parseAgentProfile 应忽略。
    const legacy = JSON.stringify({
      position: "前端",
      responsibilities: "旧字段",
      tech_stack: "React",
      bio: "新简介",
      category: "真人",
    });
    const parsed = parseAgentProfile(legacy)!;
    assert.equal(parsed.position, "前端");
    assert.equal(parsed.bio, "新简介");
    assert.equal(parsed.category, "真人");
    assert.equal((parsed as Record<string, unknown>).responsibilities, undefined);
    assert.equal((parsed as Record<string, unknown>).tech_stack, undefined);
  });
});
