/**
 * 一次性验证脚本(throwaway):在隔离的 ROTOM_HOME 里,对真实 mesh.db 的快照跑
 * reconcileSkills(),确认 DB → 文件 backfill 正确。**不触碰** 正在运行的 master
 * 与真实 ~/.rotom/skills/。
 *
 * 用法:node --import tsx scripts/verify-skill-migration.ts
 * 跑完自清理临时目录。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { MeshDb } from "../src/master/db/index.js";
import { listSkillNames, readSkillFile } from "../src/shared/skill-file.js";

// 必须在任何 skillsRoot() 调用(reconcile/listSkillNames)之前设置。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "rotom-mig-verify-"));
process.env.ROTOM_HOME = tmpHome;
const tmpDb = path.join(tmpHome, "mesh-snap.db");

const REAL_DB = path.join(os.homedir(), ".rotom", "mesh.db");

function summarize(label: string, names: string[]): void {
  console.log(`\n[${label}] ${names.length} skill(s): ${names.join(", ") || "(none)"}`);
}

async function main(): Promise<void> {
  if (!fs.existsSync(REAL_DB)) {
    console.error(`真实 DB 不存在:${REAL_DB}`);
    process.exit(1);
  }

  // 在线快照(readonly 源,不干扰 live master 的 WAL)。
  const src = new Database(REAL_DB, { readonly: true });
  src.backup(tmpDb);
  src.close();
  console.log(`快照:${tmpDb}`);

  const db = new MeshDb(tmpDb);

  const before = db.listSkills();
  summarize("active skills in DB (before)", before.map(s => s.name));

  const filesBefore = listSkillNames();
  summarize("files (before)", filesBefore);

  const r = db.reconcileSkills();
  console.log(`\nreconcile #1: added=${r.added} updated=${r.updated} backfilled=${r.backfilled}`);

  const filesAfter = listSkillNames();
  summarize("files (after)", filesAfter);

  // 校验:每个 active skill 都有文件,且文件内容 == DB 内容。
  let ok = true;
  for (const s of before) {
    const doc = readSkillFile(s.name);
    const row = db.getSkillByName(s.name);
    if (!doc) { console.log(`  ✗ MISSING FILE: ${s.name}`); ok = false; continue; }
    if (doc.content !== row?.content) {
      console.log(`  ✗ CONTENT MISMATCH: ${s.name} (file ${doc.content.length} vs db ${row?.content.length})`);
      ok = false;
    } else {
      console.log(`  ✓ ${s.name} — ${doc.content.length} chars, content matches`);
    }
  }

  // 幂等:再跑一次应全 0。
  const r2 = db.reconcileSkills();
  console.log(`\nreconcile #2 (idempotent): added=${r2.added} updated=${r2.updated} backfilled=${r2.backfilled}`);
  if (r2.added || r2.updated || r2.backfilled) ok = false;

  console.log(`\n=== ${ok ? "ALL GOOD ✓" : "FAILURES ✗"} ===`);
  db.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
