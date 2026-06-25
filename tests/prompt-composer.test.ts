/**
 * Unit test — Prompt 组合器
 *
 * Covers:
 *   - 5 layer order: rotom-cli → agent-role → group-basic → cwd → task
 *   - 无 group: group-basic 折叠
 *   - 无 cwd: cwd 折叠
 *   - 无 profile / profile 全空: role 层折叠(null),不再占位
 *   - profile 部分字段缺失: 只输出非空字段
 *   - chat 模式 + fromName: 注入到 task 层头部一行([from=xxx])
 *   - issue/collab 模式 + fromName: 不注入(只有 chat 才有 fromName 语义)
 *   - 三种 mode 的 task.source 不同
 *   - ROTOM_CLI_PROMPT 文本 golden string 锁定(防止以后被改)
 *   - final 顺序与 layers 顺序一致(layers.join("\n"))
 *   - promptVersion 透出 ROTOM_CLI_PROMPT_VERSION
 *   - generatedAt 是 ISO 格式
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  composePrompt,
  type ComposeContext,
  type PromptLayer,
} from "../src/shared/prompt-composer.js";
import {
  ROTOM_CLI_PROMPT,
  ROTOM_CLI_PROMPT_VERSION,
} from "../src/shared/rotom-cli-prompt.js";

function baseCtx(overrides: Partial<ComposeContext> = {}): ComposeContext {
  return {
    mode: "chat",
    agentName: "Tester",
    agentProfile: null,
    group: null,
    cwd: null,
    body: "hi",
    ...overrides,
  };
}

function layerNames(layers: PromptLayer[]): string[] {
  return layers.map((l) => l.layer);
}

describe("composePrompt", () => {
  it("layer order: rotom-cli → agent-role → group-basic → cwd → task", () => {
    const ctx = baseCtx({
      agentProfile: { category: "AI", position: "FE" },
      group: {
        id: "g1",
        name: "G1",
        activeIssues: [],
      },
      cwd: "/tmp/work",
    });
    const out = composePrompt(ctx);
    assert.deepStrictEqual(layerNames(out.layers), [
      "rotom-cli",
      "agent-role",
      "group-basic",
      "cwd",
      "task",
    ]);
  });

  it("无 group: group-basic 折叠", () => {
    // 补一个非空 profile,确保 agent-role 层在(默认 agentProfile=null 时该层也折叠,
    // 这条测试只验证 group-basic 折叠行为,需要排除 agent-role 折叠的干扰)。
    const ctx = baseCtx({ group: null, agentProfile: { category: "AI" } });
    const out = composePrompt(ctx);
    assert.deepStrictEqual(layerNames(out.layers), ["rotom-cli", "agent-role", "task"]);
    assert.ok(!out.layers.some((l) => l.layer === "group-basic"));
  });

  it("无 cwd: cwd 折叠", () => {
    const ctx = baseCtx({ cwd: null });
    const out = composePrompt(ctx);
    assert.ok(!out.layers.some((l) => l.layer === "cwd"));
  });

  it("无 profile: role 层折叠(null),不占位", () => {
    const ctx = baseCtx({ agentProfile: null });
    const out = composePrompt(ctx);
    assert.ok(!out.layers.some((l) => l.layer === "agent-role"));
  });

  it("profile 全空字段: role 层折叠(null),不输出 (未填) 占位", () => {
    const ctx = baseCtx({ agentProfile: {} });
    const out = composePrompt(ctx);
    assert.ok(!out.layers.some((l) => l.layer === "agent-role"));
  });

  it("有 profile: 只输出非空字段,不带 (未填) 占位", () => {
    const ctx = baseCtx({
      agentProfile: {
        category: "AI",
        position: "Backend",
        responsibilities: "API",
        tech_stack: "Node",
      },
    });
    const out = composePrompt(ctx);
    const role = out.layers.find((l) => l.layer === "agent-role")!;
    assert.strictEqual(role.source, "agents.profile JSON (edit via rotom agent profile set)");
    assert.ok(role.content.includes("category: AI"));
    assert.ok(role.content.includes("position: Backend"));
    assert.ok(role.content.includes("responsibilities: API"));
    assert.ok(role.content.includes("tech_stack: Node"));
    assert.ok(!role.content.includes("(未填)"), "应不输出 (未填) 占位");
  });

  it("profile 部分字段缺失: 只输出非空字段", () => {
    const ctx = baseCtx({ agentProfile: { category: "AI" } });
    const out = composePrompt(ctx);
    const role = out.layers.find((l) => l.layer === "agent-role")!;
    assert.ok(role.content.includes("category: AI"));
    assert.ok(!role.content.includes("position"));
    assert.ok(!role.content.includes("responsibilities"));
    assert.ok(!role.content.includes("tech_stack"));
  });

  it("三种 mode 的 task.source 不同", () => {
    const chat = composePrompt(baseCtx({ mode: "chat", body: "x" }));
    const issue = composePrompt(baseCtx({ mode: "issue", body: "x" }));
    const collab = composePrompt(baseCtx({ mode: "collab", body: "x" }));
    const taskChat = chat.layers.find((l) => l.layer === "task")!;
    const taskIssue = issue.layers.find((l) => l.layer === "task")!;
    const taskCollab = collab.layers.find((l) => l.layer === "task")!;
    assert.ok(taskChat.source.includes("user message"));
    assert.ok(taskIssue.source.includes("issues.title"));
    assert.ok(taskCollab.source.includes("handleCollaborationStarted"));
  });

  it("final 顺序 = layers.content.join(\"\\n\")", () => {
    const ctx = baseCtx({
      agentProfile: { category: "AI" },
      group: { id: "g1", name: "G", activeIssues: [] },
      cwd: "/tmp/w",
      body: "user body",
    });
    const out = composePrompt(ctx);
    assert.strictEqual(out.final, out.layers.map((l) => l.content).join("\n"));
  });

  it("generatedAt 是 ISO 字符串", () => {
    const out = composePrompt(baseCtx());
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(out.generatedAt));
  });

  it("promptVersion 透出 ROTOM_CLI_PROMPT_VERSION", () => {
    const out = composePrompt(baseCtx());
    assert.strictEqual(out.promptVersion, ROTOM_CLI_PROMPT_VERSION);
  });

  it("rotom-cli 永远是第一层,内容 = ROTOM_CLI_PROMPT 常量", () => {
    const out = composePrompt(baseCtx());
    const first = out.layers[0];
    assert.strictEqual(first.layer, "rotom-cli");
    assert.strictEqual(first.content, ROTOM_CLI_PROMPT);
    assert.strictEqual(first.source, "src/shared/rotom-cli-prompt.ts (constant)");
  });

  it("group-basic 包含 groupId/groupName/agentName", () => {
    const ctx = baseCtx({
      group: { id: "abc-123", name: "My Group", activeIssues: [] },
    });
    const out = composePrompt(ctx);
    const g = out.layers.find((l) => l.layer === "group-basic")!;
    assert.ok(g.content.includes("groupId=abc-123"));
    assert.ok(g.content.includes("My Group"));
    assert.ok(g.content.includes("Tester"));
  });

  it("group-basic 活跃 issue 数量: 非空时显示 N 个进行中", () => {
    const ctx = baseCtx({
      group: {
        id: "g",
        name: "G",
        activeIssues: [
          { id: "12345678-aaaa", title: "Fix bug", assignedTo: "Alice", status: "in_progress", priority: "P1" },
          { id: "87654321-bbbb", title: "Refactor", assignedTo: null, status: "open", priority: null },
        ],
      },
    });
    const out = composePrompt(ctx);
    const g = out.layers.find((l) => l.layer === "group-basic")!;
    assert.ok(g.content.includes("[当前群活跃 issue] 2 个进行中"));
    // 不再渲染单条 issue 详情(ID / title / owner / priority 都不出现)
    assert.ok(!g.content.includes("#12345678"));
    assert.ok(!g.content.includes("Fix bug"));
    assert.ok(!g.content.includes("by Alice"));
    assert.ok(!g.content.includes("[P1]"));
  });

  it("group-basic 活跃 issue 数量: 1 个时显示 1 个进行中", () => {
    const ctx = baseCtx({
      group: {
        id: "g",
        name: "G",
        activeIssues: [
          { id: "abc12345-aaaa", title: "X", assignedTo: "B", status: "in_progress", priority: null },
        ],
      },
    });
    const out = composePrompt(ctx);
    const g = out.layers.find((l) => l.layer === "group-basic")!;
    assert.ok(g.content.includes("1 个进行中"));
  });

  it("group-basic 活跃 issue 为空: 显式说 '无'", () => {
    const ctx = baseCtx({
      group: { id: "g", name: "G", activeIssues: [] },
    });
    const out = composePrompt(ctx);
    const g = out.layers.find((l) => l.layer === "group-basic")!;
    assert.ok(g.content.includes("[当前群活跃 issue] 无"));
  });

  it("chat 模式 + group + fromName: fromName 注入到 task 层头部一行", () => {
    const ctx = baseCtx({
      mode: "chat",
      group: { id: "g1", name: "1000字科幻小说", activeIssues: [] },
      fromName: "孔令飞",
      body: "帮我看一下 X",
    });
    const out = composePrompt(ctx);
    const t = out.layers.find((l) => l.layer === "task")!;
    assert.ok(t.content.startsWith("[from=孔令飞]\n"), `task 应以 [from=孔令飞] 开头,实际: ${t.content.slice(0, 100)}`);
    assert.ok(t.content.includes("帮我看一下 X"));
    // 同时 group-basic 不再含 fromName
    const g = out.layers.find((l) => l.layer === "group-basic")!;
    assert.ok(!g.content.includes("发信人"));
    assert.ok(!g.content.includes("孔令飞"));
  });

  it("chat 模式 + group + fromName=null: task 层无 [from=xxx] 前缀", () => {
    const ctx = baseCtx({
      mode: "chat",
      group: { id: "g1", name: "G", activeIssues: [] },
      fromName: null,
      body: "hi",
    });
    const out = composePrompt(ctx);
    const t = out.layers.find((l) => l.layer === "task")!;
    assert.strictEqual(t.content, "hi");
  });

  it("chat 模式 + group + fromName 未填: task 层无 [from=xxx] 前缀", () => {
    const ctx = baseCtx({
      mode: "chat",
      group: { id: "g1", name: "G", activeIssues: [] },
      body: "hi",
    });
    const out = composePrompt(ctx);
    const t = out.layers.find((l) => l.layer === "task")!;
    assert.strictEqual(t.content, "hi");
  });

  it("issue/collab 模式 + fromName: fromName 不注入(只有 chat 才有 fromName 语义)", () => {
    const issueOut = composePrompt(baseCtx({ mode: "issue", fromName: "X", body: "任务" }));
    const collabOut = composePrompt(baseCtx({ mode: "collab", fromName: "X", body: "开场白" }));
    const issueTask = issueOut.layers.find((l) => l.layer === "task")!;
    const collabTask = collabOut.layers.find((l) => l.layer === "task")!;
    assert.strictEqual(issueTask.content, "任务");
    assert.strictEqual(collabTask.content, "开场白");
  });

  it("group-basic 不再含 fromName(只在 task 层)", () => {
    const ctx = baseCtx({
      mode: "chat",
      group: { id: "g1", name: "G", activeIssues: [] },
      fromName: "张三",
    });
    const out = composePrompt(ctx);
    const g = out.layers.find((l) => l.layer === "group-basic")!;
    assert.ok(!g.content.includes("张三"));
    assert.ok(!g.content.includes("发信人"));
  });

  it("cwd 层 chat 模式: 只读单行 + 指向 SKILL.md 锚点", () => {
    const ctx = baseCtx({ mode: "chat", cwd: "/Users/kong/work" });
    const out = composePrompt(ctx);
    const c = out.layers.find((l) => l.layer === "cwd")!;
    assert.ok(c.content.includes("/Users/kong/work"));
    assert.ok(c.content.includes("chat"));
    assert.ok(c.content.includes("只读"));
    assert.ok(c.content.includes("SKILL.md#写盘兜底话术"));
    assert.ok(!c.content.includes("不得调用 Write/Edit"));
  });

  it("cwd 层 issue 模式 rw_allow: 单行可写,无需 dashboard", () => {
    const ctx = baseCtx({ mode: "issue", cwd: "/Users/kong/work", approvalPolicy: "rw_allow" });
    const out = composePrompt(ctx);
    const c = out.layers.find((l) => l.layer === "cwd")!;
    assert.ok(c.content.includes("/Users/kong/work"));
    assert.ok(c.content.includes("rw_allow"));
    assert.ok(c.content.includes("无需 dashboard 确认"));
    assert.ok(!c.content.includes("只读"));
  });

  it("cwd 层 issue 模式 r_allow(默认): 单行可写 + 写盘挂起 + 只读 Bash 自动放行 + rw_allow 提示", () => {
    const ctx = baseCtx({ mode: "issue", cwd: "/Users/kong/work" });
    const out = composePrompt(ctx);
    const c = out.layers.find((l) => l.layer === "cwd")!;
    assert.ok(c.content.includes("/Users/kong/work"));
    assert.ok(c.content.includes("r_allow"));
    // 写类仍挂起审批
    assert.ok(c.content.includes("Accept/Deny"));
    // 只读 Bash 自动放行(新文案核心语义)
    assert.ok(c.content.includes("只读 Bash"));
    assert.ok(c.content.includes("自动放行"));
    // 列举若干典型只读命令,引导 agent
    assert.ok(c.content.includes("git status"));
    assert.ok(c.content.includes("rotom status"));
    // 仍提示 rw_allow 免审批兜底
    assert.ok(c.content.includes("--approval-policy rw_allow"));
  });

  it("cwd 层 collab 模式 + r_allow: 同 issue,既有挂起语义也有只读 Bash 放行语义", () => {
    const ctx = baseCtx({ mode: "collab", cwd: "/Users/kong/work", approvalPolicy: "r_allow" });
    const out = composePrompt(ctx);
    const c = out.layers.find((l) => l.layer === "cwd")!;
    assert.ok(c.content.includes("collab"));
    assert.ok(c.content.includes("可写"));
    assert.ok(c.content.includes("Accept/Deny"));
    assert.ok(c.content.includes("只读 Bash"));
    assert.ok(c.content.includes("自动放行"));
  });

  it("task body 透传", () => {
    const out = composePrompt(baseCtx({ body: "实际任务内容" }));
    const t = out.layers.find((l) => l.layer === "task")!;
    assert.strictEqual(t.content, "实际任务内容");
  });
});

describe("ROTOM_CLI_PROMPT golden string", () => {
  it("ROTOM_CLI_PROMPT 文本不漂移", () => {
    assert.strictEqual(
      ROTOM_CLI_PROMPT,
      `[rotom CLI 使用规则]
通过 Bash 调 \`rotom\` 操作 Mesh;详细见 ~/.rotom/SKILL.md,按需 Read(命令清单 / 行动判定 / 故障排查)。
- 默认 JSON 输出(加 --pretty 看表格),命令自动用当前 agent 身份,**不要传 --as**。
- **写盘前必须有 in_progress issue**;活跃 issue 数见下 [当前群活跃 issue]。

错误速查(stderr 第一行即可判断):
- HTTP 4xx → 命令参数错,改参数重试
- HTTP 5xx → master 异常,重试 1-2 次
- network error → 网络失败,先 \`rotom status\` 自检
- interrupted → master 已收但 body 截断,**非幂等别盲重试**

反模式:rotom 命令不要加 \`|| echo "X failed"\` 兜底——直接 stderr 透传,exit≠0 先 \`rotom status\`。
`,
    );
  });

  it("ROTOM_CLI_PROMPT 控制在 800 字节以内(瘦身目标)", () => {
    assert.ok(
      Buffer.byteLength(ROTOM_CLI_PROMPT, "utf8") < 800,
      `ROTOM_CLI_PROMPT 应 <800B,实际 ${Buffer.byteLength(ROTOM_CLI_PROMPT, "utf8")}B`,
    );
  });

  it("ROTOM_CLI_PROMPT_VERSION 是字符串", () => {
    assert.strictEqual(typeof ROTOM_CLI_PROMPT_VERSION, "string");
    assert.ok(ROTOM_CLI_PROMPT_VERSION.length > 0);
    assert.match(ROTOM_CLI_PROMPT_VERSION, /^rotomCliPrompt@\d{4}-\d{2}-\d{2}[a-z]$/);
  });
});
