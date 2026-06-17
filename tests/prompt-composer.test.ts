/**
 * Unit test — Prompt 组合器
 *
 * Covers:
 *   - 5 layer order: rotom-cli → agent-role → group-basic → cwd → task
 *   - 无 group: group-basic 折叠
 *   - 无 cwd: cwd 折叠
 *   - 无 profile: role 层仍存在,标 "agents.profile = null"
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
    const ctx = baseCtx({ group: null });
    const out = composePrompt(ctx);
    assert.deepStrictEqual(layerNames(out.layers), ["rotom-cli", "agent-role", "task"]);
    assert.ok(!out.layers.some((l) => l.layer === "group-basic"));
  });

  it("无 cwd: cwd 折叠", () => {
    const ctx = baseCtx({ cwd: null });
    const out = composePrompt(ctx);
    assert.ok(!out.layers.some((l) => l.layer === "cwd"));
  });

  it("无 profile: role 层仍存在,标 agents.profile = null", () => {
    const ctx = baseCtx({ agentProfile: null });
    const out = composePrompt(ctx);
    const role = out.layers.find((l) => l.layer === "agent-role");
    assert.ok(role, "role layer should still exist");
    assert.strictEqual(role!.source, "agents.profile = null");
    assert.ok(role!.content.includes("无 profile"), "should mention no profile");
  });

  it("有 profile: 每行一个字段", () => {
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
  });

  it("profile 字段缺失: 标 (未填) 但层仍存在", () => {
    const ctx = baseCtx({ agentProfile: { category: "AI" } });
    const out = composePrompt(ctx);
    const role = out.layers.find((l) => l.layer === "agent-role")!;
    assert.ok(role.content.includes("position: (未填)"));
    assert.ok(role.content.includes("responsibilities: (未填)"));
    assert.ok(role.content.includes("tech_stack: (未填)"));
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

  it("group-basic 活跃 issue 列表正确渲染", () => {
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
    assert.ok(g.content.includes("#12345678"));
    assert.ok(g.content.includes("Fix bug"));
    assert.ok(g.content.includes("by Alice"));
    assert.ok(g.content.includes("[P1]"));
    assert.ok(g.content.includes("#87654321"));
    assert.ok(g.content.includes("未认领"));
  });

  it("group-basic 活跃 issue 为空: 显式说 '无' + 提示,引导 agent 果断执行", () => {
    const ctx = baseCtx({
      group: { id: "g", name: "G", activeIssues: [] },
    });
    const out = composePrompt(ctx);
    const g = out.layers.find((l) => l.layer === "group-basic")!;
    assert.ok(g.content.includes("无"));
    assert.ok(g.content.includes("rotom issue create"));
    // 关键:告诉 agent 占位任务自己干,不要反问
    assert.ok(g.content.includes("占位"), `应包含"占位"以引导 agent 果断执行,实际: ${g.content.slice(0, 200)}`);
    assert.ok(g.content.includes("不要反问"));
  });

  it("group + fromName: 渲染'发信人是=\"X\"'，让 agent 知道对话方身份", () => {
    const ctx = baseCtx({
      group: { id: "g1", name: "1000字科幻小说", activeIssues: [] },
      fromName: "孔令飞",
    });
    const out = composePrompt(ctx);
    const g = out.layers.find((l) => l.layer === "group-basic")!;
    assert.ok(g.content.includes("发信人是=\"孔令飞\""), `group-basic should include sender name, got: ${g.content.slice(0, 200)}`);
    // 同时仍保留 selfName
    assert.ok(g.content.includes("你自己是=\"Tester\""));
  });

  it("group + fromName=null: 不渲染发信人(向后兼容)", () => {
    const ctx = baseCtx({
      group: { id: "g1", name: "G", activeIssues: [] },
      fromName: null,
    });
    const out = composePrompt(ctx);
    const g = out.layers.find((l) => l.layer === "group-basic")!;
    assert.ok(!g.content.includes("发信人"));
  });

  it("group + fromName 未填(undefined): 不渲染发信人", () => {
    const ctx = baseCtx({
      group: { id: "g1", name: "G", activeIssues: [] },
    });
    const out = composePrompt(ctx);
    const g = out.layers.find((l) => l.layer === "group-basic")!;
    assert.ok(!g.content.includes("发信人"));
  });

  it("无 group + 有 fromName: group-basic 折叠,发信人也不渲染", () => {
    const ctx = baseCtx({ group: null, fromName: "孔令飞" });
    const out = composePrompt(ctx);
    assert.ok(!out.layers.some((l) => l.layer === "group-basic"));
    assert.ok(!out.final.includes("发信人"));
  });

  it("cwd 层 chat 模式提示只读语义,引导 agent 果断走 issue 而不是反问", () => {
    const ctx = baseCtx({ mode: "chat", cwd: "/Users/kong/work" });
    const out = composePrompt(ctx);
    const c = out.layers.find((l) => l.layer === "cwd")!;
    assert.ok(c.content.includes("/Users/kong/work"));
    assert.ok(c.content.includes("只读"));
    assert.ok(c.content.includes("不得调用 Write/Edit"));
    assert.ok(!c.content.includes("本次执行期间此目录可写"));
    // 引导 agent 一步到位
    assert.ok(c.content.includes("--run --approval-policy rw_allow"));
    // 引导 agent 不要反问
    assert.ok(c.content.includes("不要反问"), `应包含"不要反问"以引导 agent 果断执行,实际: ${c.content.slice(0, 300)}`);
  });

  it("cwd 层 issue 模式提示可写语义", () => {
    const ctx = baseCtx({ mode: "issue", cwd: "/Users/kong/work" });
    const out = composePrompt(ctx);
    const c = out.layers.find((l) => l.layer === "cwd")!;
    assert.ok(c.content.includes("/Users/kong/work"));
    assert.ok(c.content.includes("本次执行期间此目录可写"));
    assert.ok(c.content.includes("无需 dashboard 确认"));
    assert.ok(!c.content.includes("此目录为只读"));
  });

  it("cwd 层 collab 模式同样提示可写语义", () => {
    const ctx = baseCtx({ mode: "collab", cwd: "/Users/kong/work" });
    const out = composePrompt(ctx);
    const c = out.layers.find((l) => l.layer === "cwd")!;
    assert.ok(c.content.includes("本次执行期间此目录可写"));
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
你是一个 rotom Mesh 网络里的数字员工。所有 rotom 操作（发消息、建 issue、协作）通过 Bash 调用全局 \`rotom\` 命令完成。
- rotom 默认输出 JSON（加 --pretty 看表格）；所有命令自动用你当前 agent 身份，**不要传 --as**。
- 私聊 / 群消息 / 查历史 / 成员 / 通讯录 / 建 issue / 协作，命令清单见 \`~/.rotom/SKILL.md\`。
- 如需完整命令参考（含判定表、Issue 决策树、兜底话术），\`Read ~/.rotom/SKILL.md\`；不需要就忽略。
- 涉及写盘（Edit/Write/写 Bash）必须先有 in_progress issue 承载；看上方 [当前群活跃 issue] 段判断。
- 想直接落代码改动 / 写盘产出：用 \`rotom issue create <groupId> --title T --description D --assignee <self> --run --approval-policy rw_allow\` 一步到位：建任务 + 派给 worker + 工作目录可写 + 写盘自动放行。**占位 / 模板 / 简单示例类任务自己选合理内容直接落，不要反问用户"你想要什么内容"或"走 A 还是 B 方案"。**
`,
    );
  });

  it("ROTOM_CLI_PROMPT_VERSION 是字符串", () => {
    assert.strictEqual(typeof ROTOM_CLI_PROMPT_VERSION, "string");
    assert.ok(ROTOM_CLI_PROMPT_VERSION.length > 0);
  });
});
