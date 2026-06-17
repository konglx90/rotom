/**
 * rotom CLI 错误分类测试 —— 防止西花-codex 这类 LLM 把 HTTP 业务错
 * 误读成"master 没启动"。
 *
 * 背景见 plans/twinkly-waddling-creek.md:
 * - 旧版 rotom CLI 把网络错和 HTTP 错都长成 `rotom: <text>`,LLM 看到
 *   "rotom:" 前缀就容易把所有失败总结成"rotom 没启动"报给用户。
 * - 改后:`rotom: command failed: HTTP 4xx ... (this is a command error,
 *   master is up)` 给 HTTP 错,`rotom: master unreachable at <url> ...` + exit 75
 *   给网络错。`rotom status` 子命令作为 LLM 自检入口。
 *
 * 这些 case 跑 rotom CLI 子进程(用 dist/ 里的编译产物),不依赖 source map,
 * 改 failKind 字符串时记得同步这里的断言。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const ROTOM_JS = path.join(REPO_ROOT, "dist", "cli", "rotom.js");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runRotom(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
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

describe("rotom CLI 错误分类", () => {
  it("1. 不存在的 agent 应该报 'agent not registered',exit 1", async () => {
    const r = await runRotom(["--as", "nonexistent-agent-xyz", "whoami"]);
    assert.strictEqual(r.exitCode, 1, `expected exit 1, got ${r.exitCode}, stderr=${r.stderr}`);
    assert.match(r.stderr, /agent "nonexistent-agent-xyz" not registered/);
  });

  it("2. master 不可达时 rotom status 应该报 'master unreachable' + exit 75", async () => {
    // 指向 127.0.0.1:1 —— 死端口,确保 connect 立即失败。
    const r = await runRotom(["status"], { ROTOM_MASTER: "ws://127.0.0.1:1" });
    assert.strictEqual(r.exitCode, 75, `expected exit 75 (EX_TEMPFAIL), got ${r.exitCode}, stderr=${r.stderr}`);
    assert.match(r.stderr, /rotom: master unreachable at/);
    assert.match(r.stderr, /try `rotom status` or `rotom master start`/);
  });

  it("3. master 不可达时 rotom issue delete (走 /api) 同样报 'master unreachable' + exit 75", async () => {
    const r = await runRotom(
      ["--as", "西花-codex", "issue", "delete", "00000000-0000-0000-0000-000000000000"],
      { ROTOM_MASTER: "ws://127.0.0.1:1", ROTOM_TOKEN: "fake-but-valid-format" },
    );
    // 这里 fall-through 取决于 auto-discovery 是否先找到西花-codex 走配置;如果
    // 走的是 config(里面 master 是 28800),结果会是 HTTP 404 而不是 network 错。
    // 强制走 env 路径:把 ROTOM_AGENT 指向一个不在 config 里的名字,确保走 env。
    const r2 = await runRotom(
      ["--as", "test-orphan-agent", "issue", "delete", "00000000-0000-0000-0000-000000000000"],
      { ROTOM_MASTER: "ws://127.0.0.1:1", ROTOM_TOKEN: "fake-but-valid-format", ROTOM_AGENT: "test-orphan-agent" },
    );
    // 这条会进 env fallback 路径,master 走 env(死端口),所以应该 network 错。
    assert.strictEqual(r2.exitCode, 75, `expected exit 75, got ${r2.exitCode}, stderr=${r2.stderr}`);
    assert.match(r2.stderr, /rotom: master unreachable at/);
  });

  it("4. master 健康时 rotom status 应该返回 reachable=true + exit 0", async () => {
    // 临时起一个假 master,只服务 /health,无鉴权。模拟 plan 里的 cmdStatus 路径。
    const fakePort = 19080 + Math.floor(Math.random() * 200);
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", total: 3, online: 2, domains: 1 }));
    });
    await new Promise<void>((r) => server.listen(fakePort, "127.0.0.1", r));

    try {
      const r = await runRotom(["status"], { ROTOM_MASTER: `ws://127.0.0.1:${fakePort}` });
      assert.strictEqual(r.exitCode, 0, `expected exit 0, got ${r.exitCode}, stderr=${r.stderr}`);
      assert.match(r.stdout, /"reachable":\s*true/);
      assert.match(r.stdout, /"online":\s*2/);
      assert.match(r.stdout, /"total":\s*3/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("5. master 健康但 issue 不存在(404)时,error 必须含 'this is a command error, master is up'(避免 codex 误读成 master down)", async () => {
    // 起一个假 master,只服务 /api/issues/:id,返回 404 + JSON 错误体。
    const fakePort = 19180 + Math.floor(Math.random() * 200);
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith("/api/issues/")) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Issue not found" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(fakePort, "127.0.0.1", r));

    try {
      const r = await runRotom(
        ["--as", "test-orphan", "issue", "delete", "00000000-0000-0000-0000-000000000000"],
        { ROTOM_MASTER: `ws://127.0.0.1:${fakePort}`, ROTOM_TOKEN: "fake", ROTOM_AGENT: "test-orphan" },
      );
      assert.strictEqual(r.exitCode, 1, `expected exit 1, got ${r.exitCode}, stderr=${r.stderr}`);
      // 关键断言:错误必须明确说"this is a command error, master is up",
      // 这正是 plan 里的关键修复点 —— 不让 LLM 把它和"master down"混淆。
      assert.match(r.stderr, /rotom: command failed: HTTP 404/);
      assert.match(r.stderr, /this is a command error, master is up/);
      // 防御性断言:404 错误的 stderr **不应该** 出现"unreachable"(那是网络错前缀)。
      assert.doesNotMatch(r.stderr, /master unreachable/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
