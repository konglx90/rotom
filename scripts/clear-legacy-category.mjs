// One-off migration: clear `profile.category` on agents that still have legacy
// values ("快反组" / "Agent" / "快速响应").
//
// "真人" is preserved (it remains semantically meaningful for collaboration
// owner selection). Any other category set by the operator (free text) is
// also left alone.
//
// Usage: node scripts/clear-legacy-category.mjs [dbPath]
//        DRY_RUN=1 node scripts/clear-legacy-category.mjs   # only report

import Database from "better-sqlite3";
import path from "node:path";

const dbPath = process.argv[2] || path.resolve("mesh-data/mesh.db");
const dryRun = process.env.DRY_RUN === "1";

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const LEGACY = new Set(["快反组", "Agent", "快速响应"]);

const rows = db.prepare("SELECT id, name, profile FROM agents WHERE profile IS NOT NULL").all();

const changes = [];
for (const r of rows) {
  if (!r.profile) continue;
  let p;
  try { p = JSON.parse(r.profile); } catch { continue; }
  if (!p || typeof p !== "object") continue;
  if (!LEGACY.has(p.category)) continue;
  const before = p.category;
  delete p.category;
  changes.push({ id: r.id, name: r.name, from: before, newProfile: JSON.stringify(p) });
}

console.log(`扫描到 ${rows.length} 个 agent，需要清理 category 的: ${changes.length}`);
for (const c of changes) {
  console.log(`  - ${c.name}: ${c.from} → (default)`);
}

if (dryRun) {
  console.log("DRY_RUN=1: 未写入");
  db.close();
  process.exit(0);
}

if (changes.length === 0) {
  console.log("无需改动");
  db.close();
  process.exit(0);
}

const stmt = db.prepare("UPDATE agents SET profile = ? WHERE id = ?");
const tx = db.transaction((items) => {
  for (const c of items) stmt.run(c.newProfile, c.id);
});
tx(changes);

console.log(`已更新 ${changes.length} 条记录 ✓`);
db.close();
