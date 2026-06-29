/**
 * Unit test — Memory(agent_memory 表)
 *
 * Covers:
 *   - addMemory + getMemory(完整 value 返回)
 *   - listMemory: scope/category/key/tags/type(note|memory|all) 过滤
 *   - searchMemory: LIKE 匹配 key/value/summary/tags;强制 agent_visible=1
 *   - note 隔离:agent_visible=0 的 note,search/get(agent 路径)搜不到
 *   - pending_review 隔离:search 不返回 pending
 *   - countMemory: 只算 agent_visible=1 active 非 pending
 *   - view_count(injected_count=search 命中 +1,view_count=get +1)
 *   - promoteMemoryVisibility: group → global,group_id=NULL
 *   - approveMemory: pending_review=0 + agent_visible=1
 *   - memoryStats: byCategory / byAgentVisible / topViewed
 *   - 旧 note 兼容(createNote 写的 note,agent_visible=0,search 搜不到)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { MeshDb } from "../src/master/db.js";

const TEST_DB = `/tmp/mesh-test-memory-${Date.now()}.db`;
const GROUP_A = "grp-a-" + randomUUID().slice(0, 8);
const GROUP_B = "grp-b-" + randomUUID().slice(0, 8);

let db: MeshDb;

describe("Memory (agent_memory)", () => {
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

  // ── addMemory + getMemory ────────────────────────────────────────────────
  it("addMemory + getMemory: 写入 + 读完整 value", () => {
    const id = randomUUID();
    db.addMemory({
      id, scope: "group", groupId: GROUP_A,
      category: "fact", key: "tech_stack", value: "TypeScript + pnpm",
      summary: "技术栈", tags: ["backend", "ts"],
      agentVisible: true, createdBy: "AgentA",
    });
    const row = db.getMemory(id);
    assert.ok(row);
    assert.equal(row!.key, "tech_stack");
    assert.equal(row!.value, "TypeScript + pnpm");
    assert.equal(row!.category, "fact");
    assert.equal(row!.agent_visible, 1);
    assert.equal(row!.pending_review, 0);
    assert.deepEqual(JSON.parse(row!.tags), ["backend", "ts"]);
  });

  it("addMemory: summary 缺省取 value 前 80 字符", () => {
    const id = randomUUID();
    const longVal = "x".repeat(120);
    db.addMemory({ id, scope: "group", groupId: GROUP_A, category: "fact", key: "k", value: longVal, agentVisible: true, createdBy: "A" });
    const row = db.getMemory(id);
    assert.equal(row!.summary, "x".repeat(80));
  });

  // ── listMemory: type 过滤 ────────────────────────────────────────────────
  it("listMemory: type=memory 只返回 agent_visible=1", () => {
    db.addMemory({ id: randomUUID(), scope: "group", groupId: GROUP_A, category: "note", key: "n1", value: "便签", agentVisible: false, createdBy: "A" });
    db.addMemory({ id: randomUUID(), scope: "group", groupId: GROUP_A, category: "fact", key: "m1", value: "记忆", agentVisible: true, createdBy: "A" });
    const mem = db.listMemory({ scope: "group", groupId: GROUP_A, agentVisible: 1 });
    const notes = db.listMemory({ scope: "group", groupId: GROUP_A, agentVisible: 0 });
    assert.ok(mem.every(m => m.agent_visible === 1));
    assert.ok(notes.every(m => m.agent_visible === 0));
  });

  // ── searchMemory: note 隔离 ──────────────────────────────────────────────
  it("searchMemory: note(agent_visible=0)永远搜不到,即使内容匹配", () => {
    db.addMemory({ id: randomUUID(), scope: "group", groupId: GROUP_A, category: "note", key: "secret_note", value: "纯人看便签 不应被搜索到", agentVisible: false, createdBy: "A" });
    const hits = db.searchMemory("便签", { scope: "group", groupId: GROUP_A });
    assert.equal(hits.length, 0);
  });

  it("searchMemory: memory(agent_visible=1)能搜到,命中 injected_count +1", () => {
    const id = randomUUID();
    db.addMemory({ id, scope: "group", groupId: GROUP_A, category: "decision", key: "decision:logging", value: "统一用 pino logger", agentVisible: true, createdBy: "A" });
    const hits = db.searchMemory("pino", { scope: "group", groupId: GROUP_A });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, id);
    const row = db.getMemory(id);
    assert.equal(row!.injected_count, 1);  // search 命中 +1
  });

  it("searchMemory: 匹配 key/value/summary/tags 四个字段", () => {
    const idK = randomUUID();
    db.addMemory({ id: idK, scope: "group", groupId: GROUP_A, category: "fact", key: "searchable_key", value: "x", agentVisible: true, createdBy: "A" });
    const idV = randomUUID();
    db.addMemory({ id: idV, scope: "group", groupId: GROUP_A, category: "fact", key: "k2", value: "searchable_value", agentVisible: true, createdBy: "A" });
    const idT = randomUUID();
    db.addMemory({ id: idT, scope: "group", groupId: GROUP_A, category: "fact", key: "k3", value: "x", tags: ["searchable_tag"], agentVisible: true, createdBy: "A" });
    assert.ok(db.searchMemory("searchable_key", { scope: "group", groupId: GROUP_A }).some(h => h.id === idK));
    assert.ok(db.searchMemory("searchable_value", { scope: "group", groupId: GROUP_A }).some(h => h.id === idV));
    assert.ok(db.searchMemory("searchable_tag", { scope: "group", groupId: GROUP_A }).some(h => h.id === idT));
  });

  // ── pending_review 隔离 ──────────────────────────────────────────────────
  it("searchMemory + countMemory: pending_review=1 的不返回", () => {
    const id = randomUUID();
    db.addMemory({ id, scope: "group", groupId: GROUP_A, category: "fact", key: "pending_one", value: "待审核", agentVisible: true, createdBy: "A", pendingReview: true });
    assert.equal(db.searchMemory("pending_one", { scope: "group", groupId: GROUP_A }).length, 0);
    // count 也不算 pending
    const before = db.countMemory("group", GROUP_A);
    db.approveMemory(id);
    const after = db.countMemory("group", GROUP_A);
    assert.equal(after, before + 1);
  });

  // ── view_count ───────────────────────────────────────────────────────────
  it("getMemory: memory 读取时 view_count +1;note 不计数", () => {
    const memId = randomUUID();
    const noteId = randomUUID();
    db.addMemory({ id: memId, scope: "group", groupId: GROUP_A, category: "fact", key: "vc_test", value: "v", agentVisible: true, createdBy: "A" });
    db.addMemory({ id: noteId, scope: "group", groupId: GROUP_A, category: "note", key: "vc_note", value: "v", agentVisible: false, createdBy: "A" });
    db.getMemory(memId);
    db.getMemory(memId);
    db.getMemory(noteId);
    const mem = db.getMemory(memId);  // 第 3 次
    const note = db.getMemory(noteId);  // 第 2 次
    assert.ok(mem!.view_count >= 2);  // 前两次 +1,这次也会 +1
    assert.equal(note!.view_count, 0);  // note 不计数
  });

  // ── scope 隔离 + promote ─────────────────────────────────────────────────
  it("scope 隔离: group A 的群内记忆 group B 看不到", () => {
    db.addMemory({ id: randomUUID(), scope: "group", groupId: GROUP_A, category: "fact", key: "only_in_a", value: "v", agentVisible: true, createdBy: "A" });
    const inB = db.searchMemory("only_in_a", { scope: "group", groupId: GROUP_B });
    assert.equal(inB.length, 0);
  });

  it("promoteMemoryVisibility: group → global, scope=global group_id=NULL", () => {
    const id = randomUUID();
    db.addMemory({ id, scope: "group", groupId: GROUP_A, category: "fact", key: "to_promote", value: "v", agentVisible: true, createdBy: "A" });
    db.promoteMemoryVisibility(id, "global");
    const row = db.getMemory(id);
    assert.equal(row!.scope, "global");
    assert.equal(row!.group_id, null);
    assert.equal(row!.visibility, "global");
    // 跨群搜 global 能命中
    assert.ok(db.searchMemory("to_promote", { scope: "global" }).some(h => h.id === id));
  });

  // ── countMemory ──────────────────────────────────────────────────────────
  it("countMemory: 只算 agent_visible=1 active 非 pending", () => {
    const before = db.countMemory("group", GROUP_A);
    db.addMemory({ id: randomUUID(), scope: "group", groupId: GROUP_A, category: "fact", key: "c1", value: "v", agentVisible: true, createdBy: "A" });
    db.addMemory({ id: randomUUID(), scope: "group", groupId: GROUP_A, category: "note", key: "c2", value: "v", agentVisible: false, createdBy: "A" });  // note 不算
    db.addMemory({ id: randomUUID(), scope: "group", groupId: GROUP_A, category: "fact", key: "c3", value: "v", agentVisible: true, createdBy: "A", pendingReview: true });  // pending 不算
    const after = db.countMemory("group", GROUP_A);
    assert.equal(after, before + 1);
  });

  // ── memoryStats ──────────────────────────────────────────────────────────
  it("memoryStats: byCategory / byAgentVisible / topViewed", () => {
    const stats = db.memoryStats("group", GROUP_A);
    assert.ok(stats.total >= 0);
    assert.ok(stats.active >= 0);
    assert.ok(stats.pending >= 0);
    assert.ok(typeof stats.byCategory === "object");
    assert.ok("note" in stats.byAgentVisible && "memory" in stats.byAgentVisible);
    assert.ok(Array.isArray(stats.topViewed));
  });

  // ── 旧 note 兼容(createNote 写的 note,agent_visible=0)────────────────────
  it("旧 note 兼容: createNote 写的 note,search 搜不到", () => {
    const id = randomUUID();
    db.createNote({ id, groupId: GROUP_A, title: "legacy_note_title", description: "legacy 便签内容", createdBy: "西花" });
    // search 不应命中
    assert.equal(db.searchMemory("legacy", { scope: "group", groupId: GROUP_A }).length, 0);
    // listNotesByGroup 能看到(兼容旧 API)
    const notes = db.listNotesByGroup(GROUP_A);
    assert.ok(notes.some(n => n.id === id));
    // getNoteById 返回 title/description 形状
    const note = db.getNoteById(id);
    assert.equal(note!.title, "legacy_note_title");
    assert.equal(note!.description, "legacy 便签内容");
  });

  // ── updateMemory: note ↔ memory 互转 ─────────────────────────────────────
  it("updateMemory: agentVisible 0→1 把 note 升级成 memory,search 能搜到", () => {
    const id = randomUUID();
    db.addMemory({ id, scope: "group", groupId: GROUP_A, category: "note", key: "upgrade_test", value: "升级便签", agentVisible: false, createdBy: "A" });
    assert.equal(db.searchMemory("upgrade_test", { scope: "group", groupId: GROUP_A }).length, 0);
    db.updateMemory(id, { agentVisible: true });
    assert.equal(db.searchMemory("upgrade_test", { scope: "group", groupId: GROUP_A }).length, 1);
  });

  // ── deactivateMemory ─────────────────────────────────────────────────────
  it("deactivateMemory: 软删除后 search/count 不返回", () => {
    const id = randomUUID();
    db.addMemory({ id, scope: "group", groupId: GROUP_A, category: "fact", key: "deactivate_me", value: "v", agentVisible: true, createdBy: "A" });
    const before = db.countMemory("group", GROUP_A);
    db.deactivateMemory(id);
    const after = db.countMemory("group", GROUP_A);
    assert.equal(after, before - 1);
    assert.equal(db.searchMemory("deactivate_me", { scope: "group", groupId: GROUP_A }).length, 0);
  });
});
