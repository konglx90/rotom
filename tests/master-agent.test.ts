/**
 * Integration test — Master + Agent end-to-end
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { MeshDb } from "../src/master/db.js";
import { AuthService, hashToken } from "../src/master/auth.js";
import { WSHub } from "../src/master/ws-hub.js";
import { Router } from "../src/master/router.js";
import { OfflineQueue } from "../src/master/offline-queue.js";
import type { ServerMessage, AgentInfo } from "../src/shared/protocol.js";

const TEST_PORT = 19900;
const TEST_DB = `/tmp/mesh-test-${Date.now()}.db`;

const AGENT_A_TOKEN = "mesh_test_token_aaaa";
const AGENT_B_TOKEN = "mesh_test_token_bbbb";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let db: MeshDb;
let hub: WSHub;
let router: Router;
let httpServer: http.Server;

describe("Master + Agent Integration", () => {
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

    await new Promise<void>((r) => httpServer.listen(TEST_PORT, "127.0.0.1", r));

    db.insertAgent({ id: randomUUID(), name: "AgentA", description: "A", domain: "test",
      tokenHash: hashToken(AGENT_A_TOKEN) });
    db.insertAgent({ id: randomUUID(), name: "AgentB", description: "B", domain: "test",
      tokenHash: hashToken(AGENT_B_TOKEN) });
  });

  after(() => {
    router.stop();
    hub.stop();
    httpServer.close();
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  it("1. Agent connects and receives directory", async () => {
    const a = await rawConnect("AgentA", AGENT_A_TOKEN);
    const authOk = a.msgs.find((m: any) => m.type === "auth_ok") as any;
    assert.ok(authOk, "Should receive auth_ok");
    assert.ok(authOk.directory.length >= 2, "Directory should have >= 2 agents");
    a.close();
    await sleep(100);
  });

  it("2. Agent A sends to Agent B (exact route)", async () => {
    const a = await rawConnect("AgentA", AGENT_A_TOKEN);
    const b = await rawConnect("AgentB", AGENT_B_TOKEN);

    const rid = `req-${Date.now()}`;
    a.send({ type: "a2a_send", requestId: rid, target: "AgentB", payload: { message: "Hello" } });

    await waitFor(() => b.msgs.some((m: any) => m.type === "a2a_message"), 3000);
    const recv = b.msgs.find((m: any) => m.type === "a2a_message") as any;
    assert.equal(recv.from.name, "AgentA");
    assert.equal(recv.payload.message, "Hello");
    assert.equal(recv.routeType, "exact");

    await waitFor(() => a.msgs.some((m: any) => m.type === "route_result"), 3000);
    const rr = a.msgs.find((m: any) => m.type === "route_result") as any;
    assert.ok(rr.delivered);

    a.close(); b.close();
    await sleep(100);
  });

  it("3. Reply correlation — B replies to A", async () => {
    const a = await rawConnect("AgentA", AGENT_A_TOKEN);
    const b = await rawConnect("AgentB", AGENT_B_TOKEN);

    const rid = `req-reply-${Date.now()}`;
    a.send({ type: "a2a_send", requestId: rid, target: "AgentB", payload: { message: "Query" } });

    await waitFor(() => b.msgs.some((m: any) => m.type === "a2a_message"), 3000);
    b.send({ type: "a2a_reply", requestId: rid, payload: { message: "Answer" } });

    await waitFor(() => a.msgs.some((m: any) => m.type === "a2a_message" && m.routeType === "reply"), 3000);
    const reply = a.msgs.find((m: any) => m.type === "a2a_message" && m.routeType === "reply") as any;
    assert.equal(reply.from.name, "AgentB");
    assert.equal(reply.payload.message, "Answer");

    a.close(); b.close();
    await sleep(100);
  });

  it("4. No target — returns error", async () => {
    const a = await rawConnect("AgentA", AGENT_A_TOKEN);

    const rid = `req-notarget-${Date.now()}`;
    a.send({ type: "a2a_send", requestId: rid, payload: { message: "No target" } });

    await waitFor(() => a.msgs.some((m: any) => m.type === "route_result" && m.error), 3000);
    const rr = a.msgs.find((m: any) => m.type === "route_result" && m.error) as any;
    assert.equal(rr.delivered, false);
    assert.ok(rr.error);

    a.close();
    await sleep(100);
  });

  it("5. Offline messages — delivered on reconnect", async () => {
    // Make sure B is offline
    const agentB = db.getAgentByName("AgentB") as any;
    db.setAgentOffline(agentB.id);
    await sleep(50);

    // A sends while B offline
    const a = await rawConnect("AgentA", AGENT_A_TOKEN);
    const rid = `req-offline-${Date.now()}`;
    a.send({ type: "a2a_send", requestId: rid, target: "AgentB", payload: { message: "Offline msg" } });

    await waitFor(() => a.msgs.some((m: any) => m.type === "route_result"), 3000);
    const rr = a.msgs.find((m: any) => m.type === "route_result") as any;
    assert.equal(rr.delivered, false);
    assert.equal(rr.queued, true);

    // B connects — should receive offline_messages
    const b = await rawConnect("AgentB", AGENT_B_TOKEN);
    const offlineMsg = b.msgs.find((m: any) => m.type === "offline_messages") as any;
    assert.ok(offlineMsg, "Should receive offline_messages");
    assert.ok(offlineMsg.messages.some((m: any) => m.payload.message === "Offline msg"));

    a.close(); b.close();
    await sleep(100);
  });

  it("6. Dedup — duplicate requestId rejected", async () => {
    const a = await rawConnect("AgentA", AGENT_A_TOKEN);
    const b = await rawConnect("AgentB", AGENT_B_TOKEN);

    const rid = `req-dedup-${Date.now()}`;
    a.send({ type: "a2a_send", requestId: rid, target: "AgentB", payload: { message: "First" } });
    await sleep(200);
    a.send({ type: "a2a_send", requestId: rid, target: "AgentB", payload: { message: "Second" } });
    await sleep(500);

    const bReceived = b.msgs.filter((m: any) => m.type === "a2a_message");
    assert.equal(bReceived.length, 1, "B should receive only 1 message");

    const dupResult = a.msgs.find((m: any) => m.type === "route_result" && m.error === "Duplicate message");
    assert.ok(dupResult, "Should get duplicate error for second send");

    a.close(); b.close();
  });
});

// ---------------------------------------------------------------------------
// Raw WebSocket helper (no reconnect — clean for tests)
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

  // Auth
  ws.send(JSON.stringify({
    type: "auth", token, name,
    instance: { instanceId: randomUUID(), hostname: "test", platform: "test" },
  }));

  // Wait for auth_ok
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
