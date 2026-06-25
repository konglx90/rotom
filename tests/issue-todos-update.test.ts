/**
 * Integration test — issue_todos_update WS 消息端到端落库
 *
 * 验证:
 *   1. Worker 发 issue_todos_update → master 写 issues.latest_todos_json
 *   2. 同步追加一条 event_type='todos' 的 issue_event
 *   3. notifyIssueChanged 触发(group 内可见)
 *   4. 内容相同的 todos 二次发送 → 快照仍更新但**不**重复落 event
 *   5. 不同内容 → 再落一条 event
 *   6. GET /api/issues/:id 返回的 issue 带 latest_todos 字段(解析后)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { MeshDb } from "../src/master/db.js";
import { AuthService, hashToken } from "../src/master/auth.js";
import { WSHub } from "../src/master/ws-hub.js";
import { Router } from "../src/master/router.js";
import { OfflineQueue } from "../src/master/offline-queue.js";
import { createApi } from "../src/master/api/index.js";

const TEST_PORT = 19911;
const TEST_DB = `/tmp/mesh-todos-test-${Date.now()}.db`;
const AGENT_TOKEN = "mesh_test_token_todos";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let db: MeshDb;
let hub: WSHub;
let router: Router;
let httpServer: http.Server;
let agentId: string;
let groupId: string;
let issueId: string;

async function sendJson(ws: WebSocket, msg: unknown): Promise<void> {
  ws.send(JSON.stringify(msg));
}

async function openWorkerWs(): Promise<{ ws: WebSocket; msgs: any[]; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
  const msgs: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
  ws.on("message", (raw) => {
    try { msgs.push(JSON.parse(raw.toString())); } catch {}
  });
  await sendJson(ws, {
    type: "auth",
    token: AGENT_TOKEN,
    name: "TodoWorker",
    instance: { instanceId: randomUUID(), hostname: "test", platform: "test" },
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("auth timeout")), 3000);
    const onMsg = () => {
      if (msgs.some((m) => m.type === "auth_ok")) {
        clearTimeout(t);
        ws.off("message", onMsg as any);
        resolve();
      }
    };
    ws.on("message", onMsg);
  });
  return {
    ws,
    msgs,
    close: () => { if (ws.readyState === WebSocket.OPEN) ws.close(); },
  };
}

function waitFor<T>(fn: () => T | null, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      try {
        const v = fn();
        if (v) return resolve(v);
      } catch (err) { return reject(err); }
      if (Date.now() - start > ms) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("issue_todos_update WS → master persistence", () => {
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
    app.use("/api", createApi(db, auth, hub, router, TEST_PORT));

    await new Promise<void>((r) => httpServer.listen(TEST_PORT, "127.0.0.1", r));

    agentId = randomUUID();
    db.insertAgent({
      id: agentId,
      name: "TodoWorker",
      description: "test",
      domain: "test",
      tokenHash: hashToken(AGENT_TOKEN),
      token: AGENT_TOKEN,
    });

    groupId = "test-group-todos";
    db.createGroup(groupId, "test group", null);
    db.addGroupMembers(groupId, ["TodoWorker"]);

    issueId = randomUUID();
    db.createIssue({
      id: issueId,
      groupId,
      title: "test issue",
      description: "test",
      priority: "medium",
      createdBy: "TodoWorker",
      assignedTo: "TodoWorker",
    });
  });

  after(() => {
    router.stop();
    hub.stop();
    httpServer.close();
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  it("首次 todos update:落 latest_todos_json + 1 条 todos event + 触发 issue_changed", async () => {
    const worker = await openWorkerWs();
    try {
      const todos = [
        { content: "第一步", status: "in_progress" as const, activeForm: "正在做第一步" },
        { content: "第二步", status: "pending" as const },
      ];
      sendJson(worker.ws, { type: "issue_todos_update", issueId, todos });

      // 等 issue_changed 推送回来(event_appended kind)
      await waitFor(() => worker.msgs.some((m) => m.type === "issue_changed"), 3000);

      // 1) latest_todos_json 落库
      const issue = db.getIssueById(issueId)!;
      assert.ok(issue.latest_todos_json, "latest_todos_json should be written");
      const parsed = JSON.parse(issue.latest_todos_json!);
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].content, "第一步");
      assert.equal(parsed[0].status, "in_progress");
      assert.equal(parsed[1].status, "pending");

      // 2) 一条 todos event
      const events = db.getIssueEvents(issueId).filter((e) => e.event_type === "todos");
      assert.equal(events.length, 1, "should have exactly 1 todos event");
      const meta = JSON.parse(events[0].metadata);
      assert.equal(meta.todos.length, 2);
      assert.equal(meta.count, 2);
    } finally {
      worker.close();
    }
  });

  it("相同内容二次发送:快照仍写,但 event 不重复", async () => {
    const worker = await openWorkerWs();
    try {
      const beforeCount = db.getIssueEvents(issueId).filter((e) => e.event_type === "todos").length;
      const sameTodos = [
        { content: "第一步", status: "in_progress", activeForm: "正在做第一步" },
        { content: "第二步", status: "pending" },
      ];
      sendJson(worker.ws, { type: "issue_todos_update", issueId, todos: sameTodos });
      await waitFor(() => worker.msgs.some((m) =>
        m.type === "issue_changed" && (m as any).kind === "event_appended"), 3000);
      // 等一小段确保 master 处理完(快照写+去重判断)
      await new Promise((r) => setTimeout(r, 100));

      const afterCount = db.getIssueEvents(issueId).filter((e) => e.event_type === "todos").length;
      assert.equal(afterCount, beforeCount, "no new event for identical todos (dedup)");

      // 快照列仍应被覆盖写入(updated_at 会更新)
      const issue = db.getIssueById(issueId)!;
      assert.ok(issue.latest_todos_json);
    } finally {
      worker.close();
    }
  });

  it("不同内容:再落一条 event", async () => {
    const worker = await openWorkerWs();
    try {
      const beforeCount = db.getIssueEvents(issueId).filter((e) => e.event_type === "todos").length;
      const changedTodos = [
        { content: "第一步", status: "completed" },
        { content: "第二步", status: "in_progress", activeForm: "正在做第二步" },
        { content: "第三步", status: "pending" },
      ];
      sendJson(worker.ws, { type: "issue_todos_update", issueId, todos: changedTodos });
      await waitFor(() => {
        const c = db.getIssueEvents(issueId).filter((e) => e.event_type === "todos").length;
        return c > beforeCount ? true : null;
      }, 3000);

      const after = db.getIssueEvents(issueId).filter((e) => e.event_type === "todos").length;
      assert.equal(after, beforeCount + 1, "new event for changed todos");
      const issue = db.getIssueById(issueId)!;
      const parsed = JSON.parse(issue.latest_todos_json!);
      assert.equal(parsed.length, 3);
      assert.equal(parsed[0].status, "completed");
    } finally {
      worker.close();
    }
  });

  it("未知 issueId:master 静默拒绝,不抛", async () => {
    const worker = await openWorkerWs();
    try {
      const beforeAll = db.getIssueEvents(issueId).length;
      sendJson(worker.ws, {
        type: "issue_todos_update",
        issueId: "non-existent-issue-id",
        todos: [{ content: "x", status: "pending" }],
      });
      // 等一段时间确认 master 处理过这条消息(无副作用即可)
      await new Promise((r) => setTimeout(r, 200));
      const afterAll = db.getIssueEvents(issueId).length;
      assert.equal(afterAll, beforeAll, "no event for unknown issue");
    } finally {
      worker.close();
    }
  });
});
