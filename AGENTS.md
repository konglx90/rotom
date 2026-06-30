# AGENTS.md

This file is the entry point for coding agents working in this repository. Keep it short and operational. 深背景在 `README.md`、`DESIGN.md` 和 `docs/`。

## Project Overview

Rotom（仓库名 `a2a-gateway`）是一个**数字员工 Mesh** —— 一个中心化的 agent 协作网络。三个独立组件：

- **Master**（`src/master/`）：唯一中枢服务，HTTP `/api` + WS `/ws` + 内嵌 Dashboard 都挂在 `:28800`，用 SQLite WAL 持久化群 / Issue / 消息 / 记忆 / 会话。
- **Executor**（`src/executor/`）：长连接守护进程，单进程托管 N 个 Worker，**1 Worker = 1 Agent**。Worker 持 mesh token 与 Master 维持 WS（接 Issue / 推送），并 spawn 对应 CLI 进程（claude / codex / openclaw / hermes）作为 Agent。`generic-cli` 后端已删除 —— 配置未知 cliTool 直接 fail-fast。
- **rotom CLI**（`src/cli/rotom.ts`）：所有数字员工行为的统一出口，借 Agent token 调 REST。既被 Agent 在容器内通过 Bash 调用（加载 `skill/rotom-a2a-communicate`），也能由真人 / Claude Code 在 shell 里手动用。
- **Dashboard**（`packages/dashboard/`）：React 18 + Vite SPA，账号密码登录。`category=真人` 的 agent 不参与 Issue 抢单，仅作为人类参与者占位。

Agent 不直连 Master，所有 agent-to-agent 通讯都经 Master 中转，没有点对点连接。Master 在 :28800 同时承载 `/api`（REST）、`/ws`（Agent 协议）、`/api/terminal`（xterm PTY）、`/dashboard`（SPA）四条入口。

## Common Commands

```bash
pnpm install
pnpm build                       # tsc，外加拷贝 claude-code-hook.cjs 到 dist
pnpm build:master                # 同上 + 打包 dashboard SPA 到 dist/master/dashboard

pnpm master                      # 前台启动 Master（开发用）
pnpm master:start                # 守护进程启动（后台 + 日志）
pnpm master:status
pnpm master:restart
pnpm master:stop

# 同一组启停也支持 rotom CLI（自动转发到 bin/mesh-master.sh）
rotom master start --daemon --port 28800 --data ~/.rotom
rotom master stop | status | restart

# 一站式启停（同时拉起 Master + Executor 守护进程，PID / 日志落在 ~/.rotom/{run,logs}）
pnpm start | stop | restart | status | logs
# 上述也支持 rotom 同义命令
rotom master:start | master:stop | master:status | master:restart

pnpm executor                    # 前台跑 Executor（tsx 直跑 TS 源码）
rotom executor                   # 等价上面，自动选 dist/executor/index.js 或 tsx

pnpm dashboard:dev               # Vite dev server（仅 dashboard）
pnpm dashboard:build
pnpm dashboard:preview

pnpm test                        # node --import tsx --test tests/*.test.ts

# rotom CLI 首次 bootstrap（自动 detect claude/codex/hermes/openclaw + 写 ~/.rotom/executor.config.json）
rotom init [--master ip:port] [--domain D] [--tools claude,codex,hermes,openclaw] [--yes] [--force]

# 常用子命令
rotom whoami
rotom status                     # 不需要 agent，单纯打 /health
rotom directory --pretty
rotom group list | members | history | send | upload | archive | unarchive
rotom issue create | list | show | events | messages | comment | cancel | interrupt | continue | append
rotom schedule add | list | trigger | enable | disable
rotom memory add | search | list | get | promote | pending | approve | reject
rotom skill list | search | get | create | update | bind | mine
rotom note list | show | create | update | delete        # 旧 API 兼容层，转调 memory
rotom ask list | show | cancel                            # 提问已改用群消息 + #reply 标记
```

Master 默认监听 `0.0.0.0:28800`（`MESH_MASTER_PORT` 可覆盖）；数据目录 `~/.rotom/`（`ROTOM_HOME` 覆盖）；日志按日轮转 `~/.rotom/logs/mesh-master-YYYY-MM-DD.log`。`bin/mesh-master.sh` 的 PID 文件**仍**写在 `~/.openclaw/mesh-master.pid`（脚本历史遗留，没跟 `ROTOM_HOME` 走）—— 启停脚本与外部监控依赖这个路径，**不要改**。

## Read These Docs

- `README.md`：架构图、特性、快速开始、REST API 总表、WS 协议、close codes
- `docs/INSTALL.md`：Master / Executor / rotom CLI 三件套完整安装手册
- `docs/AGENT_USER_GUIDE.md`：Agent 协作用户指南
- `docs/AGENT_ASK_REPLY_TIMER.md`：A → B 提问的 5min timer + 升级 Issue 兜底（方案 C）
- `docs/ASK_BRIDGE_GUIDE.md`：ask-bridge 创建 / 取消 / 升级路径
- `docs/DEV_DELIVERY_WORKFLOW.md`：E2ED 端到端需求交付 pipeline
- `docs/GROUP_CHAT_ARCHITECTURE.md`：群聊子系统、Router 决策、离线队列、WS 协议消息类型
- `docs/GROUP_CHAT_RENDER_PERF.md`：群聊渲染性能调优记录
- `docs/QUICK_REF.md`：任务 Issue / 群消息的两场景速查
- `docs/toolbox-tab-reorder.md`：工具箱 tab 重排相关说明
- `DESIGN.md`：Dashboard 视觉系统（Wise 风格设计规范）
- `skill/rotom-a2a-communicate/SKILL.md`：注入到 agent 的协作 skill —— 行动判定、Issue 类型决策、写盘必须挂 issue 的硬规则

## Runtime Summary

- **数据主路径**：Worker WS → `src/master/ws-hub/connection.ts` 派发 → `src/master/ws-hub/{routing,conversation,sessions,directory}.ts` → SQLite（`src/master/db/{core,internal,agents,groups,issues,messages,ask-bridges,...}.ts`）→ 推送给目标 client；离线收件人走 `src/master/offline-queue.ts`（100 条 / 24h TTL）。`ws-hub.ts` 是 `db/index.ts` 风格的 facade，下层 `internal.ts` 装载方法模块。
- **REST 路径**：所有 `/api/*` 端点拆到 `src/master/api/{agents,groups,issues,artifacts,memory,skills,notes,schedules,schedule-patterns,sessions,share,asks,skills,domains,upload,uploads,issues-patrol,guidance-templates,real-persons,cross-domain,health,...}.ts`，由 `src/master/api/index.ts` 用 `registerXxxRoutes()` 装载。鉴权走 `src/master/auth.ts`（token sha256 + JWT 7d，token 自 migration 016 起**明文**存到 `agents.token` 供 dashboard 回显）；中间件 permissive —— Dashboard cookie session 与 CLI `Authorization: Bearer mesh_xxx` 都放行（CLI 的 token 解析注入到 `req.agentAuth`）。
- **Worker 生命周期**：`src/executor/index.ts` 启动 → 读 `~/.rotom/executor.config.json`（单 worker / 多 worker 两种 schema 都吃）→ 为每个 worker 拉起 `src/executor/worker.ts` → 通过 `src/executor/cli-executor.ts`（`CliExecutor` interface）调度具体 backend（`src/executor/executors/{claude-code,codex,hermes-cli,openclaw}.ts`）。`worker.ts` 把消息分派逻辑拆给 `worker-issue.ts` / `worker-chat.ts` / `worker-connection.ts` 三个子模块。
- **Issue 抢单**：`category=Agent` 参与抢单，`category=真人` 不参与；并发上限 `maxConcurrent`（默认 2）。issue 生命周期新增 `interrupt` / `append` / `continue` 三个状态：interrupt 不翻 status（保留 session），append 把指令入 `pendingAppends` 队列等当前 CLI 收尾 `--resume` 续跑，continue 走 completed/failed 后的再问。
- **Issue 审批**：`approval_policy ∈ {r_allow, rw_allow}`（默认 `rw_allow`）。`r_allow` 下写盘工具必经 `PreToolUse` hook 挂起 → WS `issue_approval_request` 推给 dashboard → 用户 Accept/Deny → `issue_approval_response` 回 worker；`rw_allow` 直接本地 accept 不发请求。**只读 Bash** 走 `src/shared/readonly-allowlist.ts` 内置白名单（`ls`/`cat`/`git log`/`rotom whoami` 等）静默 accept —— fail-closed：管道/重定向/`$()`/前导 env 赋值一律不命中。`src/executor/cli-executor.ts` 的 `ApprovalRequestInput` 支持 `exec` / `file_change` / `plan` / `ask` 四种 kind。
- **Issue slash command**：`/plan` 触发各 backend 切到 plan 模式（claude → `--permission-mode plan`；codex → `thread/start` 注入 `developerInstructions`）。注册表在 `src/shared/slash-commands.ts`。issue 创建 / 编辑时由 master 解析出 `slash_command` 字段，dispatch 时透传给 worker。
- **Issue usage 推送**：worker 端 executor 调 `onUsage` 给单轮增量 → `usageAccumulators` sum 累积 → leading+trailing 1s 节流推 `issue_usage_progress` WS → master 仅转发给订阅了该 issueId 的连接（**不广播、不落 DB**）。终态由 `flushIssueUsage` 强制推一次并用 `result.usage` 覆盖累积值。
- **Issue todo**：`onTodos` 回调走独立 `issue_todos_update` WS 消息 + `issues.latest_todos_json` + `event_type=todos` issue_event。dashboard 直接消费 `latest_todos` 字段渲染常驻面板（空 / 非法 JSON 一律视作"未上报"）。
- **Prompt 组合器**：`src/shared/prompt-composer.ts` 把"喂给 CLI agent 的 prompt"分 8 层组装（rotom-cli → agent-role → group-basic → group-guidance → cwd → task → memory-pointer → skill-pointer），每层标数据源，**纯函数**。issue 模式不拼 rotom-cli 层（避免把任务描述误导成"发消息"）。worker 调它拿 `ComposedPrompt`：`final` 喂 executor，`layers` 透传 master 落 `chat_message_prompts` 表（dashboard 点击消息可看"分层组成"）。
- **Session 持久化**：worker `auth` 后 master 推 `session_sync_push`（`agent_sessions` 表，migration 038-039），worker 每次 SessionStore 变更推 `session_snapshot`（`src/executor/session-store.ts`）。**老的 worker 侧 `~/.rotom/sessions.json` 已被替代** —— `backfillFromLegacyJson` 只在启动时 one-shot 读一次后 `unlink`。session 失效（poison / provider error / 用户主动删）不删行，只打 `invalidated_at` 戳，dashboard 展示全量历史。
- **Ask-bridge**：`ask_bridges` 表 + 5min timer。A 在群里 @B + `#reply` 标记时 master 自动建 bridge（`autoCreateBridgeOnMention`），B 直接 @ A → mark answered；B 离线 / 不 @ 回复 → scheduler handler `ask-bridge-check`（20s tick）查 `findLatestReplyForBridge` —— 命中则 mark answered + 复述；超时则建 Issue 升级。详见 `docs/AGENT_ASK_REPLY_TIMER.md`。
- **Scheduler**：`src/master/scheduler.ts` 30s tick 扫 `getDueScheduledTasks`，at-most-once：先 `rescheduleTask` 推进 `next_run_at` 再执行。schedule 两形态：`interval`（每 N 秒）+ `once`（指定时间戳跑一次，跑完 disable）。recurring grace window = `max(120, min(interval_sec/2, 7200))` 秒，错过 fast-forward 不补跑；oneshot grace = 120 秒。两种模式：`mode=agent` 派 `pushIssueAssignment`（agent 离线或上一轮 issue 仍 in_progress 跳过但 `next_run_at` 仍推进）；`mode=message` 调 `postSystemToGroup`。`handler_key` 非空时走 `src/master/scheduler-handlers.ts` 注册表（当前只有 `ask-bridge-check`）。
- **Patrol**：`type=patrol` 群限 1 个未归档、限 1 个 agent（巡检员）。建群时 master 自动建 `issue-patrol` scheduled task（interval 3600s，default enabled）+ 绑 `issue-patrol-rules` skill。`src/master/patrol-terminal.ts` 在 issue 进 terminal 时解析 result JSON → 写 `issue_patrol_logs` + finish run。`/api/issues-patrol/{state,config,runs,logs}` 暴露状态 / 配置 / 历史给 dashboard。
- **Share Token**：`src/master/share-tokens.ts` 进程内 `share_<hex>` 临时 token，绑定到 1 个 group。Dashboard 用它给第三方只读访问群消息 / issue / 产物 / 笔记（`/api/share/:token/...`）；重启即失，无 TTL。
- **Group settings**：`groups.guidance_prompt`（群级 prompt 段，模板库复用 `guidance_templates`）；`group_member_settings` 存 per-(group, agent) `working_dir` 覆盖 + `profile` 覆盖（dispatch-enrich 合并到全局 profile，group 级字段胜出）。群可 `pinned_at`（置顶）/ `archived_at`（只读：禁发消息 / 建 issue / 改成员 / 改 settings）。
- **Group working dir 三层解析**（`src/master/group-paths.ts`）：per-(group, agent) `group_member_settings` 覆盖 → `groups.working_dir` → `~/.rotom/artifacts/<groupId>`（legacy `~/.rotom/results/<groupId>` 兜底）。**该路径仅为 dashboard 展示元数据** —— executor 端 cwd 走本机 `resolveIssueCwd`（`executor.config.json.workingDirMap[groupId]` 或 `<base>/<groupId>` 派生），跨机器部署**不可信** master 推送路径。
- **Avatar**：`/api/agents/avatar` base64 上传，落到 `/tmp/rotom-avatars/<agentId>-<ts>-<rand>.<ext>`，URL `/api/avatars/<filename>` 静态 serve。限制 ≤ 2MB，mime 限 png/jpeg/gif/webp。
- **rotom CLI 身份解析**：`ROTOM_AGENT` env > `--as <name>` > `~/.rotom/config.json#defaultAgent` > `~/.rotom/executor.config.json` 自动发现 worker（按 name 匹配，免 `config add-executor`）。`--from` 标志**永远不接受**。
- **WS 心跳**：10s 间隔 / 90s 超时 / 30s 扫一次。`requestId` 关联请求与 reply。
- **限流**：默认 60 msg/min/agent。**豁免清单**：`heartbeat` / `a2a_reply_chunk` / `a2a_reply_end` / `issue_update` —— 改豁免清单会掐断流式响应（新版 hermes 一次回答可能上百 chunk）。
- **消息去重**：`src/shared/dedup.ts`（5min TTL）；审计日志最大 500 条（`/api/audit`）。
- **Dashboard SPA**：`packages/dashboard`（React 18 + Vite + react-router 6 + monaco + xterm），build 产物 `packages/dashboard/dist/src/master/dashboard/`，`pnpm build:master` 才会再 cp 到 `dist/master/dashboard/`。
- **Claude Code 钩子**：`src/executor/claude-code-hook.cjs` 是 `.cjs`，需要 `pnpm build` 时显式拷贝到 `dist/executor/`（已写在 build script 里）。

## Key Subsystems

| Subsystem | 入口文件 | 触发点 |
|---|---|---|
| Scheduler + Patrol | `src/master/scheduler.ts` + `scheduler-handlers.ts` + `patrol-terminal.ts` | 30s tick / issue 终态 |
| Ask-bridge | `src/master/db/ask-bridges.ts` + `scheduler-handlers.ts` 的 `ask-bridge-check` + `src/cli/ask.ts` | 群 @ + `#reply` 标记 / 5min 超时 |
| Memory & Note | `src/master/api/memory.ts` + `src/master/db/memory.ts` + `src/cli/memory.ts` / `note.ts` | agent 主动 `add` / 群上下文指针 |
| Skill | `src/master/api/skills.ts` + `src/master/db/skills.ts` + `src/cli/skill.ts` | dashboard 创建 / `rotom skill bind` 绑到 group+agent |
| Session | `src/executor/session-store.ts` + `src/master/db/agent-sessions.ts` + `src/master/ws-hub/sessions.ts` + `src/master/api/sessions.ts` | `auth` 之后双向 snapshot 同步 |
| Share Token | `src/master/share-tokens.ts` + `src/master/api/share.ts` | dashboard 群设置 mint 临时链接 |
| Group guidance | `src/master/api/guidance-templates.ts` + `src/master/db/guidance-templates.ts` | `PATCH /groups/:id` 设 `guidancePrompt` |
| Group member settings | `src/master/api/groups.ts` 的 `members/:agentName/{working-dir,profile}` | dashboard MemberListModal |
| Issue approval | `src/shared/readonly-allowlist.ts` + `src/executor/cli-executor.ts` 的 `onApprovalRequest` | cli hook 触发 / dashboard Accept/Deny |
| Issue interrupt | `src/master/api/issues.ts` 的 `/interrupt` + `src/executor/worker-issue.ts` 的 `runIssueExecution` finally | dashboard ESC / 中断按钮 |
| Issue usage | `src/executor/worker.ts` 的 `reportIssueUsage` / `flushIssueUsage` | executor 调 `onUsage` / dashboard 订阅 issue 详情 |
| Issue todo | `src/executor/cli-executor.ts` 的 `onTodos` + `src/master/db/issues.ts` 的 `updateIssueTodos` | claude `TodoWrite` 工具调用 |
| Slash command | `src/shared/slash-commands.ts` + `src/master/api/issues.ts` 解析 title | `rotom issue create --title "/plan ..."` |
| Real persons | `src/shared/protocol.ts` 的 `REAL_PERSONS` + `/api/real-persons` | dashboard issue owner / 审批人选择 |
| Cross-domain | `src/master/api/groups.ts` 的 `/cross-domain` + `db/domains.ts` | 跨域规则 CRUD |

## Core Files

| 文件 | 职责 |
|---|---|
| `src/master/server.ts` | Master 独立入口（CLI），监听 28800，serves Dashboard + WS + REST + Terminal |
| `src/master/embedded.ts` | Master 可嵌入版本（不接管 SIGINT/SIGTERM，外部控制生命周期） |
| `src/master/scheduler.ts` + `scheduler-handlers.ts` | 30s tick 调度 + handler 注册表 |
| `src/master/patrol-terminal.ts` | 巡检 issue 终态 result 解析 + 写 `issue_patrol_logs` |
| `src/master/terminal-hub.ts` | Dashboard xterm 的 WS / node-pty 桥（可选依赖） |
| `src/master/share-tokens.ts` | 进程内 `share_<hex>` 临时 token |
| `src/master/group-paths.ts` | 群 workingDir 三层解析（成员 override → 群级 → default） |
| `src/master/util/persona.ts` | `TIMER_PERSONA_NAME = "星期五"`（人设名，scheduler / bridge 统一用） |
| `src/master/api/index.ts` | REST 入口，`registerXxxRoutes()` 装载 20+ 模块 |
| `src/master/api/{agents,groups,issues,artifacts,memory,skills,notes,schedules,schedule-patterns,sessions,share,asks,domains,uploads,issues-patrol,guidance-templates,real-persons,cross-domain}.ts` | REST 各领域端点 |
| `src/master/db/index.ts` → `internal.ts` | DB facade + composition root（`Object.assign` 装载 20+ 领域模块） |
| `src/master/db/{core,types,agents,groups,issues,messages,ask-bridges,schedules,schedule-patterns,memory,skills,notes,agent-sessions,issues-patrol,domains,guidance-templates}.ts` | SQLite 领域表操作（每个文件 = 一类表） |
| `src/master/ws-hub/index.ts` → `internal.ts` | WS Hub facade + composition root |
| `src/master/ws-hub/{connection,routing,directory,sessions,conversation}.ts` + `dispatch-enrich.ts` | WS Hub 方法模块 |
| `src/master/auth.ts` | token sha256 + JWT 校验 + `generateToken()` |
| `src/master/router.ts` | 路由决策（去重 + pending request 维护） |
| `src/master/offline-queue.ts` | 离线消息暂存（100 条 / 24h TTL） |
| `src/executor/index.ts` | Executor 主进程入口，load config + spawn N 个 worker |
| `src/executor/worker.ts` | Worker 抽象（WS + 抢单 + 状态上报 + activeTasks / pendingApprovals / pendingAppends） |
| `src/executor/worker-connection.ts` | WS 连接 + 重连 + 心跳 |
| `src/executor/worker-issue.ts` | Issue 生命周期（`executeIssue` / `runIssueExecution` / 审批 / 中断） |
| `src/executor/worker-chat.ts` | 群聊 reply + 同群串行队列 |
| `src/executor/cli-executor.ts` | `CliExecutor` interface + `ExecuteOptions` + `ApprovalRequestInput` + `ApprovalDecision` |
| `src/executor/session-store.ts` | 进程内 session 注册表，hydrate 自 master `session_sync_push` |
| `src/executor/claude-code-hook.cjs` | Claude Code `SessionStart` / 输出追踪钩子（CommonJS） |
| `src/executor/{jsonrpc-transport,process-runner,reasoning-status}.ts` | codex JSON-RPC / 进程 spawn / 思考态跟踪辅助 |
| `src/executor/executors/{claude-code,codex,hermes-cli,openclaw}.ts` | 后端适配 |
| `src/cli/rotom.ts` | rotom CLI 入口（身份解析 + 17 个子命令调度） |
| `src/cli/{common,config,identity,directory,group,issue,ask,note,memory,skill,schedule,master,executor,init}.ts` | 各子命令实现 |
| `src/shared/protocol.ts` | WS 消息类型（client→master + master→client 双向） |
| `src/shared/constants.ts` | 全局常量（端口、心跳、限流、WS close codes、issue statuses） |
| `src/shared/agent-profile.ts` | `AgentProfile` schema + `mergeGroupProfile`（成员级覆盖合并到全局） |
| `src/shared/group-context.ts` | 群上下文工具（极简指针注入 helper） |
| `src/shared/prompt-composer.ts` | Prompt 8 层组合器（rotom-cli / agent-role / group-basic / group-guidance / cwd / task / memory-pointer / skill-pointer） |
| `src/shared/readonly-allowlist.ts` | `r_allow` 下只读 Bash 白名单（fail-closed） |
| `src/shared/rotom-cli-prompt.ts` | rotom CLI 短 hint（注入 rotom-cli 层），`ROTOM_CLI_PROMPT_VERSION` |
| `src/shared/skill-md.ts` | 启动时把 `skill/rotom-a2a-communicate/SKILL.md` 写到 `~/.rotom/SKILL.md`（幂等） |
| `src/shared/skill-context.ts` | `buildSkillPointerLayer` 极简指针层 |
| `src/shared/slash-commands.ts` | `/plan` 等 slash command 解析 + 模式注入 |
| `src/shared/dedup.ts` | 消息去重 |
| `src/shared/title.ts` | description → title 自动截断（40 字符） |
| `src/shared/logger.ts` | 统一日志 + 按日轮转 file logging |
| `packages/dashboard/` | React 18 + Vite SPA；features 拆分 `agents` / `groups` / `kanban` / `messages` / `notifications` / `terminal` / `toolbox` |
| `bin/mesh-master.sh` | Master 启停（start/stop/restart/status/install-service，PID 写 `~/.openclaw/mesh-master.pid`） |
| `bin/rotom-up.sh` | 一站式 Master + Executor 守护（PID / log 落 `~/.rotom/{run,logs}`） |
| `bin/rotom` | rotom CLI launcher（`dist/cli/rotom.js` 优先，回退 `tsx src/cli/rotom.ts`） |
| `bin/rotom-send-with-status` | rotom 带状态发消息辅助脚本 |
| `migrations/001-043/*.sql` | SQLite schema migrations（001 init → 043 issue-patrol），命名 `NNN-description.sql`，**只追加**不修改老文件 |
| `skill/rotom-a2a-communicate/SKILL.md` | 注入 Agent 的协作 skill |
| `scripts/fix-node-pty-perms.mjs` | postinstall：修 node-pty 权限 |
| `scripts/clear-legacy-category.mjs` | 一次性数据清理脚本 |

## Constraints

### 仓库结构
- 仓库使用 **pnpm workspace**（`pnpm-workspace.yaml` 声明 `packages/*`）。不要用 `npm install` / `yarn install`，会破坏 workspace symlink 和 `onlyBuiltDependencies` 白名单。
- 顶层 `tsconfig.json` 显式 `exclude: ["packages"]`：根 `pnpm build` 不编译 dashboard，dashboard 由 `pnpm dashboard:build` 走 vite。**全量产物**用 `pnpm build:master`。
- `src/executor/claude-code-hook.cjs` 是 **CommonJS**（与 `"type": "module"` 相反），必须保留 `.cjs` 后缀；build script 显式 `cp` 到 `dist/executor/`，不能改成全自动 tsc 输出。

### 进程 / 数据
- Master 端口范围固定 `:28800`（`MESH_MASTER_PORT` 覆盖）；**PID 文件仍写 `~/.openclaw/mesh-master.pid`**（`bin/mesh-master.sh` 现状）—— 外部监控脚本依赖这个路径，**不要改**。日志由 JS logger 写入 `~/.rotom/logs/mesh-master-YYYY-MM-DD.log`。
- 数据目录 `~/.rotom/`（`ROTOM_HOME` 覆盖），SQLite db 在 `<dataDir>/mesh.db`。
- `better-sqlite3` 和 `node-pty` 是 `optionalDependencies` + `pnpm.onlyBuiltDependencies` 白名单；postinstall 跑 `scripts/fix-node-pty-perms.mjs` 修 mac 执行位。新增 native dep 走相同路径。

### 协议 / 鉴权
- Agent token `mesh_` 前缀，**明文**存到 `agents.token`（migration 016 起）方便 dashboard 回显；写新代码时不要看到 `token_hash` 字段就当成只读 hash。
- WS close codes 是协议契约：`4001 Auth timeout` / `4002 Auth failed` / `4400 Invalid JSON` / `4401 Not authenticated` / `4429 Rate limited`。改这些会让所有 client 误判。
- REST API 中间件 permissive —— Dashboard cookie session 与 CLI `Authorization: Bearer mesh_xxx` 都放行。CLI token 解析注入到 `req.agentAuth`，管理端点（share mint、agent update 等）会 `requireAgent` 校验。

### Issue 行为
- **写盘必须挂 issue**（`skill/rotom-a2a-communicate/SKILL.md` 硬规则）：群消息触发时没 `in_progress` issue 只能 Read / Grep / Glob；遇到改动诉求先 `rotom issue create` 或提示发起方建。改 `prompt-composer.ts` 注入的 `[当前群活跃 issue]` / `[群消息 context]` prompt 段时确认仍带 issue id + state + cwd。
- **私聊已下线**，所有 a2a 走群聊（`rotom group send`）。不要在 protocol / API / CLI 复活 `direct` 通道。
- `category=真人` agent 不参与 Issue 抢单（仅人类参与者占位）；改 `router.ts` / `worker.ts` 抢单逻辑保留这条过滤。
- Issue `approval_policy` 默认 `rw_allow`（migration 029）；`r_allow` 下写盘工具必经 dashboard Accept/Deny 审批，**只读 Bash 走 `readonly-allowlist.ts` 白名单**（fail-closed，复合命令 / 管道 / env 赋值一律不命中）。
- Issue `interrupt` ≠ `cancel`：interrupt 保留 session_id 和 `in_progress` 状态，由 `runIssueExecution` finally 块决定是否 `--resume` 续跑 `pendingAppends`；cancel 才翻 `cancelled` 终态。
- 群 `archived_at` 非空后**只读**：禁发消息 / 建 issue / 改成员 / 改 settings；改群路由前先 `isGroupArchived` 拦。

### Subsystem
- Session 持久化在 master DB `agent_sessions`（migration 038-039），worker 侧 SessionStore 进程内；`~/.rotom/sessions.json` 仅在 `SessionStore.backfillFromLegacyJson` 启动时 one-shot 读 + `unlink`，**不要**加新逻辑往那写。
- Session 失效不删行，打 `invalidated_at` 戳（dashboard 全量历史可见）。失效时 worker 推 `session_invalidated` → master `upsertAgentSession(invalidated_at=now)`，再推 `session_snapshot` 同步 active 列表。
- 跨机器部署：`groups.working_dir` 与 dispatch 推送的 `workingDir` 是 dashboard 展示元数据；executor 端 cwd 必须走本机 `resolveIssueCwd`（`executor.config.json.workingDirMap[groupId]` → `<base>/<groupId>`）派生，**不要信** master 推送的路径。
- Patrol 群（`type=patrol`）限 1 个未归档、限 1 个 agent（巡检员）；建群时自动建 `issue-patrol` scheduled task（interval 3600s）+ 绑 `issue-patrol-rules` skill（`/api/groups` 的 `type=patrol` 分支）—— 改这块时不要把这套 auto-bootstrap 逻辑挪走。
- 限流豁免清单：`heartbeat` / `a2a_reply_chunk` / `a2a_reply_end` / `issue_update` —— 新加 chunk 消息类型时考虑是否进豁免；流式响应被掐会直接卡死 dashboard。
- `postSystemToGroup` sender 必须是字面量 `"system"`：dashboard / CLI 渲染端按字符串切样式。
- `rotom CLI` 永远不接受 `--from`：身份由 token 推断（`ROTOM_AGENT` env > `--as` > `defaultAgent`）。
- Dashboard 是 React 18 + Vite（不是 Vue —— 早期文档把它写成 Vue 是历史遗留）。

### Migration
- 命名格式 `NNN-description.sql`，**追加**不改老；`migrations/003-schema-version.sql` 维护版本表。`MeshDb.migrate()` 自动扫 `./migrations/`（`dist/master/` 或源码都试）。

## Testing

- 自动化测试使用 Node 内置 test runner + tsx：`pnpm test` → `node --import tsx --test tests/*.test.ts`。
- `tests/master-agent.test.ts` 覆盖 Master + Agent 注册 / WS / 路由的最小回路。新增 scheduler handler 集成测试时建议拆到 `tests/scheduler-handlers.test.ts`。
- Executor 后端、rotom CLI 子命令、Dashboard SPA 目前没有自动化测试；改动走手动回路：起 Master → 起 Executor → Dashboard / CLI 跑 issue create / claim / complete / interrupt。
- SQLite migration 改动请用一个新的空 `mesh-data/`（或 `ROTOM_HOME`）目录跑一次冷启动，确认 `migrate.up()` 序列无报错。
- WS 协议改动需要同时检查 `src/shared/protocol.ts`（`isClientMessage` 也要加）、`ws-hub/{connection,routing}.ts` 的 server 解析、所有 client（executor worker / dashboard / cli）的发送和接收 —— 漏改任何一端都会导致 4400 / 4401。
- Scheduler handler 改动务必手造一个 `scheduled_tasks` 行 + 跑 executor 旁路观察 `tick` 日志；handler 失败要 mark `last_status=error` + `last_error=<msg>`。

## High-Risk Gotchas

### 旧 9 条（沿用）
- **build script 不能丢 `cp src/executor/claude-code-hook.cjs ...`**：丢了 Claude Code agent 启动时找不到钩子文件，tsc 不报错。
- **token migration 016 之后是明文存储**：dashboard 需要把明文 token 回显给用户复制；写 `agents` API 时不要 mask 掉。
- **`postSystemToGroup` sender 必须是字面量 `"system"`**：写成 `System` / `SYSTEM` / 真实 agent 名都会破样式。
- **写盘必须挂 issue 是 skill 层硬规则**：改 `prompt-composer.ts` 注入的 `[当前群活跃 issue]` / `[群消息 context]` 段时确认仍带 issue id + state + cwd。
- **rotom CLI 身份解析顺序不可调换**：`ROTOM_AGENT` env 必须最高优先（executor spawn agent 子进程时通过 env 注入身份）。
- **WS 心跳 10s/90s 是和 Worker 重连 / 离线队列联动的**：改 `constants.ts` 心跳间隔时同步更新 Worker `activeDispatches` 上报节奏。
- **Dashboard build 输出在 `packages/dashboard/dist/src/master/dashboard/`**，`pnpm build:master` 才会再 cp 到 `dist/master/dashboard/`。本地直接跑 `pnpm dashboard:build` 不会让 Master 看到新前端。
- **`pnpm executor` 是 tsx 直跑 TS 源**：改 `src/executor/*.ts` 不用重新 build，但改 `src/shared/*.ts` 后如果同时跑着 master（dist 模式），shared 在两边是两份编译产物，行为可能不一致。
- **node-pty / better-sqlite3 是 native 模块**：Node 版本切换 / Electron 嵌入时要重新 build，否则启动报 `NODE_MODULE_VERSION` 不匹配。

### 新增 7 条
- **Session 持久化已迁 master DB**：`agent_sessions` 是 source of truth；SessionStore 是 worker 进程内缓存，`session_sync_push`（auth 时）+ `session_snapshot`（每次变更）双向同步。**不要**在 worker 侧加 JSON 落盘逻辑（multi-worker flush-overwrite bug 已修）。
- **Issue interrupt 不要二次 sendUpdate**：dashboard `/api/issues/:id/interrupt` 已落 `interrupted` issue_event；worker 收到 `issue_interrupt` WS 后**只**置 `task.interrupted = true` + `controller.abort()`，不调 `sendUpdate` —— 否则系统话会塞进 agent 气泡被 `groupEvents` 当成 mergeable progress 合并。
- **Issue approval policy 默认 `rw_allow`**：写 issue 创建 / dispatch 时记得带 `approvalPolicy`；r_allow 下 PreToolUse hook 必须挂，否则 cli 自动 bypass 直接写盘。
- **群 workingDir 不可信**：改 `dispatch-enrich.ts` 时不要把 `workingDir` 字段塞到 `a2a_message` 的 spawn cwd（executor 端有 `resolveIssueCwd` 本机派生）。master 端只用于 dashboard 展示元数据。
- **ask-bridge-check handler 20s tick**：单次跑挂**不要**直接 delete bridge / disable task；遵循"先 mark answered / timed_out 再 disable task"顺序，否则 next tick 又会扫到同一条 stuck bridge。
- **`ROTOM_HOME` 没在 `bin/mesh-master.sh` 里被尊重**：脚本仍写 PID 到 `~/.openclaw/mesh-master.pid`、读 `MESH_MASTER_DATA`（`~/.rotom` 兜底）。改 shell 脚本要小心理顺这两个 env（`ROTOM_HOME` 是 JS 层；`MESH_MASTER_*` 是 shell 层），混淆会致启动挂掉。

## Do Not Revisit

- 不要把私聊（`direct` a2a 通道）加回来。所有点对点交流走 `rotom group send <groupId> <target> ...`，由 Master 落库。
- 不要把 Dashboard 重新写成 Vue。包名里的 `Vue` / 早期文档措辞是历史遗留，技术栈已经是 React 18 + Vite。
- 不要在 worker 侧复活 `~/.rotom/sessions.json` 落盘 —— 已经迁 master DB，multi-worker 场景下 JSON 文件会互相覆盖。
- 不要在 CLI 加 `--from` 旋钮（身份伪造风险）。
- 不要建 / 改 `handler_key` 字段的 NOT NULL 假设 —— handler 模式是 scheduler 硬编码路径（`scheduler-handlers.ts` 注册表 + `task.handler_key` 索引）。
