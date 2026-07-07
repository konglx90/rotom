/**
 * DB tests — agent_sessions(upsert/sync/snapshot/invalidate/cost)+ links(url_norm 去重/occurrence/provenance/tags)。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { MeshDb } from "../src/master/db.js";

const TEST_DB = `/tmp/mesh-test-sess-link-${Date.now()}.db`;
const GROUP = "grp-sl-" + randomUUID().slice(0, 8);

let db: MeshDb;

describe("agent_sessions + links", () => {
  before(() => {
    db = new MeshDb(TEST_DB);
    db.createGroup(GROUP, "SessLink", "system");
  });

  after(() => {
    db.close();
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.unlinkSync(TEST_DB + ext); } catch {}
    }
  });

  // ── agent_sessions: upsert + 累计字段 ───────────────────────────────────
  it("upsertAgentSession: 首次插入,累计字段写入;再次 upsert 同 (cli,group,session) 更新 last_used", () => {
    db.upsertAgentSession({
      groupId: GROUP, agentName: "alice", cliTool: "claude", sessionId: "sess-1",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0.01 },
      model: "claude-x",
      cumulativeCostUsd: 0.01, cumulativeInputTokens: 100, cumulativeOutputTokens: 50,
    });
    const rows = db.listAgentSessionsByGroup(GROUP);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, "sess-1");
    assert.equal(rows[0].model, "claude-x");
    assert.equal(rows[0].cumulative_cost_usd, 0.01);
    assert.equal(rows[0].input_tokens, 100);

    const firstLastUsed = rows[0].last_used_at;
    // 再次 upsert(同一 session,新 turn)
    db.upsertAgentSession({
      groupId: GROUP, agentName: "alice", cliTool: "claude", sessionId: "sess-1",
      usage: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 10, cacheCreationTokens: 5, totalCostUsd: 0.03 },
      model: "claude-x",
      cumulativeCostUsd: 0.04, cumulativeInputTokens: 300, cumulativeOutputTokens: 130,
    });
    const after = db.listAgentSessionsByGroup(GROUP);
    assert.equal(after.length, 1, "同 (cli,group,session) 应 upsert 而非新增");
    assert.equal(after[0].input_tokens, 200, "最近 turn 用量被覆盖");
    assert.equal(after[0].cumulative_cost_usd, 0.04, "累计成本由 worker 上报覆盖");
    // last_used_at 刷新(同秒可能相等,故只断言非空且 created_at 不变)
    assert.ok(after[0].last_used_at);
    assert.equal(after[0].created_at, after[0].created_at);
  });

  it("upsertAgentSession: usage 缺省时 COALESCE 保留旧值", () => {
    db.upsertAgentSession({
      groupId: GROUP, agentName: "alice", cliTool: "claude", sessionId: "sess-coal",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0.001 },
    });
    // 第二次不传 usage
    db.upsertAgentSession({ groupId: GROUP, agentName: "alice", cliTool: "claude", sessionId: "sess-coal" });
    const row = db.findAgentSession("sess-coal");
    assert.equal(row?.input_tokens, 10, "未传 usage 时应保留旧 input_tokens(COALESCE)");
    assert.equal(row?.total_cost_usd, 0.001);
  });

  // ── listActiveAgentSessions / invalidate ────────────────────────────────
  it("invalidateAgentSession: 打 invalidated_at 戳,不删行;listActive 排除之", () => {
    db.upsertAgentSession({ groupId: GROUP, agentName: "bob", cliTool: "codex", sessionId: "sess-inv" });
    assert.equal(db.listActiveAgentSessions("bob", "codex").some((r) => r.session_id === "sess-inv"), true);
    const ok = db.invalidateAgentSession("codex", GROUP, "sess-inv");
    assert.equal(ok, true);
    assert.equal(db.listActiveAgentSessions("bob", "codex").some((r) => r.session_id === "sess-inv"), false, "失效后不应在 active 列表");
    const all = db.listAgentSessionsByGroup(GROUP);
    assert.ok(all.some((r) => r.session_id === "sess-inv" && r.invalidated_at), "失效行应保留并带 invalidated_at");
  });

  it("upsertAgentSession: 失效后的 session 再次收到 snapshot 时 invalidated_at 被清空(复活)", () => {
    db.upsertAgentSession({ groupId: GROUP, agentName: "carol", cliTool: "pi", sessionId: "sess-rev" });
    db.invalidateAgentSession("pi", GROUP, "sess-rev");
    assert.ok(db.findAgentSession("sess-rev")?.invalidated_at);
    // worker 重连后再次推同 session
    db.upsertAgentSession({ groupId: GROUP, agentName: "carol", cliTool: "pi", sessionId: "sess-rev" });
    assert.equal(db.findAgentSession("sess-rev")?.invalidated_at, null, "再次 upsert 应清空 invalidated_at");
    assert.equal(db.listActiveAgentSessions("carol", "pi").some((r) => r.session_id === "sess-rev"), true);
  });

  it("invalidateAgentSession: 不存在的 session 返回 false", () => {
    assert.equal(db.invalidateAgentSession("claude", GROUP, "nope"), false);
  });

  // ── deleteAgentSession / findAgentSession ────────────────────────────────
  it("deleteAgentSession: 硬删行;findAgentSession 查不到;不存在返回 false", () => {
    db.upsertAgentSession({ groupId: GROUP, agentName: "dave", cliTool: "hermes", sessionId: "sess-del" });
    assert.equal(db.deleteAgentSession("hermes", GROUP, "sess-del"), true);
    assert.equal(db.findAgentSession("sess-del"), undefined);
    assert.equal(db.deleteAgentSession("hermes", GROUP, "sess-del"), false, "删后再删返回 false");
  });

  it("findAgentSession: 按 sessionId 反查(active 优先于 invalidated)", () => {
    db.upsertAgentSession({ groupId: GROUP, agentName: "eve", cliTool: "claude", sessionId: "sess-find" });
    assert.equal(db.findAgentSession("sess-find")?.agent_name, "eve");
  });

  // ── links: createLink + url_norm 去重 ────────────────────────────────────
  it("createLink: url_norm UNIQUE 去重;getLinkByUrlNorm 反查", () => {
    const id = "lnk-" + randomUUID();
    db.createLink({ id, urlNorm: "https://react.dev/hooks", urlRaw: "https://react.dev/hooks", host: "react.dev" });
    assert.equal(db.getLink(id)?.host, "react.dev");
    assert.equal(db.getLinkByUrlNorm("https://react.dev/hooks")?.id, id);
    // 重复 url_norm 的新 id 应被 IGNORE
    const id2 = "lnk-" + randomUUID();
    db.createLink({ id: id2, urlNorm: "https://react.dev/hooks", urlRaw: "https://react.dev/hooks", host: "react.dev" });
    assert.equal(db.getLink(id2), undefined, "UNIQUE(url_norm) 冲突应被 IGNORE");
    assert.equal(db.getLink(id)?.id, id, "原 link 保留");
  });

  it("listUnclassifiedLinks: 只返回 category IS NULL 的 link,附 first_context", () => {
    const id = "lnk-" + randomUUID();
    db.createLink({ id, urlNorm: "https://example.com/unclassified-" + randomUUID().slice(0, 6), urlRaw: "https://example.com", host: "example.com" });
    db.addLinkOccurrence(id, { sourceType: "group_message", sourceGroupId: GROUP, sourceSender: "alice", contextSnippet: "看看这个" });
    const list = db.listUnclassifiedLinks(50);
    const hit = list.find((l) => l.id === id);
    assert.ok(hit, "新 link category 为空,应进未分类列表");
    assert.equal(hit!.first_context, "看看这个", "first_context 取最早一条 occurrence 的 snippet");
  });

  // ── occurrences + provenance ──────────────────────────────────────────────
  it("addLinkOccurrence + listOccurrencesForLink: 记录来源(group/sender/snippet)", () => {
    const id = "lnk-" + randomUUID();
    db.createLink({ id, urlNorm: "https://x.com/" + randomUUID().slice(0, 6), urlRaw: "https://x.com", host: "x.com" });
    db.addLinkOccurrence(id, { sourceType: "group_message", sourceGroupId: GROUP, sourceSender: "bob", contextSnippet: "ctx1" });
    db.addLinkOccurrence(id, { sourceType: "group_message", sourceGroupId: GROUP, sourceSender: "carol", contextSnippet: "ctx2" });
    const occ = db.listOccurrencesForLink(id);
    assert.equal(occ.length, 2);
    assert.ok(occ.some((o) => o.source_sender === "bob" && o.context_snippet === "ctx1"));
    assert.ok(occ.some((o) => o.source_sender === "carol"));
  });

  it("addLinkSourceGroup + listSourceGroupsForLink: 多对多来源群去重", () => {
    const id = "lnk-" + randomUUID();
    db.createLink({ id, urlNorm: "https://srcgrp.com/" + randomUUID().slice(0, 6), urlRaw: "https://srcgrp.com", host: "srcgrp.com" });
    db.addLinkSourceGroup(id, GROUP);
    db.addLinkSourceGroup(id, GROUP); // 重复 INSERT OR IGNORE
    assert.deepEqual(db.listSourceGroupsForLink(id), [GROUP]);
  });

  // ── updateLinkClassification + tags ──────────────────────────────────────
  it("updateLinkClassification: 写 category/title/summary;tags 传数组则重写", () => {
    const id = "lnk-" + randomUUID();
    db.createLink({ id, urlNorm: "https://cls.com/" + randomUUID().slice(0, 6), urlRaw: "https://cls.com", host: "cls.com" });
    db.updateLinkClassification(id, { category: "reference", title: "React Hooks 文档", summary: "官方 hooks", tags: ["react", "hooks"] });
    const row = db.getLink(id);
    assert.equal(row?.category, "reference");
    assert.equal(row?.title, "React Hooks 文档");
    assert.deepEqual(db.listTagsForLink(id), ["hooks", "react"], "标签按字典序");

    // 再次传 tags 重写(先 DELETE 再 INSERT)
    db.updateLinkClassification(id, { tags: ["frontend"] });
    assert.deepEqual(db.listTagsForLink(id), ["frontend"]);
    // 传空数组清空标签
    db.updateLinkClassification(id, { tags: [] });
    assert.deepEqual(db.listTagsForLink(id), []);
  });

  // ── listLinks / countLinks 过滤 ──────────────────────────────────────────
  it("listLinks + countLinks: category / tag / search / host 过滤", () => {
    const a = "lnk-" + randomUUID();
    const b = "lnk-" + randomUUID();
    db.createLink({ id: a, urlNorm: "https://filt-a.com/" + randomUUID().slice(0, 6), urlRaw: "https://filt-a.com", host: "filt-a.com" });
    db.createLink({ id: b, urlNorm: "https://filt-b.com/" + randomUUID().slice(0, 6), urlRaw: "https://filt-b.com", host: "filt-b.com" });
    db.updateLinkClassification(a, { category: "tool", tags: ["alpha"] });
    db.updateLinkClassification(b, { category: "article", tags: ["beta"] });

    const tools = db.listLinks({ category: "tool" });
    assert.ok(tools.some((l) => l.id === a));
    assert.ok(!tools.some((l) => l.id === b));

    const alphaTag = db.listLinks({ tag: "alpha" });
    assert.ok(alphaTag.some((l) => l.id === a));

    const searchHit = db.listLinks({ search: "filt-b" });
    assert.ok(searchHit.some((l) => l.id === b), "search 在 url_raw 上 LIKE 命中");

    const hostHit = db.listLinks({ host: "filt-a.com" });
    assert.ok(hostHit.some((l) => l.id === a));

    assert.equal(db.countLinks({ category: "tool" }) >= 1, true);
  });
});
