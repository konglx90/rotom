/**
 * Shared pure-function tests — slash-commands (parseSlashCommand / buildPlanModeInstruction)
 * + group-context (injectGroupContext / prependWorkingDir).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SLASH_COMMAND_REGISTRY,
  parseSlashCommand,
  buildPlanModeInstruction,
} from "../src/shared/slash-commands.js";
import {
  injectGroupContext,
  prependWorkingDir,
  type GroupConversation,
} from "../src/shared/group-context.js";

// ---------------------------------------------------------------------------
// parseSlashCommand
// ---------------------------------------------------------------------------

test("parseSlashCommand: 空 title 返回 null", () => {
  assert.equal(parseSlashCommand(""), null);
});

test("parseSlashCommand: 命中 /plan 注册表 → known=true,stripped 去掉首个 token", () => {
  const r = parseSlashCommand("/plan 帮我设计一个新方案");
  assert.ok(r);
  assert.equal(r!.command, "/plan");
  assert.equal(r!.stripped, "帮我设计一个新方案");
  assert.equal(r!.known, true);
});

test("parseSlashCommand: 已注册命令无后续文本 → stripped 为空", () => {
  const r = parseSlashCommand("/plan");
  assert.ok(r);
  assert.equal(r!.command, "/plan");
  assert.equal(r!.stripped, "");
  assert.equal(r!.known, true);
});

test("parseSlashCommand: 形如 slash 但未注册 → known=false(交调用方决定)", () => {
  const r = parseSlashCommand("/research 调研下框架选型");
  assert.ok(r);
  assert.equal(r!.command, "/research");
  assert.equal(r!.known, false);
});

test("parseSlashCommand: /path/to 等非法 slash 形态不误判(返回 null)", () => {
  assert.equal(parseSlashCommand("/path/to/file"), null);
  assert.equal(parseSlashCommand("/UPPER 不允许大写"), null);
  assert.equal(parseSlashCommand("普通标题没有斜杠"), null);
  assert.equal(parseSlashCommand("/-dash 开头不合法"), null);
});

test("SLASH_COMMAND_REGISTRY: /plan 三后端均支持", () => {
  assert.deepEqual(SLASH_COMMAND_REGISTRY["/plan"].backends, ["claude", "codex", "pi"]);
});

// ---------------------------------------------------------------------------
// buildPlanModeInstruction
// ---------------------------------------------------------------------------

test("buildPlanModeInstruction: 含 [plan-mode] 标记与「等待用户审批」约束", () => {
  const s = buildPlanModeInstruction();
  assert.ok(s.startsWith("[plan-mode]"), "应以 [plan-mode] 开头");
  assert.ok(s.includes("等待用户审批"), "应包含等待审批约束");
  assert.ok(s.includes("未经确认不要执行任何写操作"), "应禁止未确认写操作");
});

// ---------------------------------------------------------------------------
// injectGroupContext
// ---------------------------------------------------------------------------

test("injectGroupContext: 非 group 会话(无 conversation / type≠group / 无 groupId)原样返回", () => {
  const prompt = "hi";
  assert.equal(injectGroupContext(prompt, undefined, "alice"), prompt);
  assert.equal(injectGroupContext(prompt, null, "alice"), prompt);
  assert.equal(injectGroupContext(prompt, { type: "direct" } as any, "alice"), prompt);
  assert.equal(injectGroupContext(prompt, { type: "group" } as any, "alice"), prompt); // 缺 groupId
});

test("injectGroupContext: group 会话注入 groupId/groupName/selfName 头", () => {
  const conv: GroupConversation = {
    type: "group",
    groupId: "g1",
    groupName: "本地群",
  } as any;
  const out = injectGroupContext("回答我", conv, "alice");
  assert.ok(out.includes("groupId=g1"), "应含 groupId");
  assert.ok(out.includes('groupName="本地群"'), "应含 groupName");
  assert.ok(out.includes('你自己是="alice"'), "应含 selfName");
  assert.ok(out.includes("回答我"), "应保留原 prompt");
});

test("injectGroupContext: groupName 缺省时回落到 groupId", () => {
  const conv = { type: "group", groupId: "g7" } as any;
  const out = injectGroupContext("p", conv, "bob");
  assert.ok(out.includes('groupName="g7"'), "缺省 groupName 应回落为 groupId");
});

test("injectGroupContext: 无活跃 issue 时提示先 rotom issue create", () => {
  const conv = { type: "group", groupId: "g1", activeIssues: [] } as any;
  const out = injectGroupContext("p", conv, "alice");
  assert.ok(out.includes("本群当前没有进行中的 issue"), "应提示无活跃 issue");
  assert.ok(out.includes("rotom issue create"), "应引导先建 issue");
});

test("injectGroupContext: 有活跃 issue 时逐条列出并提示关联", () => {
  const conv = {
    type: "group",
    groupId: "g1",
    activeIssues: [
      { id: "abcdef1234567890", status: "in_progress", title: "修 bug", assignedTo: "alice", priority: "high" },
    ],
  } as any;
  const out = injectGroupContext("p", conv, "alice");
  // id 取前 8 位
  assert.ok(out.includes("#abcdef12"), "应展示 issue id 前 8 位");
  assert.ok(out.includes('"修 bug"'), "应展示 title");
  assert.ok(out.includes("by alice"), "应展示 assignedTo");
  assert.ok(out.includes("[high]"), "应展示 priority");
  assert.ok(out.includes("涉及文件改动请关联以上某个 issue"), "应提示关联 issue");
});

// ---------------------------------------------------------------------------
// prependWorkingDir
// ---------------------------------------------------------------------------

test("prependWorkingDir: 空 cwd 原样返回", () => {
  assert.equal(prependWorkingDir("p", ""), "p");
  assert.equal(prependWorkingDir("p", undefined), "p");
  assert.equal(prependWorkingDir("p", null), "p");
});

test("prependWorkingDir: 注入 artifacts目录 头 + 只读约束 + 原始 prompt", () => {
  const out = prependWorkingDir("做事", "/repo/x");
  assert.ok(out.startsWith("[artifacts目录] /repo/x"), "应以 artifacts目录 头开头");
  assert.ok(out.includes("不得调用 Write/Edit"), "应声明只读禁止写盘");
  assert.ok(out.includes("做事"), "应保留原 prompt");
});
