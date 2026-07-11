/**
 * Skill 文件 IO —— `~/.rotom/skills/<name>/SKILL.md` 的读写。
 *
 * 文件 = skill 真相源。frontmatter 存元数据(flat `key: value`,无嵌套 —— 与
 * 仓库内现有 `skill/<name>/SKILL.md` 一致,不引入 yaml 依赖),body 存 markdown 正文。
 *
 * 原子写:先写 `<dir>/.SKILL.md.tmp-<pid><rand>` 再 `fs.renameSync` 替换(同分区
 * 原子替换)。幂等:内容相同跳过(避免和正在跑的 agent 抢文件 mtime),沿用
 * `ensureRotomSkillMd` 的模式。
 *
 * 与 db/skills.ts 配合:DB `agent_skills` 表降级为可重建索引,真相源始终是这里
 * 的文件;`db.reconcileSkills()` 扫描目录即可重建索引。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  skillsRoot,
  skillsTrash,
  SKILL_FILE_NAME,
  skillDir,
  skillFilePath,
} from "./paths.js";
import { createLogger } from "./logger.js";
import { toBeijingCompact } from "./time.js";

const log = createLogger("skill-file");

/** skill 文档(file = 真相源)。 */
export interface SkillDoc {
  name: string;
  description: string;
  content: string;
  category?: string | null;
  sourceType?: "manual" | "promoted" | null;
  sourceRef?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** frontmatter 输出顺序(只写已知字段,snake_case 对齐 DB 列名)。 */
const META_KEYS = [
  "name", "description", "category", "source_type", "source_ref",
  "created_by", "created_at", "updated_at",
] as const;

// ─── parse / serialize ────────────────────────────────────────────────────

/** 把 SkillDoc 序列化成 `--- frontmatter ---\n\nbody` 文本。 */
export function serializeSkillFile(doc: SkillDoc): string {
  const m: Record<string, string> = {};
  if (doc.name) m.name = doc.name;
  if (doc.description) m.description = scalar(doc.description);
  if (doc.category) m.category = scalar(doc.category);
  if (doc.sourceType) m.source_type = scalar(doc.sourceType);
  if (doc.sourceRef) m.source_ref = scalar(doc.sourceRef);
  if (doc.createdBy) m.created_by = scalar(doc.createdBy);
  if (doc.createdAt) m.created_at = scalar(doc.createdAt);
  if (doc.updatedAt) m.updated_at = scalar(doc.updatedAt);

  const lines = ["---"];
  for (const key of META_KEYS) {
    if (m[key] !== undefined) lines.push(`${key}: ${m[key]}`);
  }
  lines.push("---", "");
  return lines.join("\n") + (doc.content ?? "");
}

/** 解析 SKILL.md 文本 → SkillDoc。frontmatter 缺失时整体当 body(容错)。 */
export function parseSkillFile(raw: string, fallbackName?: string): SkillDoc {
  const { meta, body } = splitFrontmatter(raw);
  return {
    name: meta.name || fallbackName || "",
    description: meta.description || "",
    // 去掉 frontmatter 后的首空行 + 文件末尾惯例换行(编辑器都会加),内容语义不变。
    content: body.replace(/^\n+/, "").replace(/\n+$/, ""),
    category: meta.category ?? null,
    sourceType: (meta.source_type as "manual" | "promoted" | undefined) ?? null,
    sourceRef: meta.source_ref ?? null,
    createdBy: meta.created_by ?? null,
    createdAt: meta.created_at ?? null,
    updatedAt: meta.updated_at ?? null,
  };
}

function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const lines = raw.split(/\r?\n/);
  const meta: Record<string, string> = {};
  if (lines[0]?.trim() !== "---") {
    return { meta, body: raw };
  }
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    meta[key] = stripQuotes(line.slice(idx + 1).trim());
  }
  const bodyStart = i < lines.length ? i + 1 : lines.length;
  return { meta, body: lines.slice(bodyStart).join("\n") };
}

/** scalar 元数据值:折叠换行(frontmatter 单行)、统一字符串。 */
function scalar(v: unknown): string {
  return String(v ?? "").replace(/\r?\n/g, " ");
}

function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const a = v[0], b = v[v.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return v.slice(1, -1);
  }
  return v;
}

// ─── FS 操作 ──────────────────────────────────────────────────────────────

/** 读单个 skill 文件;不存在/读失败返回 null。 */
export function readSkillFile(name: string): SkillDoc | null {
  try {
    const raw = fs.readFileSync(skillFilePath(name), "utf-8");
    return parseSkillFile(raw, name);
  } catch {
    return null;
  }
}

/**
 * 原子写 skill 文件(幂等:内容相同跳过)。
 * 落点:`~/.rotom/skills/<name>/SKILL.md`。目录不存在自动创建。
 */
export function writeSkillFile(doc: SkillDoc): void {
  const target = skillFilePath(doc.name);
  const dir = skillDir(doc.name);
  const serialized = serializeSkillFile(doc);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    if (fs.existsSync(target) && fs.readFileSync(target, "utf-8") === serialized) return;
  } catch { /* 读失败 → 重写 */ }
  const tmp = path.join(
    dir,
    `.${SKILL_FILE_NAME}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.writeFileSync(tmp, serialized, "utf-8");
  fs.renameSync(tmp, target);
}

/** 列出 skillsRoot() 下所有含 SKILL.md 的 skill 名(跳过点目录如 .trash)。 */
export function listSkillNames(): string[] {
  const root = skillsRoot();
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (fs.existsSync(path.join(root, entry.name, SKILL_FILE_NAME))) {
      out.push(entry.name);
    }
  }
  return out.sort();
}

/**
 * 软删:把整个 skill 目录移到 `~/.rotom/skills/.trash/<name>-<ts>/`(可恢复)。
 * 返回是否真的移动了(目录不存在则 false)。
 */
export function trashSkillFile(name: string): boolean {
  const dir = skillDir(name);
  if (!fs.existsSync(dir)) return false;
  const trash = skillsTrash();
  if (!fs.existsSync(trash)) fs.mkdirSync(trash, { recursive: true });
  const dest = path.join(trash, `${name}-${toBeijingCompact()}`);
  try {
    fs.renameSync(dir, dest);
    return true;
  } catch (e) {
    // 跨设备 rename 会失败 → 退化为递归删除(软删失败也别卡住 deactivate)
    log.warn(`trashSkillFile rename 失败,退化为删除:${(e as Error).message}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

/** 重命名 skill 目录(oldName → newName)。SKILL.md 内 frontmatter 由调用方随后重写。 */
export function renameSkillFile(oldName: string, newName: string): void {
  const from = skillDir(oldName);
  const to = skillDir(newName);
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}
