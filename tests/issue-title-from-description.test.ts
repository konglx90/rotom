/**
 * 合并 title/description 后,POST/PUT issue 路由的 title 自动截断行为。
 *
 * 覆盖:
 *  - POST 只传 description → title 从 description 前 N 字符截断
 *  - POST description 以 /plan 开头 → slash_command 落库 /plan,title 带 /plan 前缀
 *  - POST 同时传 title + description → 尊重显式 title,不截断
 *  - PUT 只传 description 不传 title → title 重新截断 + slash_command 重解析
 *  - POST 两者都空 → 400
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { MeshDb } from "../src/master/db.js";
import { registerIssueRoutes } from "../src/master/api/issues.js";
import { truncateTitle, TITLE_MAX_LENGTH } from "../src/shared/title.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const TEST_DB = `/tmp/mesh-test-issue-title-${Date.now()}.db`;

let db: MeshDb;
let httpServer: http.Server;
let baseUrl: string;

async function postIssue(groupId: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/groups/${encodeURIComponent(groupId)}/issues`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
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

describe("issue title from description", () => {
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

  it("truncateTitle:短文本不截断,长文本在词边界截断 + …", () => {
    assert.equal(truncateTitle("短标题"), "短标题");
    const long = "这是一个需要被截断的非常长的 issue 描述内容,用于验证截断逻辑是否真的能正常工作";
    const t = truncateTitle(long);
    assert.ok(t.endsWith("…"), `expected … suffix, got "${t}"`);
    assert.ok(t.length <= TITLE_MAX_LENGTH + 1, `length ${t.length} exceeds ${TITLE_MAX_LENGTH + 1}`);
  });

  it("truncateTitle:折叠空白", () => {
    assert.equal(truncateTitle("  多个\n空格  和\n换行  "), "多个 空格 和 换行");
  });

  it("POST 只传 description → title 自动截断,slash_command 为 null", async () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-desc-only", "tester");
    const { status, json } = await postIssue(groupId, {
      description: "实现一个登录表单,包含邮箱和密码字段",
      createdBy: "tester",
    });
    assert.strictEqual(status, 201, `expected 201, got ${status}, body=${JSON.stringify(json)}`);
    assert.ok(json.id, "should return issue id");
    assert.ok(json.title, "should return generated title");
    assert.ok(json.title.length <= TITLE_MAX_LENGTH + 1);

    const issue = db.getIssueById(json.id);
    assert.ok(issue);
    assert.equal(issue?.slash_command, null);
    assert.equal(issue?.description, "实现一个登录表单,包含邮箱和密码字段");
  });

  it("POST description 以 /plan 开头 → slash_command 落库 /plan", async () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-plan", "tester");
    const { status, json } = await postIssue(groupId, {
      description: "/plan 帮我重构认证模块,目标是拆分成多个小函数",
      createdBy: "tester",
    });
    assert.strictEqual(status, 201, `expected 201, got ${status}, body=${JSON.stringify(json)}`);
    assert.match(json.title, /^\/plan\b/, "title should keep /plan prefix for slash parsing");

    const issue = db.getIssueById(json.id);
    assert.equal(issue?.slash_command, "/plan");
  });

  it("POST 同时传 title + description → 尊重显式 title", async () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-explicit", "tester");
    const { status, json } = await postIssue(groupId, {
      title: "显式标题",
      description: "这是详细描述,内容比标题长很多,不应该影响标题",
      createdBy: "tester",
    });
    assert.strictEqual(status, 201);
    assert.equal(json.title, "显式标题");

    const issue = db.getIssueById(json.id);
    assert.equal(issue?.title, "显式标题");
    assert.equal(issue?.description, "这是详细描述,内容比标题长很多,不应该影响标题");
  });

  it("POST title 和 description 都空 → 400", async () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-empty", "tester");
    const { status, json } = await postIssue(groupId, { createdBy: "tester" });
    assert.strictEqual(status, 400);
    assert.match(json.error || "", /title or description is required/);
  });

  it("POST 只传 createdBy → 400", async () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-no-content", "tester");
    const { status } = await postIssue(groupId, { createdBy: "tester" });
    assert.strictEqual(status, 400);
  });

  it("PUT 只传 description 不传 title → title 重新截断 + slash_command 重解析", async () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-put", "tester");
    const issueId = randomUUID();
    db.createIssue({ id: issueId, groupId, title: "旧标题", description: "旧描述", createdBy: "tester" });

    const { status, json } = await putIssue(issueId, {
      description: "/plan 完全不同的新方案,需要先评审",
    });
    assert.strictEqual(status, 200, `expected 200, got ${status}, body=${JSON.stringify(json)}`);

    const after = db.getIssueById(issueId);
    assert.ok(after);
    assert.match(after?.title || "", /^\/plan\b/, "title should be re-truncated with /plan prefix");
    assert.equal(after?.slash_command, "/plan");
    assert.equal(after?.description, "/plan 完全不同的新方案,需要先评审");
  });

  it("PUT 显式传 title → 尊重显式 title,不从 description 截断", async () => {
    const groupId = randomUUID();
    db.createGroup(groupId, "g-put-title", "tester");
    const issueId = randomUUID();
    db.createIssue({ id: issueId, groupId, title: "原标题", description: "原描述", createdBy: "tester" });

    const { status } = await putIssue(issueId, {
      title: "手改的标题",
      description: "新描述内容",
    });
    assert.strictEqual(status, 200);

    const after = db.getIssueById(issueId);
    assert.equal(after?.title, "手改的标题");
  });
});
