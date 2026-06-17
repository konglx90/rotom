/**
 * rotom CLI 错误分类测试 —— 防止西花-codex 这类 LLM 把 HTTP 业务错
 * 误读成"master 没启动"。
 *
 * 背景见 plans/twinkly-waddling-creek.md:
 * - 旧版 rotom CLI 把网络错和 HTTP 错都长成 `rotom: <text>`,LLM 看到
 *   "rotom:" 前缀就容易把所有失败总结成"rotom 没启动"报给用户。
 * - 改后分三类:
 *   1. `rotom: command failed: HTTP <s> ... (this is a command error, master is up)` + exit 1
 *      → 业务错,master 正常,修命令重试。
 *   2. `rotom: network error talking to master at <url>: <reason>` + exit 75
 *      → fetch() 抛(连接被拒 / socket reset / DNS 等),**请求可能已到 master**,
 *        提示 LLM 跑 `rotom status` 自检 + 查 master log。
 *   3. `rotom: response from master was interrupted at <url> ...` + exit 75
 *      → resp.text() 抛(master 已发 headers + 部分 body,流被截断),
 *        **master 几乎肯定处理了请求**,警告 LLM 不要盲目重试非幂等操作。
 * - 幂等方法(GET/PUT/DELETE)网络错自动重试 1 次,POST 不重试避免双发。
 * - `rotom status` 子命令作为 LLM 自检入口。
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
import net from "node:net";

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

  it("2. master 不可达时 rotom status 应该报 'network error talking to master' + exit 75", async () => {
    // 指向 127.0.0.1:1 —— 死端口,确保 connect 立即失败。
    const r = await runRotom(["status"], { ROTOM_MASTER: "ws://127.0.0.1:1" });
    assert.strictEqual(r.exitCode, 75, `expected exit 75 (EX_TEMPFAIL), got ${r.exitCode}, stderr=${r.stderr}`);
    assert.match(r.stderr, /rotom: network error talking to master at/);
    // 关键:必须引导 LLM 去 `rotom status` 自检,不要直接断定"master 挂了"
    assert.match(r.stderr, /run `rotom status` to verify reachability/);
    // 关键:必须提醒 LLM 请求可能已到 master,避免盲目重试 POST
    assert.match(r.stderr, /request may have reached master/);
  });

  it("3. master 不可达时 rotom issue delete (走 /api) 同样报 'network error' + exit 75", async () => {
    // 这里 fall-through 取决于 auto-discovery 是否先找到西花-codex 走配置;如果
    // 走的是 config(里面 master 是 28800),结果会是 HTTP 404 而不是 network 错。
    // 强制走 env 路径:把 ROTOM_AGENT 指向一个不在 config 里的名字,确保走 env。
    const r2 = await runRotom(
      ["--as", "test-orphan-agent", "issue", "delete", "00000000-0000-0000-0000-000000000000"],
      { ROTOM_MASTER: "ws://127.0.0.1:1", ROTOM_TOKEN: "fake-but-valid-format", ROTOM_AGENT: "test-orphan-agent" },
    );
    // 这条会进 env fallback 路径,master 走 env(死端口),所以应该 network 错。
    assert.strictEqual(r2.exitCode, 75, `expected exit 75, got ${r2.exitCode}, stderr=${r2.stderr}`);
    assert.match(r2.stderr, /rotom: network error talking to master at/);
    // DELETE 是幂等的,自动重试 1 次后才会 fail —— 验证 stderr 包含诊断提示
    assert.match(r2.stderr, /run `rotom status` to verify reachability/);
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

  it("6. master 发了 headers + 部分 body 后断流(partial response)→ 报 'response from master was interrupted' + exit 75", async () => {
    // 用 raw TCP server 模拟 HTTP/1.1 keep-alive socket reset:发完 status line + headers +
    // 写一点 body 立刻 destroy socket。Node.js undici 拿到 Response(status + headers) 后
    // 调 resp.text() 会抛 → 走 partial-response 分支。
    const fakePort = 19380 + Math.floor(Math.random() * 200);
    const server = net.createServer((socket) => {
      socket.write(
        "HTTP/1.1 404 Not Found\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 200\r\n" +
        "\r\n" +
        '{"error":"Issue not found, body cut mid-stream',
      );
      // 关键:写到一半 destroy,触发 undici 的 body stream error
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(fakePort, "127.0.0.1", r));

    try {
      const r = await runRotom(
        ["--as", "test-orphan", "issue", "delete", "00000000-0000-0000-0000-000000000000"],
        { ROTOM_MASTER: `ws://127.0.0.1:${fakePort}`, ROTOM_TOKEN: "fake", ROTOM_AGENT: "test-orphan" },
      );
      assert.strictEqual(r.exitCode, 75, `expected exit 75, got ${r.exitCode}, stderr=${r.stderr}`);
      // 关键:必须明确走"partial-response"前缀,不是"network error talking to master"
      assert.match(r.stderr, /rotom: response from master was interrupted at/);
      // 必须含 status(说明 headers 收到了)+ "body stream was cut off"
      assert.match(r.stderr, /body stream was cut off/);
      // 关键警告:必须告诉 LLM 不要盲目重试非幂等操作
      assert.match(r.stderr, /Do NOT blindly retry/);
      assert.match(r.stderr, /non-idempotent operations/);
      // partial-response 不重试(避免 POST 双发),所以 stderr 不应该有 "network error talking"
      assert.doesNotMatch(r.stderr, /network error talking to master/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("7. 幂等方法(network 错)在 master 不可达时自动重试 1 次 → 最终 exit 75 + 'network error'", async () => {
    // DELETE 是幂等的,api() 应该尝试 2 次(均失败)后才 fail。
    // 死端口 → 2 次 connect refused,800ms sleep + retry,总共 ~1.6s。
    const start = Date.now();
    const r = await runRotom(
      ["--as", "test-orphan", "issue", "delete", "00000000-0000-0000-0000-000000000000"],
      { ROTOM_MASTER: "ws://127.0.0.1:1", ROTOM_TOKEN: "fake", ROTOM_AGENT: "test-orphan" },
    );
    const elapsed = Date.now() - start;
    assert.strictEqual(r.exitCode, 75, `expected exit 75, got ${r.exitCode}, stderr=${r.stderr}`);
    assert.match(r.stderr, /rotom: network error talking to master at/);
    // 重试时 sleep 800ms,所以总耗时应该 ≥ 800ms
    assert.ok(elapsed >= 700, `expected retry to take ~800ms, elapsed=${elapsed}ms`);
  });

  it("8. POST 错误信息(network 错)走 'network error' 分支(POST 不重试避免双发)", async () => {
    // POST 不重试,所以总耗时应该 < 800ms(没有 sleep 等待)。
    // 走 group send 路径(内部用 POST /cli/groups/:id/send)。
    const start = Date.now();
    const r = await runRotom(
      [
        "--as", "test-orphan", "group", "send",
        "00000000-0000-0000-0000-000000000000",
        "target-agent",
        "hello",
      ],
      { ROTOM_MASTER: "ws://127.0.0.1:1", ROTOM_TOKEN: "fake", ROTOM_AGENT: "test-orphan" },
    );
    const elapsed = Date.now() - start;
    assert.strictEqual(r.exitCode, 75, `expected exit 75, got ${r.exitCode}, stderr=${r.stderr}`);
    assert.match(r.stderr, /rotom: network error talking to master at/);
    // POST 不重试,所以 elapsed 应该 < 700ms(没有 800ms sleep)
    assert.ok(elapsed < 700, `POST should NOT retry, elapsed=${elapsed}ms`);
  });

  it("9. master 接受了 TCP 但立刻关掉(无响应) → 也走 'network error'(非 partial-response)", async () => {
    // 与 case 6 区分:case 6 是 server 发了 headers + 部分 body,resp.text() 抛;
    // 本 case 是 server 什么都不发,fetch() 阶段就抛,resp 没拿到,partial=false。
    const fakePort = 19580 + Math.floor(Math.random() * 200);
    const server = net.createServer((socket) => {
      // 接受连接后立刻 destroy,不发任何东西
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(fakePort, "127.0.0.1", r));

    try {
      const r = await runRotom(
        ["--as", "test-orphan", "issue", "delete", "00000000-0000-0000-0000-000000000000"],
        { ROTOM_MASTER: `ws://127.0.0.1:${fakePort}`, ROTOM_TOKEN: "fake", ROTOM_AGENT: "test-orphan" },
      );
      // DELETE 重试 1 次后失败
      assert.strictEqual(r.exitCode, 75, `expected exit 75, got ${r.exitCode}, stderr=${r.stderr}`);
      // 关键:走 network 路径(不是 partial-response)
      assert.match(r.stderr, /rotom: network error talking to master at/);
      assert.doesNotMatch(r.stderr, /response from master was interrupted/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
