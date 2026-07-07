/**
 * DB tests — ask_bridges 生命周期 + 群消息回查(getGroupMessageById)。
 *
 * Harness 沿用 tests/memory.test.ts:真实文件 DB(走迁移加载),不 mock SQLite。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { MeshDb } from "../src/master/db.js";

const TEST_DB = `/tmp/mesh-test-askbridge-${Date.now()}.db`;
const GROUP = "grp-ask-" + randomUUID().slice(0, 8);

let db: MeshDb;

describe("ask_bridges + 群消息回查", () => {
  before(() => {
    db = new MeshDb(TEST_DB);
    db.createGroup(GROUP, "AskTest", "system");
  });

  after(() => {
    db.close();
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(TEST_DB + ext); } catch {}
    }
  });

  // ── createAskBridge + getAskBridge ───────────────────────────────────────
  it("createAskBridge: 写入后 status=pending,expires_at=created_at+timeout_ms", () => {
    const qid = db.addGroupMessage(GROUP, "alice", "@bob 你接口字段是啥?", ["bob"]);
    const id = "br-" + randomUUID();
    const br = db.createAskBridge({
      id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 5 * 60 * 1000, mode: "sync",
    });
    assert.equal(br.status, "pending");
    assert.equal(br.asker, "alice");
    assert.equal(br.target, "bob");
    assert.equal(br.mode, "sync");
    assert.equal(br.expires_at - br.created_at, 5 * 60 * 1000);
    assert.equal(db.getAskBridge(id)?.id, id);
  });

  it("getAskBridge: 不存在返回 undefined", () => {
    assert.equal(db.getAskBridge("nope"), undefined);
  });

  // ── listAskBridges 过滤 ─────────────────────────────────────────────────
  it("listAskBridges: 按 groupId / asker / status 过滤", () => {
    const a = "br-" + randomUUID();
    const b = "br-" + randomUUID();
    db.createAskBridge({ id: a, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: db.addGroupMessage(GROUP, "alice", "q", []), escalateTo: null, timeoutMs: 1000, mode: "async" });
    db.createAskBridge({ id: b, groupId: GROUP, asker: "carol", target: "bob",
      questionMsgId: db.addGroupMessage(GROUP, "carol", "q", []), escalateTo: null, timeoutMs: 1000, mode: "async" });

    const byGroup = db.listAskBridges({ groupId: GROUP });
    assert.ok(byGroup.length >= 2);
    const byAsker = db.listAskBridges({ groupId: GROUP, asker: "alice" });
    assert.ok(byAsker.every((x) => x.asker === "alice"));
    const pending = db.listAskBridges({ groupId: GROUP, status: "pending" });
    assert.ok(pending.every((x) => x.status === "pending"));
  });

  // ── getPendingAskBridges ─────────────────────────────────────────────────
  it("getPendingAskBridges: 只返回 pending", () => {
    const all = db.getPendingAskBridges();
    assert.ok(all.every((x) => x.status === "pending"));
  });

  // ── findAtReplyForBridge ─────────────────────────────────────────────────
  it("findAtReplyForBridge: target 在 question 之后 @ 了 asker → 返回最早一条", () => {
    const qid = db.addGroupMessage(GROUP, "alice", "@bob 问题?", ["bob"]);
    const id = "br-" + randomUUID();
    const br = db.createAskBridge({ id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    // 一条非 @ 的噪声消息(不应命中)
    db.addGroupMessage(GROUP, "bob", "嗯我想想", []);
    // 命中回复
    const replyId = db.addGroupMessage(GROUP, "bob", "@alice 字段是 fields", ["alice"]);
    const hit = db.findAtReplyForBridge(br);
    assert.ok(hit, "应找到 @ 回复");
    assert.equal(hit!.id, replyId);
    assert.equal(hit!.sender, "bob");
  });

  it("findAtReplyForBridge: question 之前的 @ 回复不算命中(id 必须 > question_msg_id)", () => {
    const earlierReply = db.addGroupMessage(GROUP, "bob", "@alice 旧回复", ["alice"]);
    const qid = db.addGroupMessage(GROUP, "alice", "@bob 新问题?", ["bob"]);
    const id = "br-" + randomUUID();
    const br = db.createAskBridge({ id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    const hit = db.findAtReplyForBridge(br);
    assert.equal(hit, undefined, "问题之前的回复不应命中");
    assert.ok(earlierReply < qid, "前置 sanity:旧回复 id < 新问题 id");
  });

  it("findAtReplyForBridge: mentions 用 json_each 精确匹配,不命中子串", () => {
    const qid = db.addGroupMessage(GROUP, "alice", "@bob 问?", ["bob"]);
    const id = "br-" + randomUUID();
    const br = db.createAskBridge({ id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    // mentions 含 "alicex" 而非 "alice",json_each 精确匹配不应命中
    db.addGroupMessage(GROUP, "bob", "@alicex 嗨", ["alicex"]);
    assert.equal(db.findAtReplyForBridge(br), undefined);
  });

  // ── findLatestReplyForBridge ─────────────────────────────────────────────
  it("findLatestReplyForBridge: 返回 question 之后 target 最新一条非空未取消回复", () => {
    const qid = db.addGroupMessage(GROUP, "alice", "@bob 再问?", ["bob"]);
    const id = "br-" + randomUUID();
    const br = db.createAskBridge({ id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    db.addGroupMessage(GROUP, "bob", "回复1", []);
    const latest = db.addGroupMessage(GROUP, "bob", "回复2", []);
    const hit = db.findLatestReplyForBridge(br);
    assert.equal(hit?.id, latest);
  });

  it("findLatestReplyForBridge: 跳过已取消消息(cancelled_at 非空)", () => {
    const qid = db.addGroupMessage(GROUP, "alice", "@bob 问?", ["bob"]);
    const id = "br-" + randomUUID();
    const br = db.createAskBridge({ id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    const cancelledId = db.addGroupMessage(GROUP, "bob", "这条作废", [], { cancelledAt: "2026-01-01 00:00:00.000" });
    db.addGroupMessage(GROUP, "bob", "有效回复", []);
    const hit = db.findLatestReplyForBridge(br);
    assert.notEqual(hit?.id, cancelledId, "已取消消息不应被取为最新回复");
    assert.equal(hit?.content, "有效回复");
  });

  // ── markBridgeAnswered / markBridgeTimedOut / cancelBridge ───────────────
  it("markBridgeAnswered: pending → answered,记 reply_msg_id,且非 pending 不再改", () => {
    const qid = db.addGroupMessage(GROUP, "alice", "@bob q", ["bob"]);
    const id = "br-" + randomUUID();
    db.createAskBridge({ id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    const rid = db.addGroupMessage(GROUP, "bob", "@alice a", ["alice"]);
    db.markBridgeAnswered(id, rid);
    assert.equal(db.getAskBridge(id)?.status, "answered");
    assert.equal(db.getAskBridge(id)?.reply_msg_id, rid);
    // 再次 mark 不应改(已非 pending)
    db.markBridgeAnswered(id, 999999);
    assert.equal(db.getAskBridge(id)?.reply_msg_id, rid, "answered 后再 mark 不应改 reply_msg_id");
  });

  it("markBridgeTimedOut: pending → timed_out,记 issue_id(需真实 issue 满足 FK)", () => {
    const qid = db.addGroupMessage(GROUP, "alice", "@bob q", ["bob"]);
    const id = "br-" + randomUUID();
    db.createAskBridge({ id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "async" });
    // issue_id 列 REFERENCES issues(id),需先建真实 issue
    const issueId = "iss-" + randomUUID();
    db.createIssue({ id: issueId, groupId: GROUP, title: "超时升级", createdBy: "alice" });
    db.markBridgeTimedOut(id, issueId, null);
    const br = db.getAskBridge(id);
    assert.equal(br?.status, "timed_out");
    assert.equal(br?.issue_id, issueId);
  });

  it("markBridgeTimedOut: issue_id 传 null 也合法(无升级目标)", () => {
    const qid = db.addGroupMessage(GROUP, "alice", "@bob q", ["bob"]);
    const id = "br-" + randomUUID();
    db.createAskBridge({ id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    db.markBridgeTimedOut(id, null, null);
    assert.equal(db.getAskBridge(id)?.status, "timed_out");
    assert.equal(db.getAskBridge(id)?.issue_id, null);
  });

  it("cancelBridge: pending 可取消返回 true;非 pending 返回 false", () => {
    const qid = db.addGroupMessage(GROUP, "alice", "@bob q", ["bob"]);
    const id = "br-" + randomUUID();
    db.createAskBridge({ id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    assert.equal(db.cancelBridge(id), true);
    assert.equal(db.getAskBridge(id)?.status, "cancelled");
    assert.equal(db.cancelBridge(id), false, "已 cancelled 再 cancel 返回 false");
  });

  // ── findBridgesAnsweredByMessage ─────────────────────────────────────────
  it("findBridgesAnsweredByMessage: sender=target 且 asker∈mentions → 命中 pending bridge", () => {
    const qid = db.addGroupMessage(GROUP, "alice", "@bob 问?", ["bob"]);
    const id = "br-" + randomUUID();
    db.createAskBridge({ id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    const hits = db.findBridgesAnsweredByMessage(GROUP, "bob", ["alice"]);
    assert.ok(hits.some((x) => x.id === id));
  });

  it("findBridgesAnsweredByMessage: mentions 为空 → 返回空数组(不查库)", () => {
    assert.deepEqual(db.findBridgesAnsweredByMessage(GROUP, "bob", []), []);
  });

  it("findBridgesAnsweredByMessage: target≠sender 不命中", () => {
    const qid = db.addGroupMessage(GROUP, "alice", "@bob q", ["bob"]);
    const id = "br-" + randomUUID();
    db.createAskBridge({ id, groupId: GROUP, asker: "alice", target: "bob",
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    const hits = db.findBridgesAnsweredByMessage(GROUP, "carol", ["alice"]);
    assert.ok(!hits.some((x) => x.id === id), "sender 不是 target 不应命中");
  });

  // ── findPendingBridge ────────────────────────────────────────────────────
  it("findPendingBridge: 按 (group, asker, target) 查 pending,answered 后查不到", () => {
    // 用唯一 asker/target 对,避免被先前测试遗留的 pending (alice,bob) bridge 污染。
    const asker = "zoe-" + randomUUID().slice(0, 6);
    const target = "yvan-" + randomUUID().slice(0, 6);
    const qid = db.addGroupMessage(GROUP, asker, `@${target} q`, [target]);
    const id = "br-" + randomUUID();
    db.createAskBridge({ id, groupId: GROUP, asker, target,
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    assert.equal(db.findPendingBridge(GROUP, asker, target)?.id, id);
    db.markBridgeAnswered(id, db.addGroupMessage(GROUP, target, `@${asker} a`, [asker]));
    assert.equal(db.findPendingBridge(GROUP, asker, target), undefined, "answered 后该对应无 pending");
  });

  // ── getGroupMessageContent ───────────────────────────────────────────────
  it("getGroupMessageContent: 按 msgId 取 content;不存在返回 undefined", () => {
    const mid = db.addGroupMessage(GROUP, "alice", "原始问题内容", []);
    assert.equal(db.getGroupMessageContent(mid), "原始问题内容");
    assert.equal(db.getGroupMessageContent(99999999), undefined);
  });

  // ── getGroupMessageById (群消息回查,最近提交核心) ───────────────────────
  it("getGroupMessageById: 按 (group, msgId) 取回完整消息(含 sender/content/mentions)", () => {
    const mid = db.addGroupMessage(GROUP, "alice", "@bob 回查内容", ["bob"]);
    const row = db.getGroupMessageById(GROUP, mid);
    assert.ok(row, "应取回该消息");
    assert.equal(row!.id, mid);
    assert.equal(row!.sender, "alice");
    assert.equal(row!.content, "@bob 回查内容");
    // mentions 列存原始 JSON 字符串(GroupMessageRow.mentions: string)
    assert.equal(row!.mentions, JSON.stringify(["bob"]));
  });

  it("getGroupMessageById: group 不匹配时返回 undefined(跨群不串)", () => {
    const mid = db.addGroupMessage(GROUP, "alice", "x", []);
    assert.equal(db.getGroupMessageById("other-group", mid), undefined);
  });

  // ── getGroupMessagesSince ────────────────────────────────────────────────
  it("getGroupMessagesSince: 返回 sinceIso 之后的消息(strict >,字符串字典序)", () => {
    // created_at 默认 datetime('now') 秒级精度,同秒插入时间戳相同;
    // 用一个明确早于所有测试消息的 sinceIso,断言新消息被纳入。
    db.addGroupMessage(GROUP, "alice", "since-before-1", []);
    const m2 = db.addGroupMessage(GROUP, "alice", "since-before-2", []);
    const rows = db.getGroupMessagesSince(GROUP, "2000-01-01 00:00:00");
    assert.ok(rows.some((r) => r.id === m2), "早于 since 的起点应包含新插入消息");
    // sinceIso 晚于所有消息时应返回空
    const future = db.getGroupMessagesSince(GROUP, "2099-01-01 00:00:00");
    assert.equal(future.length, 0);
  });
});
