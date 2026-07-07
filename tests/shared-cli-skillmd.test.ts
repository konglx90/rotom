/**
 * Shared tests — cli-detect (constants + fallback) + skill-md (idempotent write to ROTOM_HOME).
 *
 * detectInstalledClis / isCliInstalled 真正调 `which`,环境相关,不做强假设;
 * 只锁定常量、单工具探测的返回类型、detectCliTool 的优先级回落。
 *
 * skill-md 的 ROTOM_HOME 在模块加载时即被捕获为模块级常量,测试里事后改 env 不生效;
 * 故用子进程在 import 之前把 ROTOM_HOME 指向临时目录,隔离真实 ~/.rotom。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ALL_KNOWN_CLIS,
  CLI_PRIORITY,
  detectInstalledClis,
  isCliInstalled,
  detectCliTool,
} from "../src/shared/cli-detect.js";

// ---------------------------------------------------------------------------
// cli-detect
// ---------------------------------------------------------------------------

test("ALL_KNOWN_CLIS: 含 claude/openclaw/codex/hermes/pi", () => {
  for (const t of ["claude", "openclaw", "codex", "hermes", "pi"]) {
    assert.ok(ALL_KNOWN_CLIS.includes(t), `应含 ${t}`);
  }
});

test("CLI_PRIORITY: 排序为 claude > openclaw > codex > pi(不含 hermes 兜底)", () => {
  assert.deepEqual(CLI_PRIORITY, ["claude", "openclaw", "codex", "pi"]);
});

test("detectInstalledClis: 返回值是 ALL_KNOWN_CLIS 子集", () => {
  const found = detectInstalledClis();
  assert.ok(Array.isArray(found));
  for (const t of found) {
    assert.ok(ALL_KNOWN_CLIS.includes(t), `${t} 应在已知集合内`);
  }
});

test("isCliInstalled: 一个几乎不可能存在的 CLI 名应返回 false", () => {
  assert.equal(isCliInstalled("definitely-not-a-real-cli-xyz-rotom"), false);
});

test("detectCliTool: 返回 CLI_PRIORITY 中首个已安装项,否则回落 'claude'", () => {
  const t = detectCliTool();
  const ok = CLI_PRIORITY.includes(t) || t === "claude";
  assert.ok(ok, `detectCliTool 返回 ${t},应属优先级集合或回落 claude`);
});

// ---------------------------------------------------------------------------
// skill-md (ensureRotomSkillMd) —— 子进程隔离 ROTOM_HOME
// ---------------------------------------------------------------------------

const MODULE_PATH = path.resolve("src/shared/skill-md.ts");

function runInChildWithRotomHome(tmpHome: string, body: string): { status: number; stdout: string; stderr: string } {
  // tsx 的 --import hook 对 .mjs 里 import .ts 生效(参照 tests 既有用法),
  // 但对 -e eval 不稳定,故落临时 .mjs 脚本再跑。
  const script = `
    import { ensureRotomSkillMd } from "${MODULE_PATH}";
    ${body}
  `;
  const scriptPath = path.join(tmpHome, "run.mjs");
  fs.writeFileSync(scriptPath, script, "utf-8");
  const r = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    env: { ...process.env, ROTOM_HOME: tmpHome },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("ensureRotomSkillMd: 写入 ROTOM_HOME/SKILL.md 且内容与仓库 skill 源一致", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-skillmd-"));
  try {
    const r = runInChildWithRotomHome(tmpHome, `ensureRotomSkillMd(); console.log("done");`);
    assert.equal(r.status, 0, `子进程应退出 0,stderr=${r.stderr}`);
    const out = path.join(tmpHome, "SKILL.md");
    assert.ok(fs.existsSync(out), "应落盘 SKILL.md");

    const here = path.resolve(new URL(".", import.meta.url).pathname);
    const src = path.join(here, "..", "skill", "rotom-a2a-communicate", "SKILL.md");
    if (fs.existsSync(src)) {
      assert.equal(fs.readFileSync(out, "utf-8"), fs.readFileSync(src, "utf-8"), "内容应与源一致");
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("ensureRotomSkillMd: 幂等 —— 内容相同不触发重写", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-skillmd-idem-"));
  try {
    const body = `
      ensureRotomSkillMd();
      const fs = await import("node:fs");
      const p = (await import("node:path")).join(process.env.ROTOM_HOME, "SKILL.md");
      const m1 = fs.statSync(p).mtimeMs;
      ensureRotomSkillMd();
      const m2 = fs.statSync(p).mtimeMs;
      console.log(m1 === m2 ? "IDEM" : "REWROTE");
    `;
    const r = runInChildWithRotomHome(tmpHome, body);
    assert.equal(r.status, 0, `子进程应退出 0,stderr=${r.stderr}`);
    const out = path.join(tmpHome, "SKILL.md");
    assert.ok(fs.existsSync(out), "应落盘 SKILL.md");
    assert.match(r.stdout, /IDEM/, "内容相同应不改 mtime(幂等)");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
