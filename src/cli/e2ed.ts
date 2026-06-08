/**
 * rotom e2ed — End-to-End Requirement Delivery CLI subcommands.
 *
 * Usage: rotom e2ed <subcommand> [args]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

import { MeshDb } from "../master/db.js";
import { createRequirement, listRequirements, getRequirement, getRequirementText, deleteRequirement } from "../e2ed/requirement.js";
import { startDeliver, startReview } from "../e2ed/pipeline.js";
import { computeMetrics, getTimeline } from "../e2ed/metrics.js";
import { RequirementStatus } from "../e2ed/types.js";
import { closeRequirement } from "../e2ed/requirement.js";
import { checkAndTransitionEnv } from "../e2ed/environment.js";

// ── DB singleton ─────────────────────────────────────────────────────────

function openDb(): MeshDb {
  const dataDir = process.env.ROTOM_HOME || path.join(os.homedir(), ".rotom");
  return new MeshDb(path.join(dataDir, "mesh.db"));
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

// ── Agent selection helpers ──────────────────────────────────────────────

function listRegisteredAgents(db: MeshDb): { name: string; status: string }[] {
  return db.listAgents({ enabled: true }).map((a) => ({ name: a.name, status: a.status }));
}

async function promptSelectAgent(agents: { name: string; status: string }[], role: string): Promise<string> {
  process.stdout.write(`\nAvailable agents for ${role}:\n`);
  agents.forEach((a, i) => {
    process.stdout.write(`  ${i + 1}) ${a.name} (${a.status})\n`);
  });
  process.stdout.write(`Select [1-${agents.length}]: `);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => {
    rl.question("", (res) => { rl.close(); resolve(res.trim()); });
  });

  const idx = parseInt(answer, 10);
  if (isNaN(idx) || idx < 1 || idx > agents.length) {
    fail(`Invalid selection "${answer}". Aborting.`);
  }
  return agents[idx - 1].name;
}

function resolveAgentOrDefault(db: MeshDb, provided: string | undefined, role: string, defaultName: string): string | Promise<string> {
  if (provided) {
    const agent = db.getAgentByName(provided);
    if (!agent) fail(`Agent "${provided}" is not registered. Use "rotom agent ls" to see available agents.`);
    return provided;
  }
  const agents = listRegisteredAgents(db);
  if (agents.length === 0) {
    fail(`No registered agents found. Register an agent first before creating E2ED requirements.`);
  }
  if (agents.length === 1) return agents[0].name;
  // Auto-match by name if a well-known default exists
  const match = agents.find((a) => a.name === defaultName);
  if (match) return match.name;
  // Need user to pick
  return promptSelectAgent(agents, role);
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

  if (!text) fail("Usage: rotom e2ed start <file.md | text> [--title T] [--cwd DIR] [--delivery-agent NAME] [--review-agent NAME]");

  const cwd = flagStr(flags, "cwd") || process.cwd();
  const deliveryAgent = await resolveAgentOrDefault(db, flagStr(flags, "delivery-agent"), "delivery", "claude");
  const reviewAgent = await resolveAgentOrDefault(db, flagStr(flags, "review-agent"), "review", "codex");

  if (pretty) {
    process.stdout.write(`Delivery agent: ${deliveryAgent}\n`);
    process.stdout.write(`Review agent:   ${reviewAgent}\n`);
  }

  const { groupId, meta } = createRequirement(db, { title, text, source: "cli", workingDir: cwd, deliveryAgent, reviewAgent });

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

  // Auto-infer plan-only vs code-only when neither flag is set
  let planOnly = !!flags["plan-only"];
  let codeOnly = !!flags["code-only"];
  const fix = !!flags.fix;

  if (!planOnly && !codeOnly) {
    const latestPlan = meta.planVersions[meta.planVersions.length - 1];
    if (fix) {
      codeOnly = true;
    } else if (!latestPlan) {
      planOnly = true;
    } else if (latestPlan.reviewStatus !== null) {
      codeOnly = true;
    } else {
      planOnly = true;
    }

    if (pretty) {
      process.stdout.write(`Auto-detected: ${planOnly ? "plan generation" : "code implementation"}\n`);
    }
  }

  startDeliver(db, groupId, { cwd, fix, planOnly, codeOnly });
}

async function cmdReview(rest: string[], flags: Record<string, string | boolean>): Promise<void> {
  const groupId = rest[0];
  if (!groupId) fail("Usage: rotom e2ed review <groupId> [--type requirement|plan|code] [--cwd DIR]");

  const db = openDb();
  const cwd = flagStr(flags, "cwd");
  let type = flagStr(flags, "type") as 'requirement' | 'plan' | 'code' | undefined;

  // Auto-infer review type when --type is not set
  if (!type) {
    const meta = getRequirement(db, groupId);
    if (!meta) fail(`Requirement ${groupId} not found`);

    const latestPlan = meta.planVersions[meta.planVersions.length - 1];
    const latestCode = meta.codeVersions[meta.codeVersions.length - 1];

    if (!latestPlan && !latestCode && meta.status === RequirementStatus.ENV_READY) {
      type = 'requirement';
    } else if (latestPlan && latestPlan.reviewStatus === null) {
      type = 'plan';
    } else if (latestCode && latestCode.reviewStatus === null) {
      type = 'code';
    } else {
      type = 'code';
    }

    if (pretty) {
      process.stdout.write(`Auto-detected: ${type} review\n`);
    }
  }

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

async function cmdDelete(rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const groupId = rest[0];
  if (!groupId) fail("Usage: rotom e2ed delete <groupId>");

  const db = openDb();
  try {
    deleteRequirement(db, groupId);
    if (pretty) {
      process.stdout.write(`Requirement ${groupId} deleted.\n`);
    } else {
      printJson({ ok: true, groupId });
    }
  } catch (err: any) {
    fail(err.message);
  }
}

async function cmdStatus(rest: string[], _flags: Record<string, string | boolean>): Promise<void> {
  const groupId = rest[0];
  if (!groupId) fail("Usage: rotom e2ed status <groupId>");

  const db = openDb();
  const meta = getRequirement(db, groupId);
  if (!meta) fail(`Requirement ${groupId} not found`);

  const metrics = computeMetrics(db, groupId);
  const timeline = getTimeline(db, groupId);
  const text = getRequirementText(groupId);

  if (pretty) {
    process.stdout.write(`ID:              ${meta.reqId}\n`);
    process.stdout.write(`Title:           ${text ? text.substring(0, 80).split("\n")[0] : "-"}\n`);
    process.stdout.write(`Status:          ${meta.status}\n`);
    process.stdout.write(`Version:         ${meta.compositeVersion}\n`);
    process.stdout.write(`Active Task:     ${meta.activeTask || "none"}\n`);
    process.stdout.write(`Delivery Agent:  ${meta.deliveryAgent || "claude"}\n`);
    process.stdout.write(`Review Agent:    ${meta.reviewAgent || "codex"}\n`);

    if (metrics) {
      process.stdout.write(`\n── Metrics ──\n`);
      process.stdout.write(`Total duration: ${(metrics.totalDuration / 1000).toFixed(1)}s\n`);

      process.stdout.write(`\nPlan rounds: ${metrics.planRounds.length}\n`);
      for (const r of metrics.planRounds) {
        process.stdout.write(`  v${r.version}: delivery ${(r.deliveryDuration / 1000).toFixed(1)}s, review ${(r.reviewDuration / 1000).toFixed(1)}s → ${r.result}\n`);
      }

      process.stdout.write(`\nCode rounds: ${metrics.codeRounds.length}\n`);
      for (const r of metrics.codeRounds) {
        process.stdout.write(`  v${r.version}: delivery ${(r.deliveryDuration / 1000).toFixed(1)}s, review ${(r.reviewDuration / 1000).toFixed(1)}s → ${r.result}\n`);
      }
    }

    if (timeline.length > 0) {
      process.stdout.write(`\n── Recent Events ──\n`);
      for (const e of timeline.slice(-10)) {
        process.stdout.write(`  ${e.createdAt}  ${e.eventType.padEnd(20)} ${e.agentName}\n`);
      }
    }
  } else {
    printJson({ meta, metrics, timeline });
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
    case "status":   return cmdStatus(rest.slice(1), flags);
    case "deliver":  return cmdDeliver(rest.slice(1), flags);
    case "review":   return cmdReview(rest.slice(1), flags);
    case "close":    return cmdClose(rest.slice(1), flags);
    case "delete":   return cmdDelete(rest.slice(1), flags);
    case "rm":       return cmdDelete(rest.slice(1), flags);
    default:
      process.stderr.write(
        `Usage: rotom e2ed <command> [args]\n\n` +
        `Commands:\n` +
        `  start <file|text>    Create a new requirement\n` +
        `  ls                   List all requirements\n` +
        `  status <groupId>     Show status, metrics & timeline\n` +
        `  deliver <groupId>    Start delivery (auto: plan or code)\n` +
        `  review <groupId>     Start review (auto: req/plan/code)\n` +
        `  close <groupId>      Close a requirement\n` +
        `  delete <groupId>     Delete a requirement\n` +
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
