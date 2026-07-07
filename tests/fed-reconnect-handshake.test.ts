/**
 * Federation tests —
 *  1. computeFedReconnectDelay 退避纯函数(3s→6→12→24→30 封顶,Phase 1.3)
 *  2. FedServer 握手:正常 ack / HOSTNAME_CONFLICT / PROTOCOL_MISMATCH
 *
 * 不连真实跨机网络 —— 用本地 loopback http server + ws 直连 /federation。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import { MeshDb } from "../src/master/db.js";
import { FedServer } from "../src/master/federation/server.js";
import { computeFedReconnectDelay } from "../src/master/federation/client.js";
import { FED_PROTOCOL_VERSION } from "../src/shared/protocol/federation.js";
import type { MasterIdentity } from "../src/master/federation/identity.js";

const TEST_DB = `/tmp/mesh-test-fed-${Date.now()}.db`;
let db: MeshDb;
let httpServer: http.Server;
let fedServer: FedServer;
let baseUrl: string;

const TEAM = "team-fed-" + randomUUID().slice(0, 6);
const SERVER_IDENTITY: MasterIdentity = { id: "coord01", hostname: "coord-host", role: "coordination" } as any;

function connectHandshake(path: string, handshake: Record<string, unknown>): Promise<{ ack: any; messages: any[]; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl}${path}`);
    const messages: any[] = [];
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify(handshake));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (msg.type === "fed_handshake_ack") {
        resolve({ ack: msg, messages, ws });
      }
    });
    ws.on("close", () => {
      // 若还没 resolve(被拒握手会先收到 ack 再 close),给个微延后让 message 先到
      setTimeout(() => {
        if (messages.length) resolve({ ack: messages[0], messages, ws });
        else reject(new Error("closed before any message"));
      }, 20);
    });
  });
}

describe("federation: 退避 + 握手", () => {
  before(async () => {
    db = new MeshDb(TEST_DB);
    httpServer = http.createServer((_, res) => res.end());
    fedServer = new FedServer(httpServer, db, { identity: SERVER_IDENTITY, teamId: TEAM });
    fedServer.start();
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    baseUrl = `ws://127.0.0.1:${(httpServer.address() as any).port}`;
  });

  after(async () => {
    fedServer.stop();
    httpServer.close();
    // fedServer.stop() 会 close 各 peer ws,其 server 端 handleClose 异步写 DB
    // (setVisibleOnline)。等一拍让这些 close handler 排空,再关 db,避免
    // "database connection is not open" 串扰后续测试。
    await new Promise<void>((r) => setTimeout(r, 60));
    db.close();
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(TEST_DB + ext); } catch {}
    }
  });

  // ── computeFedReconnectDelay ──────────────────────────────────────────────
  it("退避: 3s 起步,逐次翻倍,30s 封顶", () => {
    assert.equal(computeFedReconnectDelay(0), 3_000);
    assert.equal(computeFedReconnectDelay(1), 6_000);
    assert.equal(computeFedReconnectDelay(2), 12_000);
    assert.equal(computeFedReconnectDelay(3), 24_000);
    assert.equal(computeFedReconnectDelay(4), 30_000, "30s 封顶");
    assert.equal(computeFedReconnectDelay(5), 30_000);
    assert.equal(computeFedReconnectDelay(100), 30_000, "大 attempt 仍 30s");
  });

  it("退避: 单调递增(直到封顶)", () => {
    let prev = 0;
    for (let a = 0; a < 5; a++) {
      const d = computeFedReconnectDelay(a);
      assert.ok(d > prev, `attempt ${a} 应 > 前值 ${prev}`);
      prev = d;
    }
  });

  it("退避: 负 attempt 当 0 处理(防御)", () => {
    assert.equal(computeFedReconnectDelay(-1), 3_000);
  });

  // ── FedServer 握手 ───────────────────────────────────────────────────────
  it("握手: 合法 member → ack.accepted=true,带 serverMasterId/teamId,随后收到 directory sync", async () => {
    const { ack, messages, ws } = await connectHandshake("/federation", {
      type: "fed_handshake",
      masterId: "memberA",
      hostname: "memberA-host",
      role: "member",
      protocol: FED_PROTOCOL_VERSION,
    });
    assert.equal(ack.accepted, true);
    assert.equal(ack.serverMasterId, "coord01");
    assert.equal(ack.teamId, TEAM);
    // 握手成功后 server 立即推 directory sync
    assert.ok(messages.some((m) => m.type === "fed_directory_sync"), "应收到 directory sync");
    ws.close();
  });

  it("握手: 协议版本不符 → PROTOCOL_MISMATCH + close", async () => {
    const { ack, ws } = await connectHandshake("/federation", {
      type: "fed_handshake", masterId: "mProto", hostname: "proto-host",
      role: "member", protocol: FED_PROTOCOL_VERSION + 999,
    });
    assert.equal(ack.accepted, false);
    assert.equal(ack.error, "PROTOCOL_MISMATCH");
    ws.close();
  });

  it("握手: 非法 role → ROLE_MISMATCH", async () => {
    const { ack, ws } = await connectHandshake("/federation", {
      type: "fed_handshake", masterId: "mRole", hostname: "role-host",
      role: "bogus", protocol: FED_PROTOCOL_VERSION,
    });
    assert.equal(ack.accepted, false);
    assert.equal(ack.error, "ROLE_MISMATCH");
    ws.close();
  });

  it("握手: HOSTNAME_CONFLICT —— 同 hostname 不同 masterId 被拒", async () => {
    // 先让 memberA 加入(hostA),再让 memberB 用同 hostname 加入 → 冲突
    await connectHandshake("/federation", {
      type: "fed_handshake", masterId: "memberA2", hostname: "conflict-host",
      role: "member", protocol: FED_PROTOCOL_VERSION,
    }).then((r) => r.ws.close());

    const { ack, ws } = await connectHandshake("/federation", {
      type: "fed_handshake", masterId: "memberB", hostname: "conflict-host",
      role: "member", protocol: FED_PROTOCOL_VERSION,
    });
    assert.equal(ack.accepted, false);
    assert.equal(ack.error, "HOSTNAME_CONFLICT");
    ws.close();
  });

  it("握手: 同 masterId 重复加入同 hostname 不算冲突(upsert 幂等)", async () => {
    const first = await connectHandshake("/federation", {
      type: "fed_handshake", masterId: "memberRejoin", hostname: "rejoin-host",
      role: "member", protocol: FED_PROTOCOL_VERSION,
    });
    assert.equal(first.ack.accepted, true);
    first.ws.close();
    // 同 masterId + 同 hostname 再来一次应仍 accepted
    const second = await connectHandshake("/federation", {
      type: "fed_handshake", masterId: "memberRejoin", hostname: "rejoin-host",
      role: "member", protocol: FED_PROTOCOL_VERSION,
    });
    assert.equal(second.ack.accepted, true);
    second.ws.close();
  });
});
