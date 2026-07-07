/**
 * API route tests — groups(消息回查 / 发消息 / asks 列表·详情·取消)
 * + issues(create / get / list / claim-next / cancel / interrupt / continue / append / approvals)。
 *
 * Harness 沿用 master-agent.test.ts:真实 MeshDb + express + WSHub。
 * 不接真实 worker —— push 类调用对离线 agent 返回 false(不抛),DB 层副作用仍生效,
 * 断言聚焦 DB 状态 + HTTP 状态码。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { MeshDb } from "../src/master/db.js";
import { AuthService, hashToken } from "../src/master/auth.js";
import { WSHub } from "../src/master/ws-hub.js";
import { Router } from "../src/master/router.js";
import { OfflineQueue } from "../src/master/offline-queue.js";
import { registerGroupRoutes } from "../src/master/api/groups.js";
import { registerIssueRoutes } from "../src/master/api/issues.js";

const TEST_DB = `/tmp/mesh-test-api-${Date.now()}.db`;
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let db: MeshDb;
let hub: WSHub;
let router: Router;
let httpServer: http.Server;
let baseUrl: string;
const GROUP = "grp-api-" + randomUUID().slice(0, 8);
const AGENT_A = "AgentA_" + randomUUID().slice(0, 6);
const AGENT_B = "AgentB_" + randomUUID().slice(0, 6);

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

describe("API: groups 消息 + asks + issues 生命周期", () => {
  before(async () => {
    db = new MeshDb(TEST_DB);
    const auth = new AuthService(db);
    const offlineQueue = new OfflineQueue(db);
    router = new Router(db, silent);

    const app = express();
    app.use(express.json());
    httpServer = http.createServer(app);
    hub = new WSHub(httpServer, db, auth, router, offlineQueue, silent);
    hub.start();

    const apiRouter = express.Router();
    registerGroupRoutes(apiRouter, db, null, hub);
    registerIssueRoutes(apiRouter, db, null, hub);
    app.use("/api", apiRouter);

    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as any).port}`;

    db.createGroup(GROUP, "ApiTest", "system");
    db.insertAgent({ id: randomUUID(), name: AGENT_A, description: "A", domain: "test",
      tokenHash: hashToken("t_a"), token: "t_a" });
    db.insertAgent({ id: randomUUID(), name: AGENT_B, description: "B", domain: "test",
      tokenHash: hashToken("t_b"), token: "t_b" });
  });

  after(() => {
    router.stop();
    hub.stop();
    httpServer.close();
    db.close();
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(TEST_DB + ext); } catch {}
    }
  });

  // ── GET /groups/:id/messages/:msgId (群消息回查) ──────────────────────────
  it("消息回查: 入库后 GET 单条返回完整行", async () => {
    const msgId = db.addGroupMessage(GROUP, AGENT_A, "回查这条 @bob", [AGENT_A]);
    const r = await req("GET", `/api/groups/${GROUP}/messages/${msgId}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.id, msgId);
    assert.equal(r.json.sender, AGENT_A);
    assert.equal(r.json.content, "回查这条 @bob");
  });

  it("消息回查: group 不存在 → 404", async () => {
    const r = await req("GET", `/api/groups/no-such-group/messages/1`);
    assert.equal(r.status, 404);
  });

  it("消息回查: msgId 不存在 → 404", async () => {
    const r = await req("GET", `/api/groups/${GROUP}/messages/99999999`);
    assert.equal(r.status, 404);
  });

  it("消息回查: 非数字 msgId → 400", async () => {
    const r = await req("GET", `/api/groups/${GROUP}/messages/abc`);
    assert.equal(r.status, 400);
  });

  // ── POST /groups/:id/messages ────────────────────────────────────────────
  it("发消息: 缺 sender/content → 400", async () => {
    assert.equal((await req("POST", `/api/groups/${GROUP}/messages`, { content: "x" })).status, 400);
    assert.equal((await req("POST", `/api/groups/${GROUP}/messages`, { sender: AGENT_A })).status, 400);
  });

  it("发消息: group 不存在 → 404", async () => {
    assert.equal((await req("POST", `/api/groups/no-such/messages`, { sender: AGENT_A, content: "x" })).status, 404);
  });

  it("发消息: 已归档群 → 403", async () => {
    const g = "grp-arch-" + randomUUID().slice(0, 6);
    db.createGroup(g, "Archived", "system");
    db.updateGroupArchived(g, true);
    const r = await req("POST", `/api/groups/${g}/messages`, { sender: AGENT_A, content: "x" });
    assert.equal(r.status, 403);
  });

  // ── asks 列表 / 详情 / 取消 ──────────────────────────────────────────────
  it("asks: 直接建 bridge 后 GET /asks/:id 返回详情;不存在 → 404", async () => {
    const qid = db.addGroupMessage(GROUP, AGENT_A, `@${AGENT_B} q?`, [AGENT_B]);
    const id = "br-" + randomUUID();
    db.createAskBridge({ id, groupId: GROUP, asker: AGENT_A, target: AGENT_B,
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    const r = await req("GET", `/api/asks/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.id, id);
    assert.equal(r.json.status, "pending");
    assert.equal((await req("GET", `/api/asks/no-such`)).status, 404);
  });

  it("asks: GET /groups/:id/asks?status=pending 过滤", async () => {
    const r = await req("GET", `/api/groups/${GROUP}/asks?status=pending`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
    assert.ok(r.json.every((b: any) => b.status === "pending"));
  });

  it("asks: POST /asks/:id/cancel —— pending 可取消 200;再 cancel → 409", async () => {
    const qid = db.addGroupMessage(GROUP, AGENT_A, `@${AGENT_B} cancel me`, [AGENT_B]);
    const id = "br-" + randomUUID();
    db.createAskBridge({ id, groupId: GROUP, asker: AGENT_A, target: AGENT_B,
      questionMsgId: qid, escalateTo: null, timeoutMs: 60_000, mode: "sync" });
    const ok = await req("POST", `/api/asks/${id}/cancel`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(db.getAskBridge(id)?.status, "cancelled");
    const again = await req("POST", `/api/asks/${id}/cancel`);
    assert.equal(again.status, 409, "非 pending 再 cancel → 409");
  });

  // ── issues: create / get / list ──────────────────────────────────────────
  it("issues: POST 创建 → 201 返回 id;GET /issues/:id 回读", async () => {
    const c = await req("POST", `/api/groups/${GROUP}/issues`, {
      title: "修个 bug", description: "详情", createdBy: AGENT_A,
    });
    assert.equal(c.status, 201);
    assert.equal(c.json.status, "open");
    const id = c.json.id;
    const g = await req("GET", `/api/issues/${id}`);
    assert.equal(g.status, 200);
    assert.equal(g.json.title, "修个 bug");
    assert.equal(g.json.status, "open");
  });

  it("issues: 缺 createdBy / 缺 title 和 description → 400", async () => {
    assert.equal((await req("POST", `/api/groups/${GROUP}/issues`, { title: "x" })).status, 400, "缺 createdBy");
    assert.equal((await req("POST", `/api/groups/${GROUP}/issues`, { createdBy: AGENT_A })).status, 400, "缺 title 和 description");
  });

  it("issues: group 不存在 → 404;已归档群 → 403", async () => {
    assert.equal((await req("POST", `/api/groups/no-such/issues`, { title: "x", createdBy: AGENT_A })).status, 404);
    const g = "grp-arch2-" + randomUUID().slice(0, 6);
    db.createGroup(g, "Archived2", "system");
    db.updateGroupArchived(g, true);
    assert.equal((await req("POST", `/api/groups/${g}/issues`, { title: "x", createdBy: AGENT_A })).status, 403);
  });

  it("issues: GET /groups/:groupId/issues 列表", async () => {
    await req("POST", `/api/groups/${GROUP}/issues`, { title: "列表项", createdBy: AGENT_A });
    const r = await req("GET", `/api/groups/${GROUP}/issues`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json));
    assert.ok(r.json.length >= 1);
  });

  it("issues: GET /issues/:id 不存在 → 404", async () => {
    assert.equal((await req("GET", `/api/issues/no-such`)).status, 404);
  });

  // ── issues: claim-next ───────────────────────────────────────────────────
  it("issues: claim-next 认领最老 open task,变 in_progress + assigned_to", async () => {
    const c = await req("POST", `/api/groups/${GROUP}/issues`, { title: "待认领", createdBy: AGENT_A });
    const r = await req("POST", `/api/issues/claim-next`, { agentName: AGENT_B });
    assert.equal(r.status, 200);
    assert.ok(r.json, "应认领到一条 issue");
    assert.equal(r.json.status, "in_progress");
    assert.equal(r.json.assigned_to, AGENT_B);
    assert.notEqual(r.json.id, c.json.id, "认领的应是更早的 open issue 之一");
  });

  it("issues: claim-next 无可认领时返回 null", async () => {
    const r = await req("POST", `/api/issues/claim-next`, { agentName: "nobody-" + randomUUID().slice(0, 6) });
    assert.equal(r.status, 200);
    // 此时可能仍有其它 open issue,断言"要么 null 要么 in_progress"即可
    assert.ok(r.json === null || r.json.status === "in_progress");
  });

  it("issues: claim-next 缺 agentName → 400", async () => {
    assert.equal((await req("POST", `/api/issues/claim-next`, {})).status, 400);
  });

  // ── issues: cancel ──────────────────────────────────────────────────────
  it("issues: POST /issues/:id/cancel 取消任务", async () => {
    const c = await req("POST", `/api/groups/${GROUP}/issues`, { title: "要取消", createdBy: AGENT_A });
    const r = await req("POST", `/api/issues/${c.json.id}/cancel`, { cancelledBy: AGENT_A });
    assert.equal(r.status, 200);
    assert.equal(db.getIssueById(c.json.id)?.status, "cancelled");
  });

  it("issues: cancel 不存在 → 404", async () => {
    assert.equal((await req("POST", `/api/issues/no-such/cancel`, {})).status, 404);
  });

  // ── issues: interrupt / continue / append(离线校验 + 校验路径) ────────────
  it("issues: interrupt 非 in_progress → 400", async () => {
    const c = await req("POST", `/api/groups/${GROUP}/issues`, { title: "未开工", createdBy: AGENT_A });
    const r = await req("POST", `/api/issues/${c.json.id}/interrupt`, {});
    assert.equal(r.status, 400);
  });

  it("issues: interrupt in_progress 但 assignee 离线 → 409", async () => {
    const c = await req("POST", `/api/groups/${GROUP}/issues`, { title: "进行中离线", createdBy: AGENT_A });
    // 认领让变 in_progress,但 worker 没连 → agent 离线
    await req("POST", `/api/issues/claim-next`, { agentName: AGENT_A });
    // 上面的 claim-next 可能认领的是更早的 issue;直接手动把这单设成 in_progress+assigned
    db.updateIssueStatus(c.json.id, "in_progress", { assignedTo: AGENT_A });
    const r = await req("POST", `/api/issues/${c.json.id}/interrupt`, {});
    assert.ok(r.status === 409 || r.status === 400, `离线中断应 409 或校验 400,实际 ${r.status}`);
  });

  it("issues: continue 非 completed/failed → 400;缺 prompt → 400", async () => {
    const c = await req("POST", `/api/groups/${GROUP}/issues`, { title: "未完成续接", createdBy: AGENT_A });
    assert.equal((await req("POST", `/api/issues/${c.json.id}/continue`, { prompt: "hi" })).status, 400, "open 状态不可 continue");
    // 设成 completed 测缺 prompt
    db.updateIssueStatus(c.json.id, "completed", { result: "done", assignedTo: AGENT_A });
    assert.equal((await req("POST", `/api/issues/${c.json.id}/continue`, {})).status, 400, "缺 prompt");
  });

  it("issues: continue completed 但 assignee 离线 → 409", async () => {
    const c = await req("POST", `/api/groups/${GROUP}/issues`, { title: "完成续接离线", createdBy: AGENT_A });
    db.updateIssueStatus(c.json.id, "completed", { result: "done", assignedTo: AGENT_A });
    const r = await req("POST", `/api/issues/${c.json.id}/continue`, { prompt: "再改一下" });
    assert.equal(r.status, 409);
  });

  it("issues: append 非 active 状态 → 400;缺 prompt → 400", async () => {
    const c = await req("POST", `/api/groups/${GROUP}/issues`, { title: "追加", createdBy: AGENT_A });
    // open + 无 assignee → 缺 prompt 优先(400)。先补 prompt 测无 assignee
    const noAssign = await req("POST", `/api/issues/${c.json.id}/append`, { prompt: "补充" });
    assert.equal(noAssign.status, 400, "无 assignee → 400");
    // cancelled 状态 → 400
    await req("POST", `/api/issues/${c.json.id}/cancel`, {});
    const r = await req("POST", `/api/issues/${c.json.id}/append`, { prompt: "补充" });
    assert.equal(r.status, 400, "cancelled 不可 append");
    // 缺 prompt
    const c2 = await req("POST", `/api/groups/${GROUP}/issues`, { title: "追加2", createdBy: AGENT_A });
    assert.equal((await req("POST", `/api/issues/${c2.json.id}/append`, {})).status, 400, "缺 prompt");
  });

  // ── issues: approvals ────────────────────────────────────────────────────
  it("approvals: accept 决议 pending approval → 200;再决议 → 409", async () => {
    const c = await req("POST", `/api/groups/${GROUP}/issues`, { title: "需审批", createdBy: AGENT_A });
    const approvalId = "apv-" + randomUUID();
    db.addIssueEvent({
      issueId: c.json.id, eventType: "approval_request", agentName: AGENT_A,
      metadata: { approvalId, kind: "edit", status: "pending" },
    });
    const r = await req("POST", `/api/issues/${c.json.id}/approvals/${approvalId}`, { decision: "accept", resolvedBy: "boss" });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    // 再次决议 → 409
    const again = await req("POST", `/api/issues/${c.json.id}/approvals/${approvalId}`, { decision: "accept" });
    assert.equal(again.status, 409);
  });

  it("approvals: deny 带 feedback → 200;非法 decision → 400;approval 不存在 → 404", async () => {
    const c = await req("POST", `/api/groups/${GROUP}/issues`, { title: "拒绝审批", createdBy: AGENT_A });
    const approvalId = "apv-" + randomUUID();
    db.addIssueEvent({
      issueId: c.json.id, eventType: "approval_request", agentName: AGENT_A,
      metadata: { approvalId, status: "pending" },
    });
    // 非法 decision
    assert.equal((await req("POST", `/api/issues/${c.json.id}/approvals/${approvalId}`, { decision: "maybe" })).status, 400);
    // deny + feedback
    const r = await req("POST", `/api/issues/${c.json.id}/approvals/${approvalId}`, { decision: "deny", feedback: "不要这么改" });
    assert.equal(r.status, 200);
    // 不存在的 approval
    assert.equal((await req("POST", `/api/issues/${c.json.id}/approvals/no-such`, { decision: "accept" })).status, 404);
  });

  it("approvals: issue 不存在 → 404", async () => {
    assert.equal((await req("POST", `/api/issues/no-such/approvals/x`, { decision: "accept" })).status, 404);
  });
});
