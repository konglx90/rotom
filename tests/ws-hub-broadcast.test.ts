/**
 * Integration test — Group chat broadcast (A 修复 + B 修复)
 *
 * 覆盖 6 个用例：
 *   A.1  真人 a2a_send 群消息广播给所有其他成员(target 排除避免重复)
 *   A.2  HTTP POST /api/groups/:id/messages 触发 broadcast
 *   A.3  sendAsAgent 群消息路径广播
 *   B2.1 发信人不在 group_members 时自动 addMembers 后再广播
 *   B2.2 sender 不是注册 agent 时 log warn + 入库 + 不广播
 *   E.1  broadcast 排除 targetAgentId(targeted send + broadcast 不重复)
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
import { registerGroupRoutes } from "../src/master/api/groups.js";

const TEST_PORT = 19901;
const TEST_DB = `/tmp/mesh-broadcast-test-${Date.now()}.db`;

const ALICE_TOKEN = "mesh_test_alice_token";
const BOB_TOKEN = "mesh_test_bob_token";
const CAROL_TOKEN = "mesh_test_carol_token";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let db: MeshDb;
let hub: WSHub;
let router: Router;
let httpServer: http.Server;
let app: express.Express;

let groupId: string;
let aliceId: string;
let bobId: string;
let carolId: string;

before(async () => {
  db = new MeshDb(TEST_DB);
  const auth = new AuthService(db);
  const offlineQueue = new OfflineQueue(db);
  router = new Router(db, silent);

  app = express();
  app.use(express.json());

  httpServer = http.createServer(app);
  hub = new WSHub(httpServer, db, auth, router, offlineQueue, silent);
  hub.start();

  // API routes registered after hub is constructed so the broadcast path
  // (which guards on `if (hub) { ... }` inside POST /groups/:id/messages) fires.
  const apiRouter = express.Router();
  registerGroupRoutes(apiRouter, db, auth, hub);
  app.use("/api", apiRouter);

  await new Promise<void>((r) => httpServer.listen(TEST_PORT, "127.0.0.1", r));

  aliceId = randomUUID();
  bobId = randomUUID();
  carolId = randomUUID();
  db.insertAgent({ id: aliceId, name: "Alice", description: "真人", domain: "test",
    tokenHash: hashToken(ALICE_TOKEN), token: ALICE_TOKEN,
    profile: JSON.stringify({ category: "真人" }) });
  db.insertAgent({ id: bobId, name: "Bob", description: "agent", domain: "test",
    tokenHash: hashToken(BOB_TOKEN), token: BOB_TOKEN });
  db.insertAgent({ id: carolId, name: "Carol", description: "agent", domain: "test",
    tokenHash: hashToken(CAROL_TOKEN), token: CAROL_TOKEN });

  groupId = randomUUID();
  db.createGroup(groupId, "G1", "Alice");
  db.addGroupMembers(groupId, ["Alice", "Bob", "Carol"]);
});

after(() => {
  router.stop();
  hub.stop();
  httpServer.close();
  db.close();
  try { fs.unlinkSync(TEST_DB); } catch {}
});

describe("WSHub group broadcast (真人发群消息)", () => {
  it("A.1 真人 a2a_send 群消息广播给所有其他成员", async () => {
    const alice = await rawConnect("Alice", ALICE_TOKEN);
    const bob = await rawConnect("Bob", BOB_TOKEN);
    const carol = await rawConnect("Carol", CAROL_TOKEN);

    const rid = `grp-a1-${Date.now()}`;
    alice.send({
      type: "a2a_send",
      requestId: rid,
      target: "Bob",
      payload: { message: "hello @Bob" },
      conversation: { type: "group", groupId, groupName: "G1" },
    });

    // Bob (target) 收到 1 条 targeted send (不重复)
    await waitFor(() => bob.msgs.some((m: any) => m.type === "a2a_message" && m.requestId === rid), 3000);
    const bobMsgs = bob.msgs.filter((m: any) => m.type === "a2a_message" && m.requestId === rid);
    assert.equal(bobMsgs.length, 1, "Bob should receive exactly 1 a2a_message (no duplicate from broadcast)");

    // Carol 收到 1 条 broadcast
    await waitFor(() => carol.msgs.some((m: any) => m.type === "a2a_message" && m.requestId === rid), 3000);
    const carolMsg = carol.msgs.find((m: any) => m.type === "a2a_message" && m.requestId === rid) as any;
    assert.equal(carolMsg.from.name, "Alice");
    assert.equal(carolMsg.payload.message, "hello @Bob");

    // Alice 收到 route_result
    await waitFor(() => alice.msgs.some((m: any) => m.type === "route_result" && m.requestId === rid), 3000);

    alice.close(); bob.close(); carol.close();
    await sleep(100);
  });

  it("A.2 HTTP POST /api/groups/:id/messages 触发 broadcast", async () => {
    const bob = await rawConnect("Bob", BOB_TOKEN);
    const carol = await rawConnect("Carol", CAROL_TOKEN);

    const post = await postJson(`/api/groups/${groupId}/messages`, {
      sender: "Alice",
      content: "hi from HTTP",
      mentions: [],
    });
    assert.equal(post.status, 201, `POST should return 201, got ${post.status}`);

    // Bob 收到 broadcast
    await waitFor(() => bob.msgs.some((m: any) => m.type === "a2a_message" && m.from?.name === "Alice" && m.payload?.message === "hi from HTTP"), 3000);
    const bobMsg = bob.msgs.find((m: any) => m.type === "a2a_message" && m.from?.name === "Alice" && m.payload?.message === "hi from HTTP") as any;
    assert.equal(bobMsg.from.name, "Alice");

    // Carol 收到 broadcast
    await waitFor(() => carol.msgs.some((m: any) => m.type === "a2a_message" && m.from?.name === "Alice" && m.payload?.message === "hi from HTTP"), 3000);

    // DB 入库
    const history = db.getGroupMessages(groupId, 50);
    assert.ok(history.some((m) => m.sender === "Alice" && m.content === "hi from HTTP"), "Message should be in DB");

    bob.close(); carol.close();
    await sleep(100);
  });

  it("A.3 sendAsAgent 群消息路径广播", async () => {
    const bob = await rawConnect("Bob", BOB_TOKEN);
    const carol = await rawConnect("Carol", CAROL_TOKEN);

    const result = hub.sendAsAgent({
      fromName: "Alice",
      target: "Bob",
      message: "hi from CLI",
      groupId,
      groupName: "G1",
    });
    assert.equal(result.error, undefined, `sendAsAgent should succeed, got error: ${result.error}`);
    assert.equal(result.delivered, true);

    await waitFor(() => bob.msgs.some((m: any) => m.type === "a2a_message" && m.payload?.message === "hi from CLI"), 3000);
    await waitFor(() => carol.msgs.some((m: any) => m.type === "a2a_message" && m.payload?.message === "hi from CLI"), 3000);

    bob.close(); carol.close();
    await sleep(100);
  });

  it("B2.1 发信人不在 group_members 时自动 addMembers 后再广播", async () => {
    // 创一个只有 Bob / Carol 的新群
    const newGroupId = randomUUID();
    db.createGroup(newGroupId, "G2", "Bob");
    db.addGroupMembers(newGroupId, ["Bob", "Carol"]);
    // Alice 不在 members 里

    const bob = await rawConnect("Bob", BOB_TOKEN);
    const carol = await rawConnect("Carol", CAROL_TOKEN);

    const rid = `grp-b21-${Date.now()}`;
    bob.send({
      type: "a2a_send",
      requestId: rid,
      target: "Carol",
      payload: { message: "ping" },
      conversation: { type: "group", groupId: newGroupId, groupName: "G2" },
    });

    // Carol 收到
    await waitFor(() => carol.msgs.some((m: any) => m.type === "a2a_message" && m.requestId === rid), 3000);

    // Bob 已被自动加入新群
    const members = db.getGroupMembers(newGroupId).map((m) => m.agent_name);
    assert.ok(members.includes("Bob"), `Bob should be auto-joined, members=${JSON.stringify(members)}`);

    bob.close(); carol.close();
    await sleep(100);
  });

  it("B2.2 sender 不是注册 agent 时 200 + 入库 + 不广播", async () => {
    const bob = await rawConnect("Bob", BOB_TOKEN);

    const before = bob.msgs.length;
    const post = await postJson(`/api/groups/${groupId}/messages`, {
      sender: "GhostAlice",
      content: "hi from ghost",
      mentions: [],
    });
    assert.equal(post.status, 201, `POST should return 201, got ${post.status}`);

    // DB 入库
    const history = db.getGroupMessages(groupId, 50);
    assert.ok(history.some((m) => m.sender === "GhostAlice" && m.content === "hi from ghost"), "Message should be in DB");

    // Bob 不应收到任何 a2a_message(等 500ms)
    await sleep(500);
    const newMessages = bob.msgs.slice(before);
    const ghostBroadcasts = newMessages.filter((m: any) => m.type === "a2a_message" && m.from?.name === "GhostAlice");
    assert.equal(ghostBroadcasts.length, 0, "Bob should not receive WS push for unregistered sender");

    bob.close();
    await sleep(100);
  });

  it("E.1 broadcast 排除 targetAgentId (不重复推给 target)", async () => {
    const alice = await rawConnect("Alice", ALICE_TOKEN);
    const bob = await rawConnect("Bob", BOB_TOKEN);
    const carol = await rawConnect("Carol", CAROL_TOKEN);

    const rid = `grp-e1-${Date.now()}`;
    alice.send({
      type: "a2a_send",
      requestId: rid,
      target: "Bob",
      payload: { message: "single target test" },
      conversation: { type: "group", groupId, groupName: "G1" },
    });

    await waitFor(() => bob.msgs.some((m: any) => m.type === "a2a_message" && m.requestId === rid), 3000);
    // 等待一小段时间确保 broadcast 已发
    await sleep(200);

    const bobMsgs = bob.msgs.filter((m: any) => m.type === "a2a_message" && m.requestId === rid);
    assert.equal(bobMsgs.length, 1, `Bob should receive exactly 1 message (target send only, broadcast excluded), got ${bobMsgs.length}`);

    // Carol 仍应收到
    await waitFor(() => carol.msgs.some((m: any) => m.type === "a2a_message" && m.requestId === rid), 3000);

    alice.close(); bob.close(); carol.close();
    await sleep(100);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function rawConnect(name: string, token: string): Promise<{
  ws: WebSocket;
  msgs: any[];
  send: (msg: any) => void;
  close: () => void;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
  const msgs: any[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    setTimeout(() => reject(new Error("Connect timeout")), 3000);
  });

  ws.on("message", (raw) => {
    try { msgs.push(JSON.parse(raw.toString())); } catch {}
  });

  ws.send(JSON.stringify({
    type: "auth", token, name,
    instance: { instanceId: randomUUID(), hostname: "test", platform: "test" },
  }));

  await waitFor(() => msgs.some((m) => m.type === "auth_ok"), 3000);

  return {
    ws,
    msgs,
    send: (msg: any) => ws.send(JSON.stringify(msg)),
    close: () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    },
  };
}

function postJson(path: string, body: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: TEST_PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: buf ? JSON.parse(buf) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: buf });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function waitFor(cond: () => boolean, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const check = () => {
      if (cond()) return resolve();
      if (Date.now() - t > ms) return reject(new Error("Timeout waiting for condition"));
      setTimeout(check, 30);
    };
    check();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
