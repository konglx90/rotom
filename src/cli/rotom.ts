#!/usr/bin/env node
/**
 * rotom — Mesh CLI for digital employees.
 *
 * Every invocation acts as a specific agent. Selection priority:
 *   1. ROTOM_AGENT env
 *   2. --as <name>
 *   3. ~/.rotom/config.json#defaultAgent
 * If none of those resolve, rotom refuses to run (so you never accidentally
 * use the wrong agent's token on a multi-agent box).
 *
 * The agent's master URL + mesh token come from one of:
 *   - "openclaw":  channels['a2a-gateway'].{master,token,name}  in openclaw.json
 *   - "executor":  matching `workers[].name` in executor.config.json
 *   - Auto-discovery: ~/.rotom/executor.config.json (shared with `executor`
 *     worker process). No explicit `rotom config add-executor` needed.
 *   - Env fallback: ROTOM_MASTER + ROTOM_TOKEN (set by worker child spawns).
 *
 * Output is JSON by default. `--pretty` switches to a human table where it
 * makes sense; everywhere else it pretty-prints the same JSON.
 */

import { ensureRotomSkillMd } from "../shared/skill-md.js";
import {
  parseArgs,
  setPretty,
  resolveAgent,
  flagStr,

  fail,
} from "./common.js";
import { cmdConfig } from "./config.js";
import { cmdE2ed } from "./e2ed.js";
import { cmdWhoami } from "./identity.js";
import { cmdStatus } from "./identity.js";
import { cmdDirectory } from "./directory.js";
import { cmdGroup } from "./group.js";
import { cmdIssue } from "./issue.js";
import { cmdNote } from "./note.js";
import { cmdCollab } from "./collab.js";
import { cmdSchedule } from "./schedule.js";
import { cmdMaster, colonExpand } from "./master.js";
import { cmdExecutor } from "./executor.js";
import { cmdInit } from "./init.js";

/**
E2ED (End-to-End Delivery):
  e2ed start <file|text> [--title T] [--cwd DIR]     create requirement
  e2ed ls                                              list requirements
  e2ed show <groupId>                                  show requirement details
  e2ed deliver <groupId> [--plan-only|--code-only] [--fix]  start delivery
  e2ed review <groupId> [--type requirement|plan|code]      start review
  e2ed metrics <groupId>                               show metrics
  e2ed timeline <groupId>                              show event timeline
 */

const HELP = `rotom — Mesh CLI

Usage: rotom [--as <agent>] [--pretty] <command> [args]

Agent selection:
  --as <name>           override which registered agent to act as
  ROTOM_AGENT env       same, via env (takes priority over --as)
  defaultAgent (config) fallback
  Auto-discovery: workers in ~/.rotom/executor.config.json resolve
  by name without needing 'rotom config add-executor' first.

Config:
  config show
  config init
  config use <name>                            set default agent
  config add-openclaw <name> <openclaw.json>   register an OpenClaw-hosted agent
  config add-executor <name> <executor.json>   register an executor worker
  config remove <name>

Bootstrap (first-time setup):
  init                                         detect claude/codex/hermes, ask for
                                               names + master IP, register agents,
                                               and write ~/.rotom/executor.config.json
    Flags:
      --master <ip:port>     skip prompt (default: 127.0.0.1:28800)
      --domain <name>        skip prompt (default: pick from master's existing
                             domains; falls back to "默认部门" or "default")
      --name-prefix <p>      default name = <p>-<tool>  (default: $USER)
      --tools <a,b,c>        limit detection to a subset of claude,codex,hermes
      --yes / -y             accept all defaults, do not overwrite without confirm
      --force                overwrite existing executor.config.json without prompt

Identity:
  whoami
  status                                        master health check (no agent needed)

Read:
  directory [--online] [--domain D]
  group list
  group members <groupId>
  group history <groupId> [--limit N]
  group archive <groupId>
  group unarchive <groupId>
  issue list <groupId> [--status S] [--type task|collaboration]
  issue show <issueId>
  issue events <issueId>
  issue messages <issueId>
  issue comment <issueId> --message M [--reply-to <eventId>]

Send:
  group send <groupId> <target> <message...>

Issue / collaboration:
  issue create <groupId> --description D [--title T] [--priority low|medium|high|critical]
                         [--assignee <agent>] [--approval-policy r_allow|rw_allow] [--run]
    description 是主输入;title 可选,未传时由后端从前 40 字符自动截断生成。
    description 以已注册的 slash command 开头时（如 "/plan ..."）将以对应模式执行。
    /plan：Claude 走 --permission-mode plan；Codex 注入 developerInstructions。
    --assignee 创建后立即把 issue 指派给指定 agent（不会自动起跑）。
    --approval-policy rw_allow（默认,读写都默认通过) / r_allow（读默认通过,写需人工审批)。
    --run 创建+指派后立即派发执行；必须同时给 --assignee，且 agent 必须在线。
          --run 的 prompt 直接用 --description;若只传 --title 则 fallback 到 title。
  issue update <issueId> [--title T] [--description D] [--priority low|medium|high|critical]
                         [--assignee <agent> | --unassign] [--approval-policy r_allow|rw_allow]
                         [--status open|in_progress|completed|failed|cancelled]
    局部更新 issue 字段。至少给一个 flag。
    只传 --description 不传 --title 时,后端会重新截断 title 并重解析 slash command。
    --assignee / --unassign 互斥。
    --status 低层 setter,可任意切换(含 reopen cancelled→open),无状态机限制。
  issue cancel <issueId>
  issue delete <issueId>
  collab create <groupId> --title T --goal G --participants a,b[,c] [--max-rounds 3] [--owner X]
  collab conclude <issueId> --summary S

Note (极简文字记录,纯 CRUD):
  note list <groupId>
  note show <noteId>
  note create <groupId> --title T [--description D]
  note update <noteId> [--title T] [--description D]
  note delete <noteId>

Schedule (群内定时任务,master 端 30s tick 调度):
  schedule list                              [--group <id>] [--pretty]
  schedule show <id>
  schedule add   --group <id> --mode <agent|message> [--agent A] --prompt P
                 ( --every <dur> | --in <dur> | --at <iso> )
                 [--name N] [--repeat N|0|∞] [--enabled true|false]
  schedule update <id> [--every D] [--in D] [--at ISO] [--prompt T] [--name N]
                      [--mode agent|message] [--agent A]
                      [--repeat N|0|∞] [--enabled true|false]
  schedule remove <id>                       (alias: delete)
  schedule enable <id> | disable <id>
  schedule trigger <id>
    --every <dur>   例 30s / 5m / 2h / 1d       interval 模式,>= 30s
    --in    <dur>   例 3m                        one-shot,相对当前时间
    --at    <iso>   例 2026-06-22T09:00          one-shot,绝对时间
    --repeat N      最多跑 N 次后自动 disable;传 0 或 ∞ 表示不限次数

Process lifecycle (local daemon control — do not require an agent):
  master <start|stop|restart|status> [--daemon] [--port N] [--host A] [--data D] [--dev]
  master:start | master:stop | master:status | master:restart   (alias)
  executor [--config <path>]      start executor workers (reads ~/.rotom/executor.config.json by default)

Global flags:
  --pretty   format output for humans (tables / indented JSON)
`;

async function main(): Promise<void> {
  ensureRotomSkillMd();

  const { positional, flags } = parseArgs(process.argv.slice(2));
  setPretty(flags.pretty === true);

  if (positional.length === 0 || flags.help === true || positional[0] === "help") {
    process.stdout.write(HELP);
    return;
  }

  const cmd = positional[0];
  const rest = positional.slice(1);
  const asFlag = flagStr(flags, "as");

  // Commands that don't need an agent
  if (cmd === "config") return cmdConfig(rest, flags);
  if (cmd === "e2ed")   return cmdE2ed(rest, flags);
  if (cmd === "init")   return cmdInit(rest, flags);

  // Master / executor / status — no agent required
  if (cmd === "master" || cmd === "master:start" || cmd === "master:stop" ||
      cmd === "master:status" || cmd === "master:restart") {
    return cmdMaster(colonExpand(cmd, rest), flags);
  }
  if (cmd === "executor") {
    return cmdExecutor(rest, flags);
  }
  if (cmd === "status") {
    return cmdStatus(rest, flags);
  }

  const agent = resolveAgent(asFlag);

  switch (cmd) {
    case "whoami":          return cmdWhoami(agent);
    case "directory":       return cmdDirectory(agent, flags);
    case "group":           return cmdGroup(agent, rest, flags);
    case "issue":           return cmdIssue(agent, rest, flags);
    case "note":            return cmdNote(agent, rest, flags);
    case "collab":          return cmdCollab(agent, rest, flags);
    case "schedule":        return cmdSchedule(agent, rest, flags);
    default: fail(`unknown command: ${cmd}\nRun 'rotom help' for usage.`);
  }
}

main().catch((e: Error) => fail(e.message));
