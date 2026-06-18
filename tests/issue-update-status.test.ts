/**
 * `--status` flag for `rotom issue update` + `PUT /issues/:id` status field.
 *
 * 覆盖:
 *  - CLI 拒绝非法 `--status`(本地校验,不依赖 master)
 *  - PUT `/issues/:id` body `{status}`:更新 DB 状态 + 写 `status_changed` 事件
 *  - 同值跳过(status === issue.status)不写事件
 *  - 非法值返回 400
 *  - 终态切换触发 db 层 side-effect(completed_at 写入)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { MeshDb } from "../src/master/db.js";
import { registerIssueRoutes } from "../src/master/api/issues.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const ROTOM_JS = path.join(REPO_ROOT, "dist", "cli", "rotom.js");
const TEST_DB = `/tmp/mesh-test-issue-status-${Date.now()}.db`;

let db: MeshDb;
let httpServer: http.Server;
let baseUrl: string;

function runRotom(args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [ROTOM_JS, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

async function putIssue(issueId: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/issues/${encodeURIComponent(issueId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

describe("issue update --status", () => {
  before(async () => {
    db = new MeshDb(TEST_DB);
    const app = express();
    app.use(express.json());
    const apiRouter = express.Router();
    registerIssueRoutes(apiRouter, db, null, undefined);
    app.use("/api", apiRouter);
    httpServer = http.createServer(app);
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const addr = (httpServer.address() as any);
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    httpServer.close();
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  });

  it("CLI 拒绝非法 --status(本地校验,exit 1)", async () => {
    const r = await runRotom(
      ["--as", "test-orphan", "issue", "update", "00000000-0000-0000-0000-000000000000", "--status", "foo"],
      { ROTOM_MASTER: "ws://127.0.0.1:1", ROTOM_TOKEN: "fake", ROTOM_AGENT: "test-orphan" },
    );
    assert.strictEqual(r.exitCode, 1, `expected exit 1, got ${r.exitCode}, stderr=${r.stderr}`);
    assert.match(r.stderr, /--status must be one of/);
    assert.match(r.stderr, /open\|in_progress\|completed\|failed\|cancelled/);
  });

  it("PUT status=open 把 cancelled issue reopen:DB 状态变 open + 写 status_changed 事件", async () => {
    const groupId = randomUUID();
    const issueId = randomUUID();
    db.createGroup(groupId, "g-status", "tester");
    db.createIssue({ id: issueId, groupId, title: "reopen me", createdBy: "tester" });
    // 先把它置为 cancelled,作为 reopen 的起点
    db.updateIssueStatus(issueId, "cancelled");
    const before = db.getIssueById(issueId);
    assert.equal(before?.status, "cancelled");

    const { status, json } = await putIssue(issueId, { status: "open" });
    assert.strictEqual(status, 200, `expected 200, got ${status}, body=${JSON.stringify(json)}`);

    const after = db.getIssueById(issueId);
    assert.equal(after?.status, "open");

    const events = db.getIssueEvents(issueId);
    const changed = events.filter((e) => e.event_type === "status_changed");
    assert.equal(changed.length, 1, `expected 1 status_changed event, got ${changed.length}`);
    assert.match(changed[0].content || "", /cancelled\s*→\s*open/);
    const meta = changed[0].metadata ? JSON.parse(changed[0].metadata as string) : null;
    assert.deepEqual(meta, { from: "cancelled", to: "open" });
  });

  it("PUT 同值 status 跳过(不写 status_changed 事件)", async () => {
    const groupId = randomUUID();
    const issueId = randomUUID();
    db.createGroup(groupId, "g-same", "tester");
    db.createIssue({ id: issueId, groupId, title: "same value", createdBy: "tester" });
    db.updateIssueStatus(issueId, "open");
    const eventsBefore = db.getIssueEvents(issueId).filter((e) => e.event_type === "status_changed").length;

    const { status, json } = await putIssue(issueId, { status: "open" });
    assert.strictEqual(status, 200, `got ${status}, body=${JSON.stringify(json)}`);

    const eventsAfter = db.getIssueEvents(issueId).filter((e) => e.event_type === "status_changed").length;
    assert.equal(eventsAfter, eventsBefore, "no status_changed event should be added for same value");
  });

  it("PUT 非法 status 返回 400 + DB 未变", async () => {
    const groupId = randomUUID();
    const issueId = randomUUID();
    db.createGroup(groupId, "g-bad", "tester");
    db.createIssue({ id: issueId, groupId, title: "bad value", createdBy: "tester" });
    db.updateIssueStatus(issueId, "open");

    const { status, json } = await putIssue(issueId, { status: "foo" });
    assert.strictEqual(status, 400, `expected 400, got ${status}`);
    assert.match(json.error || "", /status must be one of/);
    // 状态不变
    assert.equal(db.getIssueById(issueId)?.status, "open");
  });

  it("PUT status=completed 触发 db side-effect:completed_at 被写入", async () => {
    const groupId = randomUUID();
    const issueId = randomUUID();
    db.createGroup(groupId, "g-done", "tester");
    db.createIssue({ id: issueId, groupId, title: "finish it", createdBy: "tester" });

    const { status } = await putIssue(issueId, { status: "completed" });
    assert.strictEqual(status, 200);

    const after = db.getIssueById(issueId);
    assert.equal(after?.status, "completed");
    assert.ok(after?.completed_at, "completed_at should be set when transitioning to terminal");
  });
});
