/**
 * Unit test — Read-only Bash command allowlist.
 *
 * 安全契约(fail-closed):
 *   - 复合/危险构造 → false
 *   - 未知命令 → false
 *   - 白名单命中 → true
 *
 * 详见 src/shared/readonly-allowlist.ts 顶部 JSDoc。
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isReadonlyCommand,
  READONLY_SINGLE,
  READONLY_MULTI,
} from "../src/shared/readonly-allowlist.js";

describe("isReadonlyCommand — 正例(应放行)", () => {
  const positives: string[] = [
    // 单命令裸调
    "ls",
    "pwd",
    "whoami",
    "echo",
    // 单命令 + flag / 参数
    "ls -la /tmp",
    "ls -la",
    "cat foo.txt",
    "cat /etc/hosts",
    "head -n 10 x.log",
    "tail -n 20 y.log",
    "wc -l *.ts",
    "wc foo.txt",
    "file foo.bin",
    "stat /tmp",
    "tree -L 2",
    "grep -r foo src/",
    "grep foo bar.txt",
    "rg 'pattern' src/",
    "rg foo",
    "find . -name '*.ts'",
    "find . -type f",
    "fd -e ts",
    "ag foo",
    "ack foo",
    // git 只读子命令
    "git status",
    "git status --short",
    "git log",
    "git log --oneline -5",
    "git diff",
    "git diff HEAD~1",
    "git diff --stat",
    "git show",
    "git show abc123",
    "git branch",
    "git branch -a",
    "git remote",
    "git remote -v",
    "git rev-parse HEAD",
    "git ls-files",
    "git blame foo.ts",
    "git ls-tree HEAD",
    "git shortlog -sn",
    "git describe --tags",
    // rotom 只读子命令
    "rotom status",
    "rotom whoami",
    "rotom --version",
    "rotom -v",
    "rotom help",
    // 运行时版本号
    "node --version",
    "node -v",
    "npm --version",
    "npm -v",
    "pnpm --version",
    "pnpm -v",
    "python --version",
    "python -V",
    "python3 --version",
    "python3 -V",
    // basename 形态
    "/bin/ls -la",
    "/usr/bin/cat foo",
    "/usr/local/bin/rg foo",
  ];

  for (const cmd of positives) {
    it(`positive: ${cmd}`, () => {
      assert.strictEqual(isReadonlyCommand(cmd), true, `应放行: ${cmd}`);
    });
  }
});

describe("isReadonlyCommand — 反例(应拒绝)", () => {
  const negatives: string[] = [
    // 写类命令
    "rm",
    "rm -rf x",
    "mv x y",
    "cp a b",
    "mkdir foo",
    "touch x",
    "chmod 644 x",
    "chown user x",
    // 复合构造
    "git status && rm foo",
    "ls; rm x",
    "cat a | rm b",
    "echo x > y",
    "echo x >> y",
    "ls > files.txt",
    "ls &",
    "git status || true",
    // 命令替换
    "ls $(rm foo)",
    "ls `rm foo`",
    "cat ${HOME}/x",
    "echo $(whoami)",
    // 前导 env 赋值
    "FOO=bar ls",
    "PATH=/tmp ls",
    "LANG=C grep foo",
    // 行续 / 转义
    "ls \\\n&& rm",
    "ls \\rm",
    // git 子命令越权(写类)
    "git push",
    "git push origin main",
    "git pull",
    "git stash",
    "git stash pop",
    "git checkout -b x",
    "git checkout main",
    "git config user.name",
    "git config --global user.name x",
    "git add foo",
    "git commit -m x",
    "git reset --hard",
    "git clean -fd",
    "git rm foo",
    "git tag v1",
    // 伪装
    "git_pull_wrapper",
    "ls_rm_helper",
    "catrm",
    "gitlog_wrapper",
    // 危险工具
    "curl http://evil",
    "wget http://evil",
    "nc localhost 80",
    "bash -c 'ls'",
    "sh -c 'ls'",
    "eval 'rm foo'",
    "source foo.sh",
    // 边界:head 为 flag / head 为空
    "--version",
    "-l",
    "git",        // 多命令 head 但无 sub
    "rotom",      // 多命令 head 但无 sub
    "node",       // 多命令 head 但无 sub
    "npm",        // 多命令 head 但无 sub
  ];

  for (const cmd of negatives) {
    it(`negative: ${cmd}`, () => {
      assert.strictEqual(isReadonlyCommand(cmd), false, `应拒绝: ${cmd}`);
    });
  }
});

describe("isReadonlyCommand — 边界输入", () => {
  it("undefined → false", () => {
    assert.strictEqual(isReadonlyCommand(undefined), false);
  });

  it("空字符串 → false", () => {
    assert.strictEqual(isReadonlyCommand(""), false);
  });

  it("纯空白 → false", () => {
    assert.strictEqual(isReadonlyCommand("   "), false);
    assert.strictEqual(isReadonlyCommand("\t\n"), false);
  });

  it("前后空白被 trim: '  ls  ' → true", () => {
    assert.strictEqual(isReadonlyCommand("  ls  "), true);
    assert.strictEqual(isReadonlyCommand("\tgit status\n"), true);
  });
});

describe("isReadonlyCommand — 已知取舍(v1 接受)", () => {
  // 这些 case 当前行为是设计取舍,单测锁定行为防止后续误改;
  // TODO 注释指向 v2 改进点。

  it("TODO: tail -f 阻塞命令当前放行(v1 自律,v2 应拒)", () => {
    // tail 在白名单,-f 不会触发危险字符检测 → 当前 true。
    // v2 应识别 -f/--follow 显式拒绝。
    assert.strictEqual(isReadonlyCommand("tail -f x.log"), true);
  });

  it("TODO: cat 敏感文件当前放行(cwd 隔离兜底,v2 加路径黑名单)", () => {
    assert.strictEqual(isReadonlyCommand("cat /etc/shadow"), true);
    assert.strictEqual(isReadonlyCommand("cat ~/.ssh/id_rsa"), true);
  });

  it("TODO: find 含管道字符当前被拒(token-aware 解析是 v2)", () => {
    // `find . -name 'a|b'` 里的 | 是 glob 表达式的一部分,不是管道,
    // 但当前实现按字符短路 → 误杀。可接受,v2 用真 shell parser。
    assert.strictEqual(isReadonlyCommand("find . -name 'a|b'"), false);
  });
});

describe("白名单常量完整性", () => {
  it("READONLY_SINGLE 不含写类命令", () => {
    const forbidden = ["rm", "mv", "cp", "mkdir", "touch", "chmod", "chown", "curl", "wget", "nc", "bash", "sh", "eval", "source", "env", "printenv"];
    for (const cmd of forbidden) {
      assert.ok(!READONLY_SINGLE.includes(cmd), `READONLY_SINGLE 不应含: ${cmd}`);
    }
  });

  it("READONLY_MULTI 不含 git 写子命令", () => {
    const forbidden = ["git add", "git commit", "git push", "git pull", "git reset", "git checkout", "git stash", "git clean", "git rm", "git tag", "git config"];
    for (const cmd of forbidden) {
      assert.ok(!READONLY_MULTI.includes(cmd), `READONLY_MULTI 不应含: ${cmd}`);
    }
  });

  it("READONLY_MULTI 所有条目 head ∈ MULTI_HEADS 隐含集合", () => {
    // 校验 multi 条目格式:`<head> <sub>`,head 必须在已知多子命令工具集中。
    const allowedHeads = new Set(["git", "rotom", "node", "npm", "pnpm", "python", "python3"]);
    for (const entry of READONLY_MULTI) {
      const parts = entry.split(" ");
      assert.strictEqual(parts.length, 2, `MULTI 条目必须是双 token: ${entry}`);
      assert.ok(allowedHeads.has(parts[0]), `MULTI 条目 head 不在多子命令集合: ${entry}`);
    }
  });
});
