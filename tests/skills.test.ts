/**
 * Unit test — Skills(agent_skills + agent_skill_bindings)
 *
 * Covers:
 *   - createSkill + getSkill(查全文 + view_count +1)
 *   - listSkills / searchSkills(LIKE 匹配 name/description/category/content)
 *   - updateSkill / deactivateSkill
 *   - bindSkill(UNIQUE 防重)+ unbindSkill + listBindings
 *   - countSkillsForAgent / listSkillsForAgent(per-agent 隔离)
 *   - 软删除 skill 后,count/listForAgent 不返回(deactivate 过滤)
 *   - promoteMemoryToSkill:playbook memory → skill,source_ref 指向 memory_id
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { MeshDb } from "../src/master/db.js";

const TEST_DB = `/tmp/mesh-test-skills-${Date.now()}.db`;
const GROUP_A = "grp-sk-a-" + randomUUID().slice(0, 8);
const GROUP_B = "grp-sk-b-" + randomUUID().slice(0, 8);

let db: MeshDb;

describe("Skills (agent_skills + bindings)", () => {
  before(() => {
    db = new MeshDb(TEST_DB);
    db.createGroup(GROUP_A, "GroupA", "system");
    db.createGroup(GROUP_B, "GroupB", "system");
  });

  after(() => {
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + "-wal"); } catch {}
    try { fs.unlinkSync(TEST_DB + "-shm"); } catch {}
  });

  // ── createSkill + getSkill ──────────────────────────────────────────────
  it("createSkill + getSkill: 写入 + 查全文 + view_count +1", () => {
    const id = randomUUID();
    db.createSkill({
      id, name: "release-flow", description: "发布流程",
      content: "1.bump 2.changelog 3.tag", category: "workflow",
      createdBy: "AgentA",
    });
    const row = db.getSkill(id);
    assert.ok(row);
    assert.equal(row!.name, "release-flow");
    assert.equal(row!.content, "1.bump 2.changelog 3.tag");
    // getSkill 内部 view_count+1(返回的是 +1 前快照,重新查一次验证)
    const after = db.getSkillByName("release-flow");
    assert.ok(after!.view_count >= 1);
  });

  it("getSkillByName: 按 name 查", () => {
    const row = db.getSkillByName("release-flow");
    assert.ok(row);
    assert.equal(row!.description, "发布流程");
  });

  // ── listSkills / searchSkills ───────────────────────────────────────────
  it("listSkills: 默认只返回 active", () => {
    db.createSkill({ id: randomUUID(), name: "debug-auth", description: "鉴权排查", content: "x", createdBy: "A" });
    const list = db.listSkills();
    assert.ok(list.some(s => s.name === "release-flow"));
    assert.ok(list.some(s => s.name === "debug-auth"));
    // 不含 content
    assert.equal(list.find(s => s.name === "release-flow")!.content, undefined);
  });

  it("searchSkills: LIKE 匹配 name/description/content", () => {
    assert.ok(db.searchSkills("release").some(s => s.name === "release-flow"));
    assert.ok(db.searchSkills("发布").some(s => s.name === "release-flow"));  // description
    assert.ok(db.searchSkills("changelog").some(s => s.name === "release-flow"));  // content
    assert.ok(db.searchSkills("鉴权").some(s => s.name === "debug-auth"));  // description
    assert.equal(db.searchSkills("不存在的关键词").length, 0);
  });

  // ── updateSkill ─────────────────────────────────────────────────────────
  it("updateSkill: 改 description/category", () => {
    const row = db.getSkillByName("release-flow");
    db.updateSkill(row!.id, { description: "新版发布流程", category: "release" });
    const updated = db.getSkillByName("release-flow");
    assert.equal(updated!.description, "新版发布流程");
    assert.equal(updated!.category, "release");
  });

  // ── 绑定关系 ────────────────────────────────────────────────────────────
  it("bindSkill: 写入绑定,UNIQUE 防重", () => {
    const s = db.getSkillByName("release-flow");
    const created1 = db.bindSkill({ groupId: GROUP_A, agentName: "阿甘", skillId: s!.id, createdBy: "西花" });
    assert.equal(created1, true);
    // 重复绑定 → ignore,changes=0
    const created2 = db.bindSkill({ groupId: GROUP_A, agentName: "阿甘", skillId: s!.id, createdBy: "西花" });
    assert.equal(created2, false);
  });

  it("countSkillsForAgent / listSkillsForAgent: 该 agent 在该群绑定的 skill", () => {
    const cnt = db.countSkillsForAgent(GROUP_A, "阿甘");
    assert.equal(cnt, 1);
    const list = db.listSkillsForAgent(GROUP_A, "阿甘");
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "release-flow");
  });

  it("隔离: agent B 不绑 → count=0;群 B 不绑 → count=0", () => {
    assert.equal(db.countSkillsForAgent(GROUP_A, "AgentB"), 0);
    assert.equal(db.countSkillsForAgent(GROUP_B, "阿甘"), 0);
  });

  it("listBindings: 按 groupId / agentName 过滤", () => {
    const inA = db.listBindings({ groupId: GROUP_A });
    assert.equal(inA.length, 1);
    const forAgent = db.listBindings({ groupId: GROUP_A, agentName: "阿甘" });
    assert.equal(forAgent.length, 1);
    assert.equal(db.listBindings({ groupId: GROUP_A, agentName: "AgentB" }).length, 0);
  });

  it("unbindSkill: 删除绑定", () => {
    const s = db.getSkillByName("release-flow");
    const removed = db.unbindSkill({ groupId: GROUP_A, agentName: "阿甘", skillId: s!.id });
    assert.equal(removed, true);
    assert.equal(db.countSkillsForAgent(GROUP_A, "阿甘"), 0);
  });

  // ── 软删除 skill 后绑定过滤 ──────────────────────────────────────────────
  it("deactivateSkill: 软删除后 list/count 不返回,绑定表保留", () => {
    const sid = randomUUID();
    db.createSkill({ id: sid, name: "to-deactivate", description: "x", content: "x", createdBy: "A" });
    db.bindSkill({ groupId: GROUP_A, agentName: "阿甘", skillId: sid, createdBy: "西花" });
    assert.equal(db.countSkillsForAgent(GROUP_A, "阿甘"), 1);
    db.deactivateSkill(sid);
    // deactivate 后 count/listForAgent 不返回
    assert.equal(db.countSkillsForAgent(GROUP_A, "阿甘"), 0);
    assert.equal(db.listSkillsForAgent(GROUP_A, "阿甘").length, 0);
    // 绑定表行还在(listBindings 不过滤 active)
    assert.equal(db.listBindings({ groupId: GROUP_A, agentName: "阿甘" }).length, 1);
    // listSkills 默认 activeOnly 不返回
    assert.equal(db.listSkills().some(s => s.name === "to-deactivate"), false);
  });

  // ── promoteMemoryToSkill ────────────────────────────────────────────────
  it("promoteMemoryToSkill: playbook memory → skill,source_ref 指向 memory", () => {
    const memId = randomUUID();
    db.addMemory({
      id: memId, scope: "global", groupId: null, category: "playbook",
      key: "deploy-flow", value: "完整发布步骤长文", summary: "发布流程摘要",
      // 全局 + agent 可见须走 pending review(addMemory 硬约束);promote 只读 value/key/summary,可见性无关。
      agentVisible: false, createdBy: "AgentA",
    });
    const { skillId, name } = db.promoteMemoryToSkill(memId, { createdBy: "西花" });
    assert.equal(name, "deploy-flow");
    const skill = db.getSkill(skillId);
    assert.ok(skill);
    assert.equal(skill!.source_type, "promoted");
    assert.equal(skill!.source_ref, memId);
    assert.equal(skill!.content, "完整发布步骤长文");
    assert.equal(skill!.description, "发布流程摘要");
    assert.equal(skill!.category, "playbook");
    // 原 memory 仍 active
    const mem = db.getMemory(memId);
    assert.equal(mem!.active, 1);
  });
});
