/**
 * rotom e2ed — End-to-End Requirement Delivery CLI subcommands.
 *
 * Usage: rotom e2ed <subcommand> [args]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MeshDb } from "../master/db.js";
import { createRequirement, listRequirements, getRequirement, getRequirementText } from "../e2ed/requirement.js";
import { startDeliver, startReview } from "../e2ed/pipeline.js";
import { computeMetrics, getTimeline } from "../e2ed/metrics.js";
import { RequirementStatus } from "../e2ed/types.js";
import { closeRequirement } from "../e2ed/requirement.js";
import { checkAndTransitionEnv } from "../e2ed/environment.js";

// ── DB singleton ─────────────────────────────────────────────────────────

function openDb(): MeshDb {
  const dbPath = path.join(
    process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom"),
    "mesh.db",
  );
  return new MeshDb(dbPath);
}

// ── Helpers ──────────────────────────────────────────────────────────────

let pretty = false;

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, pretty ? 2 : 0) + "\n");
}

function fail(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

// ── Subcommands ──────────────────────────────────────────────────────────

async function cmdStart(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const db = openDb();

  // Accept file path or inline text
  let text = "";
  let title = flagStr(flags, "title") || "";

  const source = rest[0];
  if (source) {
    if (fs.existsSync(source)) {
      text = fs.readFileSync(source, "utf-8");
      if (!title) title = path.basename(source, path.extname(source));
    } else {
      text = source;
    }
  }

  if (!text) fail("Usage: rotom e2ed start <file.md | text> [--title T] [--cwd DIR]");

  const cwd = flagStr(flags, "cwd") || process.cwd();
  const { groupId, meta } = createRequirement(db, { title, text, source: "cli", workingDir: cwd });

  if (pretty) {
    process.stdout.write(`Requirement created: ${groupId}\n`);
    process.stdout.write(`  Title: ${title || text.substring(0, 60)}\n`);
    process.stdout.write(`  Status: ${meta.status}\n`);
    process.stdout.write(`  Next: rotom e2ed deliver ${groupId} --plan-only\n`);
  } else {
    printJson({ groupId, status: meta.status });
  }
}

async function cmdList(_rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const db = openDb();
  const reqs = listRequirements(db);

  if (pretty) {
    for (const r of reqs) {
      process.stdout.write(`${r.reqId}  ${r.status.padEnd(16)} ${r.compositeVersion}  ${r.timeline[0]?.at || ""}\n`);
    }
  } else {
    printJson(reqs);
  }
}

async function cmdShow(rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const groupId = rest[0];
  if (!groupId) fail("Usage: rotom e2ed show <groupId>");

  const db = openDb();
  const meta = getRequirement(db, groupId);
  if (!meta) fail(`Requirement ${groupId} not found`);

  if (pretty) {
    const text = getRequirementText(groupId);
    process.stdout.write(`ID:       ${meta.reqId}\n`);
    process.stdout.write(`Status:   ${meta.status}\n`);
    process.stdout.write(`Version:  ${meta.compositeVersion}\n`);
    process.stdout.write(`Plans:    ${meta.planVersions.length}\n`);
    process.stdout.write(`Code:     ${meta.codeVersions.length}\n`);
    if (text) {
      process.stdout.write(`\n--- requirement.md ---\n${text.substring(0, 500)}${text.length > 500 ? "..." : ""}\n`);
    }
  } else {
    printJson(meta);
  }
}

async function cmdDeliver(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const groupId = rest[0];
  if (!groupId) fail("Usage: rotom e2ed deliver <groupId> [--plan-only | --code-only] [--fix] [--cwd DIR]");

  const db = openDb();
  const cwd = flagStr(flags, "cwd");

  // Auto environment check when starting from CREATED
  const meta = getRequirement(db, groupId);
  if (!meta) fail(`Requirement ${groupId} not found`);

  if (meta.status === RequirementStatus.CREATED) {
    const workDir = cwd || process.cwd();
    const envResult = checkAndTransitionEnv(db, groupId, workDir);
    if (envResult.status === RequirementStatus.ENV_BLOCKED) {
      fail(`Environment blocked:\n${envResult.issues.map((i) => `  - ${i}`).join("\n")}`);
    }
    if (envResult.issues.length > 0 && pretty) {
      process.stderr.write(`Warnings:\n${envResult.issues.map((i: string) => `  - ${i}`).join("\n")}\n`);
    }
  }

  startDeliver(db, groupId, {
    cwd,
    fix: !!flags.fix,
    planOnly: !!flags["plan-only"],
    codeOnly: !!flags["code-only"],
  });
}

async function cmdReview(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const groupId = rest[0];
  if (!groupId) fail("Usage: rotom e2ed review <groupId> [--type requirement|plan|code] [--cwd DIR]");

  const db = openDb();
  const cwd = flagStr(flags, "cwd");
  const type = flagStr(flags, "type") as 'requirement' | 'plan' | 'code' | undefined;

  startReview(db, groupId, { cwd, reviewType: type });
}

async function cmdClose(rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const groupId = rest[0];
  if (!groupId) fail("Usage: rotom e2ed close <groupId>");

  const db = openDb();
  try {
    const meta = closeRequirement(db, groupId);
    if (pretty) {
      process.stdout.write(`Requirement ${groupId} closed.\n`);
    } else {
      printJson({ groupId, status: meta.status });
    }
  } catch (err: any) {
    fail(err.message);
  }
}

async function cmdMetrics(rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const groupId = rest[0];
  if (!groupId) fail("Usage: rotom e2ed metrics <groupId>");

  const db = openDb();
  const metrics = computeMetrics(db, groupId);
  if (!metrics) fail(`Requirement ${groupId} not found`);

  if (pretty) {
    process.stdout.write(`Total duration: ${(metrics.totalDuration / 1000).toFixed(1)}s\n`);
    process.stdout.write(`Plan rounds: ${metrics.planRounds.length}\n`);
    for (const r of metrics.planRounds) {
      process.stdout.write(`  v${r.version}: delivery ${(r.deliveryDuration / 1000).toFixed(1)}s, review ${(r.reviewDuration / 1000).toFixed(1)}s → ${r.result}\n`);
    }
    process.stdout.write(`Code rounds: ${metrics.codeRounds.length}\n`);
    for (const r of metrics.codeRounds) {
      process.stdout.write(`  v${r.version}: delivery ${(r.deliveryDuration / 1000).toFixed(1)}s, review ${(r.reviewDuration / 1000).toFixed(1)}s → ${r.result}\n`);
    }
  } else {
    printJson(metrics);
  }
}

async function cmdTimeline(rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const groupId = rest[0];
  if (!groupId) fail("Usage: rotom e2ed timeline <groupId>");

  const db = openDb();
  const timeline = getTimeline(db, groupId);

  if (pretty) {
    for (const e of timeline) {
      process.stdout.write(`${e.createdAt}  ${e.eventType.padEnd(20)} ${e.agentName}\n`);
    }
  } else {
    printJson(timeline);
  }
}

// ── Main dispatcher ──────────────────────────────────────────────────────

export async function cmdE2ed(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  pretty = flags.pretty === true;
  const sub = rest[0];

  switch (sub) {
    case "start":    return cmdStart(rest.slice(1), flags);
    case "ls":       return cmdList(rest.slice(1), flags);
    case "list":     return cmdList(rest.slice(1), flags);
    case "show":     return cmdShow(rest.slice(1), flags);
    case "deliver":  return cmdDeliver(rest.slice(1), flags);
    case "review":   return cmdReview(rest.slice(1), flags);
    case "close":    return cmdClose(rest.slice(1), flags);
    case "metrics":  return cmdMetrics(rest.slice(1), flags);
    case "timeline": return cmdTimeline(rest.slice(1), flags);
    default:
      process.stderr.write(
        `Usage: rotom e2ed <command> [args]\n\n` +
        `Commands:\n` +
        `  start <file|text>    Create a new requirement\n` +
        `  ls                   List all requirements\n` +
        `  show <groupId>       Show requirement details\n` +
        `  deliver <groupId>    Start delivery (Claude)\n` +
        `  review <groupId>     Start review (Codex)\n` +
        `  close <groupId>      Close a requirement\n` +
        `  metrics <groupId>    Show metrics and durations\n` +
        `  timeline <groupId>   Show event timeline\n` +
        `\nDeliver flags: --plan-only --code-only --fix --cwd <dir>\n` +
        `Review flags:  --type requirement|plan|code --cwd <dir>\n`,
      );
  }
}

// ── Arg helpers (duplicated from rotom.ts for self-containment) ──────────

function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}
