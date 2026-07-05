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
import { cmdWhoami } from "./identity.js";
import { cmdStatus } from "./identity.js";
import { cmdDirectory } from "./directory.js";
import { cmdGroup } from "./group.js";
import { cmdIssue } from "./issue.js";
import { cmdNote } from "./note.js";
import { cmdMemory } from "./memory.js";
import { cmdSkill } from "./skill.js";
import { cmdSchedule } from "./schedule.js";
import { cmdAsk } from "./ask.js";
import { cmdMaster, colonExpand } from "./master.js";
import { cmdExecutor } from "./executor.js";
import { cmdInit } from "./init.js";
import { cmdJoin } from "./join.js";
import { cmdRepo } from "./repo.js";
import { cmdRun } from "./run.js";
import { cmdTeam } from "./team.js";
import { cmdLink } from "./link.js";
import { cmdFed } from "./fed.js";

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

  join <masterHost:port> --name <n> --domain <d> --cli-tool <claude|codex|hermes|openclaw>
                                               [--working-dir PATH] [--profile-position P]
                                               [--profile-bio B] [--force]
                                               首次申请 token 落盘到 ~/.rotom/(本地
                                               交互式 CLI 作为 mesh host 用,不起
                                               executor daemon)。一个机器一个 CLI 一个
                                               agent:每次换 CLI 用不同 --name + --cli-tool。
                                               --cli-tool 缺省时按 PATH 自动探测。落盘结构
                                               对齐 executor.config.json workers[](含
                                               cliTool/workingDir/profile),master 侧不存
                                               cliTool(REST-only,不维持 WS)。

Identity:
  whoami
  status                                        master health check (no agent needed)

Read:
  directory [--online] [--domain D]
  group create <title> --agents <a,b[,c...]> [--message M] [--note D|--note-file F] [--cwd PATH] [--no-template] [--a2a-direct]
                                               一键建群+拉人。默认加载"群内讨论方案设计"
                                               guidance 模板(可 --no-template 跳过)。
                                               预检 --agents 名字都已注册,未注册 → fail 不建群。
                                               --a2a-direct  建单播群(unicast):≥2 成员,
                                                            消息只入库、不广播,worker 不被
                                                            自动唤醒;只在 CLI --need-reply
                                                            显式点名时叫醒对方回话,每轮
                                                            A 发 → B 回 → 停。
  group list
  group members <groupId>
  group history <groupId> [--limit N]
  group new-messages <groupId> --since <ISO>     只看某个时间点之后的新消息(轮询用)
  group archive <groupId>
  group unarchive <groupId>
  issue list <groupId> [--status S] [--type task]
  issue show <issueId>
  issue events <issueId>
  issue messages <issueId>
  issue comment <issueId> --message M [--reply-to <eventId>]

Send:
  group send <groupId> <target> <message...> [--no-dispatch] [--need-reply]
    --no-dispatch  只入库+广播,不 trigger target 的 worker(同步信息用)
    --need-reply   自动补 @target,master 硬剥回复里的 @asker 防回触发(一问一答)

Issue:
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

Note (极简文字记录,纯 CRUD):
  note list <groupId>
  note show <noteId>
  note create <groupId> --title T [--description D]
  note update <noteId> [--title T] [--description D]
  note delete <noteId>

Memory (记忆体系:note=纯人看 agent_visible=0;memory=agent 可见 agent_visible=1):
  memory search <keyword> <groupId> [--scope group|global] [--category <c>]
  memory list <groupId> [--scope group|global] [--type note|memory|all] [--category <c>] [--tags t1,t2]
  memory get <memoryId>
  memory add <groupId> --key K --value V --category C [--scope global] [--summary S] [--tags t1,t2]
                 [--visibility group|global|private] [--no-agent-visible] [--expires 7d]
  memory update <id> [--value V] [--category C] [--visibility V] [--agent-visible|--no-agent-visible]
  memory remove <id>
  memory promote <id> --visibility global
  memory pending <groupId> [--scope global]
  memory approve <id>
  memory reject <id>
  memory stats <groupId> [--scope global]

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

Ask (Agent A 提问 B + 5min 超时兜底 bridge,详见 docs/AGENT_ASK_REPLY_TIMER.md):
  ask <groupId> <target> <question...>   [--timeout 5m] [--escalate-to <真人>]
    发问 + 建 bridge。系统自动 5min 超时:
      - B @ A → master 正常 dispatch 给 A,timer 自动 cancel
      - B 不 @ 回复 → 5min 后系统建 Issue 给 A,描述里复述回复
      - 完全无回复 → 5min 后系统建 Issue 指示 A @ 真人求救
    target 离线 → 不建 bridge,exit 2(提示 A 自己 @ 真人)
  ask list --group <id> [--status pending|answered|timed_out|cancelled] [--pretty]
  ask show <bridgeId>
  ask cancel <bridgeId>                    A 主动 cancel(收到非@回复,自己判断是回复了)

Process lifecycle (local daemon control — do not require an agent):
  run <opc|federation> [opts]     一站式启动 master + executor(等价 bin/rotom-up.sh start)
    opc           OPC 模式(默认,本机 master + 自动 spawn executor)
    federation    协调 master(注入 ROTOM_MASTER_ROLE=coordination),作为 federation 中心节点
    通用选项: --port N | --host A | --data D | --no-build | --dev
  master <start|stop|restart|status> [--daemon] [--port N] [--host A] [--data D] [--dev]
  master:start | master:stop | master:status | master:restart   (alias)
  executor [--config <path>]      start executor workers (reads ~/.rotom/executor.config.json by default)

Repo cache (内置 git worktree 缓存,migration 051;本机 FS 操作,不需要 agent):
  repo list                       列出 ~/.rotom/repos/ 下所有 bare clone + worktree 数 + 磁盘占用
  repo prune [--remove-orphans]   清理孤儿 worktree 元数据,可选删除无引用且 30 天未 fetch 的 bare clone
  repo fetch <repo-id>            显式 git fetch --prune 某 bare clone
  repo remove <repo-id>           删除 bare clone(要求无活跃 worktree)

Federation (跨 master 协作,不依赖 dashboard):
  team join <coordEndpoint> [--team-name N]   本机 master 运行时加入远端协调 master 形成团队
                                              coordEndpoint 形如 ws://192.168.1.5:28800
  team leave                                  离开当前团队,切回 standalone
  team list                                   已加入的团队列表(本机视角)
  team members [--team-id <id>]               团队内可见 agent 列表(--team-id 缺省读 ~/.rotom/team.json)

  link join <coordEndpoint> [--hostname N]    一次性:生成 masterId + 写 ~/.rotom/link.json(轻量客户端模式)
  link start [--port N]                       启动 rotom-link daemon(默认端口 28900),不起完整 master
  link stop | restart | status | logs         daemon 生命周期
  (随后可 rotom fed members / rotom fed ask <ref> "...")

  fed members                                 列出协调 master 同步来的可见 agent
  fed ask <ref> "<question>" [--timeout 5m]   阻塞等回复(ref 形如 alice@hostB 或 alice)

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
  if (cmd === "init")   return cmdInit(rest, flags);
  if (cmd === "join")   return cmdJoin(rest, flags);
  if (cmd === "team")   return cmdTeam(rest, flags);
  if (cmd === "link")   return cmdLink(rest, flags);
  if (cmd === "fed")    return cmdFed(rest, flags);

  // Master / executor / status — no agent required
  if (cmd === "master" || cmd === "master:start" || cmd === "master:stop" ||
      cmd === "master:status" || cmd === "master:restart") {
    return cmdMaster(colonExpand(cmd, rest), flags);
  }
  if (cmd === "executor") {
    return cmdExecutor(rest, flags);
  }
  if (cmd === "repo") {
    return cmdRepo(rest, flags);
  }
  if (cmd === "run") {
    return cmdRun(rest);
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
    case "memory":          return cmdMemory(agent, rest, flags);
    case "skill":           return cmdSkill(agent, rest, flags);
    case "schedule":        return cmdSchedule(agent, rest, flags);
    case "ask":             return cmdAsk(agent, rest, flags);
    default: fail(`unknown command: ${cmd}\nRun 'rotom help' for usage.`);
  }
}

main().catch((e: Error) => fail(e.message));
