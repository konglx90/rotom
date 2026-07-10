/**
 * Tests — shared/paths.ts worktree path helpers + resolveGroupWorktreeInfo 新旧路径 fallback。
 *
 * 覆盖:
 *   - group / issue 模式下 primaryWorktreePath / extraWorktreePath / groupReposContainer
 *     的路径形态(统一布局:worktree 挂在 ~/.rotom/artifacts/<groupId>/__repos/ 下)
 *   - extraSymlinkTarget 固定为 ../../<extraId>(容器内 2 级上)
 *   - resolveGroupWorktreeInfo:group 模式新路径存在 → 用新;旧路径存在新不存在 →
 *     用旧(过渡);都不存在 → 占位新路径、exists=false;issue 模式 → exists=false
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { MeshDb } from "../src/master/db.js";
import {
  ARTIFACTS_ROOT,
  REPOS_DIR_NAME,
  groupArtifactsDir,
  groupReposContainer,
  primaryWorktreePath,
  extraWorktreePath,
  extraSymlinkTarget,
} from "../src/shared/paths.js";
import { resolveGroupWorktreeInfo } from "../src/master/repo-scan.js";
import { getWorktreePathForUrl, repoNameFor } from "../src/executor/repo-cache.js";

const TEST_DB = `/tmp/mesh-test-paths-${Date.now()}.db`;
const REPOS_ROOT = path.join(os.homedir(), ".rotom", "repos");

let db: MeshDb;

describe("shared/paths: worktree 路径函数(统一布局)", () => {
  it("groupArtifactsDir = ~/.rotom/artifacts/<groupId>(完整 groupId)", () => {
    const gid = randomUUID();
    assert.equal(groupArtifactsDir(gid), path.join(ARTIFACTS_ROOT, gid));
  });

  it("group 模式:primary 在 <groupDir>/__repos/<repoName>(目录名用仓库名)", () => {
    const gid = randomUUID();
    const repoName = "wario";
    const p = primaryWorktreePath(gid, "group", repoName);
    assert.equal(p, path.join(groupArtifactsDir(gid), REPOS_DIR_NAME, repoName));
    assert.ok(p.includes("__repos"));
    assert.ok(p.endsWith("/wario"));
    // 不含 issueId8(group 模式 issueId 不参与路径)
    assert.ok(!p.includes("__repos/wario/__repos"));
  });

  it("issue 模式:primary 在 <groupDir>/__repos/<issueId8>/<repoName>", () => {
    const gid = randomUUID();
    const issueId8 = "abcd1234";
    const repoName = "wario";
    const p = primaryWorktreePath(gid, "issue", repoName, issueId8);
    assert.equal(p, path.join(groupArtifactsDir(gid), REPOS_DIR_NAME, issueId8, repoName));
  });

  it("extra 在容器下与 primary 同级", () => {
    const gid = randomUUID();
    const extraId = "repo-B";
    const pe = extraWorktreePath(gid, extraId, "group");
    const pp = primaryWorktreePath(gid, "group", "primary-repo");
    // 同一容器,不同末段
    assert.equal(path.dirname(pe), path.dirname(pp));
    assert.equal(path.basename(pe), extraId);
  });

  it("extraSymlinkTarget 固定 ../../<extraId>", () => {
    assert.equal(extraSymlinkTarget("repo-B"), path.join("..", "..", "repo-B"));
  });

  it("groupReposContainer: group 模式忽略 issueId8", () => {
    const gid = randomUUID();
    const c = groupReposContainer(gid, "group", "ignored123");
    assert.equal(c, path.join(groupArtifactsDir(gid), REPOS_DIR_NAME));
  });

  it("primaryDirName = repoNameFor(url)(master/executor 两边算同一个)", () => {
    const url = "git@code.alipay.com:cattery/rotom.git";
    assert.equal(repoNameFor(url), "rotom");
    const url2 = "https://github.com/konglx90/wario.git";
    assert.equal(repoNameFor(url2), "wario");
  });
});

describe("resolveGroupWorktreeInfo: 新旧路径 fallback", () => {
  const url = "https://example.com/org/repo.git";
  const repoName = repoNameFor(url); // "repo"
  let groupId: string;

  before(() => {
    db = new MeshDb(TEST_DB);
    groupId = randomUUID();
    db.createGroup(groupId, "g-repo", "tester");
    db.updateGroupRepo(groupId, url, "main", null, "group");
  });

  after(() => {
    // 清理本测试可能创建的目录
    const newP = primaryWorktreePath(groupId, "group", repoName);
    const intP = primaryWorktreePath(groupId, "group", "primary");
    const oldP = getWorktreePathForUrl(url, `group-${groupId.slice(0, 8)}`);
    for (const p of [newP, intP, oldP, path.dirname(newP), path.dirname(oldP)]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ }
    }
    db.close();
    try { fs.unlinkSync(TEST_DB); } catch { /* */ }
  });

  it("无 worktree(新旧都不存在)→ primaryExists=false,primaryPath 取新路径占位,primaryDirName=仓库名", () => {
    const info = resolveGroupWorktreeInfo(db, groupId);
    assert.ok(info);
    assert.equal(info!.mode, "group");
    assert.equal(info!.primaryDirName, repoName);
    assert.equal(info!.primaryExists, false);
    assert.equal(info!.primaryPath, primaryWorktreePath(groupId, "group", repoName));
  });

  it("旧路径存在(未迁移)→ primaryExists=true,primaryPath 取旧路径(过渡兼容)", () => {
    const oldP = getWorktreePathForUrl(url, `group-${groupId.slice(0, 8)}`);
    fs.mkdirSync(oldP, { recursive: true });
    try {
      const info = resolveGroupWorktreeInfo(db, groupId);
      assert.ok(info);
      assert.equal(info!.primaryExists, true);
      assert.equal(info!.primaryPath, oldP, "过渡期应取旧路径");
    } finally {
      try { fs.rmSync(oldP, { recursive: true, force: true }); } catch { /* */ }
      try {
        const parent = path.dirname(oldP);
        if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmSync(parent, { recursive: true, force: true });
      } catch { /* */ }
    }
  });

  it("中间路径 __repos/primary 存在(改名为仓库名前)→ primaryPath 取中间路径", () => {
    const intP = primaryWorktreePath(groupId, "group", "primary");
    fs.mkdirSync(intP, { recursive: true });
    try {
      const info = resolveGroupWorktreeInfo(db, groupId);
      assert.ok(info);
      assert.equal(info!.primaryExists, true);
      assert.equal(info!.primaryPath, intP, "中间态应取 __repos/primary");
      assert.equal(info!.primaryDirName, repoName, "primaryDirName 仍是仓库名(展示用)");
    } finally {
      try { fs.rmSync(intP, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("新路径存在(已迁移到仓库名)→ primaryExists=true,primaryPath 取新路径", () => {
    const newP = primaryWorktreePath(groupId, "group", repoName);
    fs.mkdirSync(newP, { recursive: true });
    try {
      const info = resolveGroupWorktreeInfo(db, groupId);
      assert.ok(info);
      assert.equal(info!.primaryExists, true);
      assert.equal(info!.primaryPath, newP);
    } finally {
      try { fs.rmSync(newP, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("group 无 repo_url → 返回 null", () => {
    const noRepo = randomUUID();
    db.createGroup(noRepo, "g-norepo", "tester");
    // updateGroupRepo 传空串清空 repo_url
    db.updateGroupRepo(noRepo, "", null, null, null);
    const info = resolveGroupWorktreeInfo(db, noRepo);
    assert.equal(info, null);
  });

  it("issue 模式 → primaryExists=false(per-issue,面板不展示单一 primary)", () => {
    const gid = randomUUID();
    db.createGroup(gid, "g-issue-mode", "tester");
    db.updateGroupRepo(gid, url, "main", null, "issue");
    const info = resolveGroupWorktreeInfo(db, gid);
    assert.ok(info);
    assert.equal(info!.mode, "issue");
    assert.equal(info!.primaryExists, false);
    // extras 也应 exists=false
    assert.ok(info!.extras.every(e => e.exists === false));
  });
});
