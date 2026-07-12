#!/usr/bin/env node
/**
 * migrate-group-ids.ts —— 一次性迁移:把既有群的 UUID 改为 12 字符 base62 短 ID。
 *
 * 覆盖:
 *   1. DB   —— groups.id 主键 + 所有 *group_id 外键列(groups.working_dir 路径改写)
 *   2. 磁盘 —— artifacts/<id>、uploads/<月>/<id>、results/<id>(legacy)
 *   3. JSON —— sessions.json 的 `${cliTool}:${id}` key、executor.config.json 的 workingDirMap
 *   4. Git  —— bare 仓库的派生分支 `<base>-rotom-<groupId8>` 重命名 +
 *              worktree 路径重连(`git worktree repair <新路径>`)+ 旧布局 slot 改名
 *
 * 安全:
 *   - 必须 `rotom stop`(检测 ~/.rotom/run/{master,local-executor,link}.pid,存活则拒绝)
 *   - --dry-run 只打印不执行
 *   - --backup 先 cp mesh.db → mesh.db.bak-<ts>
 *   - --group <id> 只迁一个群(先小范围验证)
 *   - 映射 old→new 写入 ~/.rotom/group-id-migration.json,供核对/回滚
 *
 * 用法:
 *   node --import tsx scripts/migrate-group-ids.ts --dry-run
 *   node --import tsx scripts/migrate-group-ids.ts --backup --group 0fd4c42d-...
 *   node --import tsx scripts/migrate-group-ids.ts --backup
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { generateGroupId } from "../src/shared/group-id.js";

// ─── 配置 ──────────────────────────────────────────────────────────────────
const ROTOM_HOME = process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
const DB_PATH = path.join(ROTOM_HOME, "mesh.db");
const ARTIFACTS_ROOT = path.join(ROTOM_HOME, "artifacts");
const UPLOADS_ROOT = path.join(ROTOM_HOME, "uploads");
const RESULTS_ROOT = path.join(ROTOM_HOME, "results");
const REPOS_ROOT = path.join(ROTOM_HOME, "repos");
const RUN_DIR = path.join(ROTOM_HOME, "run");
const SESSIONS_JSON = path.join(ROTOM_HOME, "sessions.json");
const EXECUTOR_CONFIG = path.join(ROTOM_HOME, "executor.config.json");
const MAPPING_FILE = path.join(ROTOM_HOME, "group-id-migration.json");

const GIT_SUFFIX_LEN = 8; // groupId.slice(0,8) 用于派生分支名

// ─── 参数 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const BACKUP = argv.includes("--backup");
const SKIP_STOP_CHECK = argv.includes("--skip-stop-check");
const GROUP_FILTER = (() => {
  const i = argv.indexOf("--group");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
})();

class Counts { db = 0; dirs = 0; uploads = 0; results = 0; sessions = 0; workdirMap = 0; branches = 0; worktrees = 0; wtSlots = 0; }
const counts = new Counts();
const failures: string[] = [];
const log = (m: string) => console.log(m);
const warn = (m: string) => { console.warn(`  ⚠️ ${m}`); failures.push(m); };

// ─── better-sqlite3(可选依赖,动态引入)──────────────────────────────────────
let Database: any;
try {
  Database = (await import("better-sqlite3")).default;
} catch (e: any) {
  console.error("better-sqlite3 不可用,无法操作 DB。请确保 master 依赖已安装。");
  console.error(`  ${e?.message ?? e}`);
  process.exit(1);
}

// ─── 工具 ───────────────────────────────────────────────────────────────────
function pidAlive(pidStr: string): boolean {
  const pid = parseInt(pidStr, 10);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function runGit(gitDir: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", ["--git-dir", gitDir, ...args], { encoding: "utf-8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function listTables(db: any): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map(r => r.name);
}

function tableColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[])
    .map(c => c.name);
}

/** 所有引用 groups.id 的列(列名以 group_id 结尾)。 */
function groupIdColumns(db: any, table: string): string[] {
  return tableColumns(db, table).filter(c => c.endsWith("group_id"));
}

/** 可能含 groupId 路径的文本列(working_dir / cwd / path)。 */
function pathLikeColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[])
    .filter(c => /TEXT|BLOB/i.test(c.type) && /(dir|path|cwd)/i.test(c.name))
    .map(c => c.name);
}

// ─── 1. 进程检测 ─────────────────────────────────────────────────────────────
function ensureStopped(): void {
  const pidFiles = ["master.pid", "local-executor.pid", "link.pid"];
  const running: string[] = [];
  for (const f of pidFiles) {
    const p = path.join(RUN_DIR, f);
    if (fs.existsSync(p)) {
      const pid = fs.readFileSync(p, "utf-8").trim();
      if (pidAlive(pid)) running.push(`${f} (pid ${pid})`);
    }
  }
  if (running.length) {
    console.error("❌ 检测到 rotom 进程仍在运行,迁移必须停服后执行:");
    for (const r of running) console.error(`   ${r}`);
    console.error("   请先执行:rotom stop");
    process.exit(1);
  }
  log("✓ 未检测到运行中的 rotom 进程");
}

// ─── 2. 加载群 + 生成新 ID ────────────────────────────────────────────────────
function loadGroups(db: any): { id: string; name: string; working_dir: string | null }[] {
  const rows = db.prepare("SELECT id, name, working_dir FROM groups").all() as { id: string; name: string; working_dir: string | null }[];
  // 过滤:只迁 UUID 格式的旧 id(36 字符含 4 个连字符);已是短 id 的跳过,支持重入
  return rows.filter(g => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g.id));
}

function buildMapping(db: any, groups: { id: string }[]): Map<string, string> {
  const existingIds = new Set<string>(
    (db.prepare("SELECT id FROM groups").all() as { id: string }[]).map(r => r.id),
  );
  const mapping = new Map<string, string>();
  for (const g of groups) {
    let newId: string;
    do { newId = generateGroupId(); } while (existingIds.has(newId) || mapping.has(newId) || [...mapping.values()].includes(newId));
    existingIds.add(newId);
    mapping.set(g.id, newId);
  }
  return mapping;
}

/** 检测 old8(前 8 字符)在待迁群内是否唯一 —— 分支名只含 old8,需无歧义映射。 */
function assertOld8Unique(groups: { id: string }[]): void {
  const seen = new Map<string, string>();
  for (const g of groups) {
    const g8 = g.id.slice(0, GIT_SUFFIX_LEN);
    if (seen.has(g8)) {
      console.error(`❌ old8 碰撞:${g8} 同时属于 ${seen.get(g8)} 与 ${g.id}`);
      console.error("   分支名只含前 8 字符,无法无歧义映射。请手动处理其中一个群后重跑。");
      process.exit(1);
    }
    seen.set(g8, g.id);
  }
}

// ─── 3. DB 迁移 ──────────────────────────────────────────────────────────────
function migrateDb(db: any, mapping: Map<string, string>): void {
  const tables = listTables(db);
  // 收集 (table, group-id 列) 与 (table, path 列)
  const idCols: [string, string][] = [];
  const pathCols: [string, string][] = [];
  for (const t of tables) {
    for (const c of groupIdColumns(db, t)) idCols.push([t, c]);
    for (const c of pathLikeColumns(db, t)) pathCols.push([t, c]);
  }

  // foreign_keys 必须在事务外设置
  db.pragma("foreign_keys = OFF");
  const tx = db.transaction(() => {
    for (const [oldId, newId] of mapping) {
      // 3a. groups.id 主键
      db.prepare("UPDATE groups SET id = ? WHERE id = ?").run(newId, oldId);
      // 3b. 所有 *group_id 外键列
      for (const [t, c] of idCols) {
        db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(newId, oldId);
      }
      // 3c. path 列里的旧 id 子串(working_dir 等)
      for (const [t, c] of pathCols) {
        db.prepare(`UPDATE ${t} SET ${c} = REPLACE(${c}, ?, ?) WHERE ${c} LIKE '%' || ? || '%'`)
          .run(oldId, newId, oldId);
      }
      counts.db++;
    }
  });
  tx();
  db.pragma("foreign_keys = ON");
  log(`✓ DB:迁移 ${counts.db} 个群(id 列 ${idCols.length} 处,path 列 ${pathCols.length} 处)`);
}

// ─── 4. 磁盘目录 ──────────────────────────────────────────────────────────────
function renameDir(oldP: string, newP: string, label: string): boolean {
  if (!fs.existsSync(oldP)) return false;
  if (fs.existsSync(newP)) { warn(`${label}:目标已存在,跳过 ${oldP} → ${newP}`); return false; }
  if (!DRY_RUN) fs.renameSync(oldP, newP);
  log(`  ${label}:${path.basename(oldP)} → ${path.basename(newP)}`);
  return true;
}

function migrateDisk(mapping: Map<string, string>): void {
  for (const [oldId, newId] of mapping) {
    // artifacts/<id>
    if (renameDir(path.join(ARTIFACTS_ROOT, oldId), path.join(ARTIFACTS_ROOT, newId), "artifacts")) counts.dirs++;
    // uploads/<月>/<id>
    if (fs.existsSync(UPLOADS_ROOT)) {
      for (const month of fs.readdirSync(UPLOADS_ROOT, { withFileTypes: true })) {
        if (!month.isDirectory()) continue;
        if (renameDir(path.join(UPLOADS_ROOT, month.name, oldId), path.join(UPLOADS_ROOT, month.name, newId), `uploads/${month.name}`)) counts.uploads++;
      }
    }
    // results/<id>(legacy)
    if (renameDir(path.join(RESULTS_ROOT, oldId), path.join(RESULTS_ROOT, newId), "results")) counts.results++;
  }
}

// ─── 5. JSON 文件 ──────────────────────────────────────────────────────────────
function migrateSessionsJson(mapping: Map<string, string>): void {
  if (!fs.existsSync(SESSIONS_JSON)) return;
  const raw = fs.readFileSync(SESSIONS_JSON, "utf-8");
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw); } catch { warn("sessions.json 解析失败,跳过"); return; }
  let changed = 0;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    const sep = k.indexOf(":");
    if (sep > 0) {
      const gid = k.slice(sep + 1);
      if (mapping.has(gid)) {
        out[`${k.slice(0, sep)}:${mapping.get(gid)}`] = v;
        changed++;
        continue;
      }
    }
    out[k] = v;
  }
  if (changed) {
    if (!DRY_RUN) fs.writeFileSync(SESSIONS_JSON, JSON.stringify(out, null, 2));
    log(`✓ sessions.json:重写 ${changed} 个 key`);
    counts.sessions = changed;
  }
}

function migrateExecutorConfig(mapping: Map<string, string>): void {
  if (!fs.existsSync(EXECUTOR_CONFIG)) return;
  const raw = fs.readFileSync(EXECUTOR_CONFIG, "utf-8");
  const cfg = JSON.parse(raw) as Record<string, unknown>;
  const wdm = cfg.workingDirMap as Record<string, string> | undefined;
  if (!wdm || typeof wdm !== "object") return;
  let changed = 0;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(wdm)) {
    if (mapping.has(k)) {
      // key 改写;value 若含旧 id 路径也替换
      out[mapping.get(k)!] = mapping.has(k) && typeof v === "string" ? v.split(k).join(mapping.get(k)!) : v;
      changed++;
    } else {
      out[k] = v;
    }
  }
  if (changed) {
    cfg.workingDirMap = out;
    if (!DRY_RUN) fs.writeFileSync(EXECUTOR_CONFIG, JSON.stringify(cfg, null, 2));
    log(`✓ executor.config.json workingDirMap:重写 ${changed} 个 key`);
    counts.workdirMap = changed;
  }
}

// ─── 6. Git worktree + 分支 ──────────────────────────────────────────────────
function listBareRepos(): string[] {
  if (!fs.existsSync(REPOS_ROOT)) return [];
  return fs.readdirSync(REPOS_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.endsWith(".git"))
    .map(e => path.join(REPOS_ROOT, e.name));
}

function migrateGit(mapping: Map<string, string>): void {
  // old8 → new8 映射(分支名/slot 名用前 8 字符)
  const g8map = new Map<string, string>();
  for (const [oldId, newId] of mapping) g8map.set(oldId.slice(0, GIT_SUFFIX_LEN), newId.slice(0, GIT_SUFFIX_LEN));

  for (const bare of listBareRepos()) {
    // 6a. 改名前先列出 worktree(注册路径),以便迁移后按新路径 repair
    let wtList = "";
    const lr = runGit(bare, ["worktree", "list", "--porcelain"]);
    if (lr.ok) wtList = lr.stdout;

    // 6b. 旧布局 slot 改名:repos/<repo>-<id8>-wt/group-<old8> → group-<new8>,并 repair 重连
    //     (6d 只修路径含完整 oldId 的新布局 worktree;旧布局 slot 路径只含 old8,需在此显式 repair)
    for (const [old8, new8] of g8map) {
      const wtRoot = bare.replace(/\.git$/, "-wt");
      const oldSlot = path.join(wtRoot, `group-${old8}`);
      const newSlot = path.join(wtRoot, `group-${new8}`);
      if (fs.existsSync(oldSlot)) {
        if (!fs.existsSync(newSlot)) {
          if (!DRY_RUN) {
            fs.renameSync(oldSlot, newSlot);
            const rr = runGit(bare, ["worktree", "repair", newSlot]);
            if (!rr.ok) warn(`slot repair 失败 ${newSlot}: ${rr.stderr.trim()}`);
          }
          log(`  git slot+repair:${path.basename(bare)}:${old8} → ${new8}`);
          counts.wtSlots++;
        } else {
          warn(`slot 目标已存在,跳过 ${newSlot}`);
        }
      }
    }

    // 6c. 分支改名:<base>-rotom-<old8> → <base>-rotom-<new8>
    const br = runGit(bare, ["branch", "--list"]);
    if (br.ok) {
      for (const line of br.stdout.split("\n")) {
        const m = line.replace(/^[*+ ]+/, "").trim();
        const suffix = "-rotom-";
        const idx = m.lastIndexOf(suffix);
        if (idx < 0) continue;
        const old8 = m.slice(idx + suffix.length);
        if (g8map.has(old8)) {
          const newBranch = m.slice(0, idx + suffix.length) + g8map.get(old8);
          if (!DRY_RUN) {
            const rr = runGit(bare, ["branch", "-m", m, newBranch]);
            if (!rr.ok) { warn(`分支改名失败 ${m}→${newBranch}: ${rr.stderr.trim()}`); continue; }
          }
          log(`  git branch:${path.basename(bare)}:${m} → ${newBranch}`);
          counts.branches++;
        }
      }
    }

    // 6d. worktree repair —— 按新路径重连被改名的 worktree
    // 从迁移前的 list 里找路径含某 oldId(artifacts 布局)或匹配旧 slot 的,
    // 计算新路径后显式 repair(实测:不带路径参数的 repair 找不到被改名的 worktree)
    if (wtList) {
      for (const block of wtList.split("\n\n")) {
        const worktreeLine = block.split("\n").find(l => l.startsWith("worktree "));
        if (!worktreeLine) continue;
        const oldWt = worktreeLine.slice("worktree ".length).trim();
        if (oldWt === bare) continue; // bare 自身
        let newWt: string | null = null;
        for (const [oldId, newId] of mapping) {
          if (oldWt.includes(oldId)) { newWt = oldWt.split(oldId).join(newId); break; }
        }
        if (!newWt || newWt === oldWt) continue;
        if (!fs.existsSync(newWt)) { warn(`worktree 新路径不存在,跳过 repair:${newWt}`); continue; }
        if (!DRY_RUN) {
          const rr = runGit(bare, ["worktree", "repair", newWt]);
          if (!rr.ok) { warn(`worktree repair 失败 ${newWt}: ${rr.stderr.trim()}`); continue; }
        }
        log(`  git worktree repair:${path.basename(bare)}:${path.basename(oldWt)} → ${path.basename(newWt)}`);
        counts.worktrees++;
      }
    }

    // 6e. 清理失效记录
    if (!DRY_RUN) runGit(bare, ["worktree", "prune"]);
  }
  log(`✓ Git:分支 ${counts.branches}、worktree ${counts.worktrees}、旧 slot ${counts.wtSlots}`);
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────
function main(): void {
  log(`rotom 群 ID 迁移${DRY_RUN ? " [DRY-RUN]" : ""}`);
  log(`  ROTOM_HOME = ${ROTOM_HOME}`);
  log(`  DB         = ${DB_PATH}`);

  if (!DRY_RUN && !SKIP_STOP_CHECK) ensureStopped();
  if (SKIP_STOP_CHECK && !DRY_RUN) log("⚠️ --skip-stop-check:已跳过停服检测(调用方需自行确保无进程写 DB)");

  // dry-run 只读打开,可在 master 运行时预览;正式执行要求停服后可写打开
  const db = new Database(DB_PATH, { fileMustExist: true, readonly: DRY_RUN });
  let groups = loadGroups(db);
  if (GROUP_FILTER) {
    groups = groups.filter(g => g.id === GROUP_FILTER);
    if (!groups.length) { console.error(`未找到匹配的旧格式群:${GROUP_FILTER}`); process.exit(1); }
    log(`  --group 过滤:仅迁 ${groups[0].id} (${groups[0].name})`);
  }
  if (!groups.length) { log("✓ 没有 UUID 格式的群需要迁移(可能已迁移过)"); db.close(); return; }

  assertOld8Unique(groups);
  const mapping = buildMapping(db, groups);

  log(`\n待迁移 ${groups.length} 个群:`);
  for (const g of groups) {
    log(`  ${g.id} → ${mapping.get(g.id)}  (${g.name})`);
  }

  if (DRY_RUN) {
    log("\n[DRY-RUN] 不执行任何写操作。");
    db.close();
    return;
  }

  // 备份
  if (BACKUP) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const bak = `${DB_PATH}.bak-${ts}`;
    fs.copyFileSync(DB_PATH, bak);
    log(`\n✓ DB 已备份 → ${bak}`);
  }

  // 写映射(先写,迁移失败也能用于回滚定位)
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(
    [...mapping.entries()].map(([oldId, newId]) => ({ oldId, newId })), null, 2));
  log(`✓ 映射写入 ${MAPPING_FILE}`);

  log("\n[1/5] DB ...");
  migrateDb(db, mapping);
  db.close();

  log("\n[2/5] 磁盘目录 ...");
  migrateDisk(mapping);

  log("\n[3/5] sessions.json ...");
  migrateSessionsJson(mapping);

  log("\n[4/5] executor.config.json ...");
  migrateExecutorConfig(mapping);

  log("\n[5/5] Git worktree + 分支 ...");
  migrateGit(mapping);

  log("\n──── 完成 ────");
  log(`  DB 群迁移 : ${counts.db}`);
  log(`  artifacts : ${counts.dirs}`);
  log(`  uploads   : ${counts.uploads}`);
  log(`  results   : ${counts.results}`);
  log(`  sessions : ${counts.sessions}`);
  log(`  workDirMap: ${counts.workdirMap}`);
  log(`  git 分支  : ${counts.branches}`);
  log(`  git worktree: ${counts.worktrees}`);
  log(`  git slot  : ${counts.wtSlots}`);
  if (failures.length) {
    log(`\n⚠️ ${failures.length} 项失败(见上方 ⚠️):`);
    for (const f of failures) log(`    - ${f}`);
  }
  log(`\n下一步:rotom start,抽查一个群的 dashboard / artifacts 路径。`);
}

main();
