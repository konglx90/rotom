/**
 * Unit test — enrichWorkerDispatch group-level profile override merge.
 *
 * Verifies that when a (group, agent) has a profile override in
 * group_member_settings.profile, dispatch-enrich merges it onto the
 * agent's global profile (group-level fields win) before injecting into
 * the WS message.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { MeshDb } from "../src/master/db.js";
import { enrichWorkerDispatch } from "../src/master/ws-hub/dispatch-enrich.js";
import type { ServerIssueAssignedMessage } from "../src/shared/protocol.js";

const TEST_DB = `/tmp/mesh-test-dispatch-${Date.now()}.db`;
let db: MeshDb;

describe("enrichWorkerDispatch: group-level profile override", () => {
  before(() => {
    db = new MeshDb(TEST_DB);
  });
  after(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  function setupAgent(name: string, profile: Record<string, unknown> | null) {
    const existing = db.getAgentByName(name);
    if (existing) return existing.id;
    const id = randomUUID();
    db.insertAgent({
      id,
      name,
      domain: "test",
      tokenHash: `hash_${id}`,
      token: `mesh_${id}`,
      profile: profile ? JSON.stringify(profile) : null,
    });
    return id;
  }

  it("group-level profile overrides agent global profile (per-field)", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-dispatch", "tester");
    db.addGroupMembers(groupId, ["Alice"]);
    setupAgent("Alice", { position: "前端", bio: "5年前端", category: "普通" });

    // No override yet → global profile flows through
    const base = { type: "issue_assigned", issueId: "i1", groupId, title: "t", description: "d" } as ServerIssueAssignedMessage;
    const out1 = enrichWorkerDispatch({ db }, base, "Alice", groupId);
    assert.equal(out1.agentProfile?.position, "前端");
    assert.equal(out1.agentProfile?.bio, "5年前端");
    assert.equal(out1.agentProfile?.category, "普通");

    // Set group override: position only, bio/category should inherit from global
    db.upsertGroupMemberProfile(groupId, "Alice", JSON.stringify({ position: "后端" }));
    const out2 = enrichWorkerDispatch({ db }, base, "Alice", groupId);
    assert.equal(out2.agentProfile?.position, "后端", "group-level position wins");
    assert.equal(out2.agentProfile?.bio, "5年前端", "global bio inherited");
    assert.equal(out2.agentProfile?.category, "普通", "global category inherited");

    // Set full override: bio also overridden
    db.upsertGroupMemberProfile(groupId, "Alice", JSON.stringify({ position: "后端", bio: "转后端中" }));
    const out3 = enrichWorkerDispatch({ db }, base, "Alice", groupId);
    assert.equal(out3.agentProfile?.position, "后端");
    assert.equal(out3.agentProfile?.bio, "转后端中");

    // Clear override → back to global
    db.upsertGroupMemberProfile(groupId, "Alice", null);
    const out4 = enrichWorkerDispatch({ db }, base, "Alice", groupId);
    assert.equal(out4.agentProfile?.position, "前端");
    assert.equal(out4.agentProfile?.bio, "5年前端");
  });

  it("group with no override returns global profile unchanged", () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-no-override", "tester");
    db.addGroupMembers(groupId, ["Bob"]);
    setupAgent("Bob", { position: "PM" });

    const base = { type: "issue_assigned", issueId: "i2", groupId, title: "t", description: "d" } as ServerIssueAssignedMessage;
    const out = enrichWorkerDispatch({ db }, base, "Bob", groupId);
    assert.equal(out.agentProfile?.position, "PM");
    assert.equal(out.agentProfile?.bio, undefined);
  });

  it("groupId missing → no group override applied, global profile only", () => {
    setupAgent("Carol", { position: "Dev" });
    const base = { type: "issue_assigned", issueId: "i3", title: "t", description: "d" } as ServerIssueAssignedMessage;
    const out = enrichWorkerDispatch({ db }, base, "Carol", undefined);
    assert.equal(out.agentProfile?.position, "Dev");
  });
});
