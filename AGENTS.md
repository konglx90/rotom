# AGENTS.md

This file is the entry point for coding agents working in this repository. Keep it short and operational. 深背景在 `README.md`、`DESIGN.md` 和 `packages/website/docs/`。

## Project Overview

Rotom（仓库名 `a2a-gateway`）是一个**数字员工 Mesh** —— 默认形态是**个人 OPC**(每台机器一个 master + executor,开箱即用),可**联邦成团队**(多台机器协作)。

- **Master**(`src/master/`):每台机器一个,HTTP `/api` + WS `/ws` + `/federation` + 内嵌 Dashboard 都挂在 `:28800`,SQLite WAL 持久化。`mesh-master` 一命令启动 = 完整 OPC(master + 自动 spawn executor + 默认 agent + 默认 group)。
- **Executor**(`src/executor/`):由 master 自动 spawn 子进程(生命周期与 master 绑定),托管 N 个 Worker,**1 Worker = 1 Agent**。本机连接走 loopback 信任(**免 mesh_token**),跨机才需要 token。
- **rotom CLI**(`src/cli/rotom.ts`):所有数字员工行为的统一出口,借 Agent 身份调 REST。
- **Dashboard**(`packages/dashboard/`):React 18 + Vite SPA。`category=真人` 的 agent 不参与 Issue 抢单,仅作为人类参与者占位。

### OPC 模式(默认)

一台机器跑 `mesh-master` 即:
1. 生成 masterId(8 字符 base36,持久化在 `~/.rotom/master.json`,永远稳定)
2. 自动建默认 agent(用 `os.userInfo().username`)+ 默认 group "Local"
3. 自动 spawn 本机 executor 子进程
4. executor 扫描本机已装 CLI(claude/codex/hermes/openclaw/pi),每个 CLI 注册一个 agent(name 默认 = CLI 名)
5. 本机所有连接走 loopback 信任,**无需 mesh_token 配置**

### Federation 团队(可选叠加)

多台机器联邦成"团队"(星型拓扑):
- **协调 master**(`ROTOM_MASTER_ROLE=coordination`):接受 member 连接,维护成员目录,中转跨 master 消息
- **member master**(`ROTOM_MASTER_ROLE=member` + `~/.rotom/team.json`):主动 outbound 连协调,发布本地 agent 可见性
- **路由键** = `masterId + agent_name`(masterId 永远稳定,hostname/IP 变化不影响)
- **显示键** = `hostname + agent_name`(形如 `alice@hostA`)
- 数据归属:agent / memory / issue 始终留在本地 master;协调 master 只持有路由元信息

## Common Commands

```bash
pnpm install
pnpm build                       # tsc，外加拷贝 claude-code-hook.cjs 到 dist
pnpm build:master                # 同上 + 打包 dashboard SPA 到 dist/master/dashboard

# OPC 一命令启动(默认 standalone 模式,master + 自动 spawn executor)
pnpm start                       # = bash bin/rotom-up.sh start
pnpm start --dev                 # 同上 + Vite dev server (localhost:3000)
pnpm stop | restart | status | logs

# 协调 master(在某台稳定地址的机器上跑)
ROTOM_MASTER_ROLE=coordination ROTOM_TEAM_NAME="西花团队" pnpm start

# member master(接入协调)
# 先写 ~/.rotom/team.json:{"id":"<coordMasterId>","name":"...","coord_endpoints":["ws://coord-host:28800"]}
ROTOM_MASTER_ROLE=member ROTOM_TEAM_NAME="阿甘团队" pnpm start
# 或者用 dashboard「团队」页的「加入上级团队」表单(无需重启,runtime 切换)

pnpm master                      # 前台启动 Master(开发用)
pnpm master:start | stop | restart | status
pnpm executor                    # 前台跑 Executor(通常不需要,master 自动 spawn)
pnpm dashboard:dev               # Vite dev server
pnpm dashboard:build
pnpm test                        # node --import tsx --test tests/*.test.ts

# rotom CLI
rotom whoami
rotom directory --pretty
rotom group list | members | history | send
rotom issue create | list | show | events | comment | cancel | interrupt | continue | append
rotom schedule add | list | trigger | enable | disable
rotom memory add | search | list | get | promote | pending | approve | reject
rotom skill list | search | get | create | update | bind | mine
```

Master 默认监听 `0.0.0.0:28800`(`MESH_MASTER_PORT` 可覆盖);数据目录 `~/.rotom/`(`ROTOM_HOME` 覆盖);日志按日轮转 `~/.rotom/logs/mesh-master-YYYY-MM-DD.log`。

### 关键环境变量

| 变量 | 含义 |
|---|---|
| `ROTOM_HOME` | 数据目录(默认 `~/.rotom`) |
| `ROTOM_HOSTNAME` | 覆盖本机 hostname(联邦用,**禁止填 IP**) |
| `ROTOM_MASTER_ROLE` | `standalone`(默认)/ `coordination` / `member` |
| `ROTOM_TEAM_NAME` | 团队展示名(默认从本机真人 agent 派生,如"西花团队") |
| `ROTOM_COORD_ENDPOINTS` | member 模式:逗号分隔协调 master ws 地址 |
| `ROTOM_FEDERATION_DISABLED` | `=1` 强制关闭联邦(纯 standalone) |
| `MESH_MASTER_PORT` / `MESH_MASTER_HOST` | master 监听端口/地址 |

## Read These Docs

- `README.md`:架构图、特性、快速开始、REST API 总表、WS 协议、close codes
- `packages/website/docs/INSTALL.md`:Master / Executor / rotom CLI 三件套完整安装手册
- `packages/website/docs/AGENT_USER_GUIDE.md`:Agent 协作用户指南
- `packages/website/docs/AGENT_ASK_REPLY_TIMER.md`:A → B 提问的 5min timer + 升级 Issue 兜底
- `packages/website/docs/ASK_BRIDGE_GUIDE.md`:ask-bridge 创建 / 取消 / 升级路径
- `packages/website/docs/DEV_DELIVERY_WORKFLOW.md`:E2ED 端到端需求交付 pipeline
- `packages/website/docs/GROUP_CHAT_ARCHITECTURE.md`:群聊子系统、Router 决策、离线队列
- `packages/website/docs/GROUP_CHAT_RENDER_PERF.md`:群聊渲染性能调优记录
- `packages/website/docs/QUICK_REF.md`:任务 Issue / 群消息的两场景速查
- `DESIGN.md`:Dashboard 视觉系统(Wise 风格设计规范)
- `skill/rotom-a2a-communicate/SKILL.md`:注入到 agent 的协作 skill

## Runtime Summary

### OPC + 认证(Phase 1)

- **OPC bootstrap**(`src/master/opc-bootstrap.ts`):master 启动时 `getMasterIdentity()` 解析身份 → `runOpcBootstrap()` 写 `master_node` + 回填 `agents.hostname` + 建默认 agent/group → `ensureLocalExecutor()` spawn 本机 executor 子进程。
- **masterId**:8 字符 base36,持久化在 `~/.rotom/master.json`,永远稳定。hostname 仅作显示用(可改);路由用 masterId。
- **hostname 校验**(`src/master/federation/identity.ts`):启动时拒绝 IP 字面量(IPv4/IPv6),要求 `ROTOM_HOSTNAME` 设为稳定机器名(移动电脑 IP 会变)。
- **免 token 本机认证**(`src/master/auth.ts authenticateLocal` + `src/shared/network.ts isLoopback`):本机 IP(127.0.0.1 / ::1)的 WS 连接一律信任,agent 不存在则自动注册。**mesh_token 在新模型里不再需要**(老 token 保留向后兼容)。
- **CLI 自动注册**(`src/executor/index.ts scanClis`):executor 无 config 时扫描本机 claude/codex/hermes/openclaw/pi,每个 CLI 起一个 agent(name 默认 = CLI 名)。

### Federation 团队(Phase 2)

- **FederationManager**(`src/master/federation/manager.ts`):封装 fedClient/fedPublisher/fedServer 生命周期,支持 runtime join/leave(API `POST /api/teams/join` 无需重启)。
- **FedServer**(`src/master/federation/server.ts`):协调 master 端,挂 `/federation` WS 路径(noServer 模式,避免与 `/ws` 冲突),接受 member 连接 + 握手 + directory sync + 消息中转。
- **FedClient**(`src/master/federation/client.ts`):member master 主动 outbound 连协调,自动重连,握手成功后 publisher 发布本地 agent。
- **FedPublisher**(`src/master/federation/publisher.ts`):每 30s 全量发布本地 agent 到协调 master 的 `agent_visibility` 表。
- **Router.routeFederated**(`src/master/router.ts`):本机找不到 agent 时,查 `agent_visibility` 缓存 → 调 `fedClient.route()` 发 `FedRouteMessage` → 协调 master 中转到目标 member。
- **协议**(`src/shared/protocol/federation.ts`):8 个 FedMessage 类型(handshake/publish/unpublish/directory_sync/route/deliver/reply)。路由键 `teamId + masterId + agent_name`。

### 数据主路径(沿用)

- Worker WS → `src/master/ws-hub/connection.ts` 派发 → `src/master/ws-hub/{routing,conversation,sessions,directory}.ts` → SQLite → 推送给目标 client;离线收件人走 `src/master/offline-queue.ts`(100 条 / 24h TTL)。
- REST 路径:`src/master/api/index.ts` 用 `registerXxxRoutes()` 装载。鉴权 permissive —— 本机 IP 直通(loopback trust),远程走老 token 路径(向后兼容)。
- Worker 生命周期:`src/executor/index.ts` 启动 → 读 config(或 scanClis)→ 为每个 worker 拉起 `src/executor/worker.ts` → 通过 `src/executor/cli-executor.ts` 调度具体 backend。
- Issue 抢单 / 审批 / slash command / usage / todo / prompt 组合器 / session / ask-bridge / scheduler / patrol:详见 `README.md` 和 `packages/website/docs/`。

## Key Subsystems

| Subsystem | 入口文件 | 触发点 |
|---|---|---|
| **OPC bootstrap** | `src/master/opc-bootstrap.ts` + `src/master/federation/identity.ts` | master 启动 |
| **免 token 认证** | `src/master/auth.ts authenticateLocal` + `src/shared/network.ts isLoopback` + `src/master/ws-hub/connection.ts` | WS auth 阶段 |
| **CLI 自动注册** | `src/executor/index.ts scanClis + detectInstalledClis` | executor 无 config 启动 |
| **Federation 管理** | `src/master/federation/manager.ts` | master 启动 / API join/leave |
| Federation server | `src/master/federation/server.ts` | coordination role |
| Federation client | `src/master/federation/client.ts` | member role |
| Federation publisher | `src/master/federation/publisher.ts` | member 连上协调后 |
| Scheduler + Patrol | `src/master/scheduler.ts` + `scheduler-handlers.ts` + `patrol-terminal.ts` | 30s tick / issue 终态 |
| Ask-bridge | `src/master/db/ask-bridges.ts` + `scheduler-handlers.ts` | 群 @ + `#reply` / 5min 超时 |
| Memory & Skill | `src/master/api/{memory,skills}.ts` + `src/master/db/{memory,skills}.ts` | agent add / 群上下文 |
| Session | `src/executor/session-store.ts` + `src/master/db/agent-sessions.ts` | auth 后双向同步 |
| Issue approval | `src/shared/readonly-allowlist.ts` + `src/executor/cli-executor.ts` | cli hook / dashboard |
| Slash command | `src/shared/slash-commands.ts` | `rotom issue create --title "/plan ..."` |

## Core Files

| 文件 | 职责 |
|---|---|
| `src/master/server.ts` | Master 独立入口,OPC bootstrap + federation 启动 + ensureLocalExecutor |
| `src/master/embedded.ts` | Master 嵌入式入口(同步 OPC bootstrap) |
| `src/master/opc-bootstrap.ts` | OPC bootstrap:身份写入 + 默认 agent/group + spawn executor |
| `src/master/federation/identity.ts` | masterId 生成 + hostname 解析校验 + teamName 解析 |
| `src/master/federation/manager.ts` | FederationManager:runtime join/leave + 子系统编排 |
| `src/master/federation/server.ts` | 协调 master 的 FedServer(noServer 模式) |
| `src/master/federation/client.ts` | member master 的 FedClient(自动重连) |
| `src/master/federation/publisher.ts` | 发布本地 agent 到 agent_visibility |
| `src/master/auth.ts` | token + JWT + `authenticateLocal`(本机信任) |
| `src/master/router.ts` | 路由决策 + `routeFederated`(跨机) + `setFederation` 注入 |
| `src/master/api/index.ts` | REST 入口,`registerXxxRoutes()` 装载 |
| `src/master/api/teams.ts` | `/api/identity` + `/api/teams` + `/api/teams/:id/members` + `POST /teams/join` + `POST /teams/leave` |
| `src/master/db/index.ts` → `internal.ts` | DB facade + composition root |
| `src/master/db/master-node.ts` | master_node 表(本机身份) |
| `src/master/db/team.ts` | team + team_peers + human_membership |
| `src/master/db/agent-visibility.ts` | 跨 master 可见 agent 发布记录 |
| `src/master/ws-hub/{connection,routing,directory,sessions,conversation}.ts` | WS Hub 方法模块 |
| `src/executor/index.ts` | Executor 主进程,scanClis + loadConfig |
| `src/executor/worker.ts` + `worker-{connection,issue,chat}.ts` | Worker 抽象 + 子模块 |
| `src/executor/cli-executor.ts` | `CliExecutor` interface + 审批 |
| `src/executor/executors/{claude-code,codex,hermes-cli,openclaw,pi}.ts` | 后端适配 |
| `src/shared/protocol/federation.ts` | FedMessage schema(8 个消息类型) |
| `src/shared/protocol/{guards,client-messages,server-messages,types}.ts` | WS 协议 |
| `src/shared/network.ts` | `isLoopback` 工具(本机信任) |
| `src/shared/{constants,logger,dedup,time}.ts` | 基础工具 |
| `packages/dashboard/src/features/teams/TeamsView.tsx` | 团队页(加入/离开上级团队) |
| `packages/dashboard/src/features/agents/FederationBanner.tsx` | agents 页顶部联邦入口 banner |
| `packages/dashboard/src/features/agents/AgentTable.tsx` | 员工表(含 cliTool 列,无 token 列) |
| `bin/rotom-up.sh` | 一站式启停(只启 master,executor 由 master 自动 spawn) |
| `migrations/054-master-identity.sql` | master_node 表 |
| `migrations/055-agent-composite-key.sql` | agents (hostname, name) 复合索引 |
| `migrations/056-department.sql` → `058-team-rename.sql` | team + peers + agent_visibility + human_membership + 改名 department→team |

## Constraints

### OPC / 认证

- **mesh_token 在新模型里不再需要**:本机连接走 loopback trust(`isLoopback(remoteAddr)` → `authenticateLocal`)。老 token 路径保留向后兼容,但**不要**在新代码里要求 token 必填。
- **hostname 禁止 IP**:`ROTOM_HOSTNAME` 设为 IP 字面量会启动失败(移动电脑 IP 不稳定)。协调 master 必须用域名/mDNS/公网稳定地址;member 是 outbound 主动连接,移动电脑作 member 没问题。
- **masterId 是路由主键**:跨 master 路由用 `masterId + agent_name`,**不用 hostname**(hostname 可改,masterId 永远稳定)。`agent_visibility` PK 是 `(team_id, master_id, agent_name)`,不用 hostname。
- **OPC bootstrap 失败 = 启动失败**:hostname 校验、identity 解析失败时 master 直接 exit,不要 catch 后继续跑。

### Federation

- **星型拓扑(Phase 2)**:所有跨 master 消息经协调 master 中转。member↔member 直连留给 Phase 3。
- **协调 master 单点**:MVP 接受单点。member 检测协调断连 → 自动回落 standalone(本机 OPC 仍可用)。Phase 4+ 再支持协调集群。
- **FedServer 用 noServer 模式**:避免与 WSHub 的 `path: "/ws"` 冲突(ws 库的 `handleUpgrade` 在 path 不匹配时会 `abortHandshake(socket, 400)`)。FedServer 接管 httpServer 的 upgrade 事件,按 path 分发。
- **runtime join/leave**:API `POST /api/teams/join` 通过 `FederationManager.joinTeam()` 在进程内启动 fedClient/fedPublisher + 注入 Router,**无需重启 master**。
- **数据归属**:agent / memory / issue / session 始终留在本地 master。协调 master 只持有 `agent_visibility` 路由元信息。

### 仓库结构

- 仓库使用 **pnpm workspace**(`pnpm-workspace.yaml` 声明 `packages/*`)。不要用 `npm install` / `yarn install`。
- 顶层 `tsconfig.json` 显式 `exclude: ["packages"]`:根 `pnpm build` 不编译 dashboard,dashboard 由 `pnpm dashboard:build` 走 vite。**全量产物**用 `pnpm build:master`。
- `src/executor/claude-code-hook.cjs` 是 **CommonJS**,必须保留 `.cjs` 后缀;build script 显式 `cp` 到 `dist/executor/`。

### Migration

- 命名格式 `NNN-description.sql`,**追加**不改老;`migrations/003-schema-version.sql` 维护版本表。`MeshDb.migrate()` 自动扫 `./migrations/`。当前最新 `058-team-rename.sql`。
- migration 058 用 `ALTER TABLE RENAME` 在原表上改名(department→team),保留所有数据。不要写新 migration 重建这些表。

## High-Risk Gotchas

- **build 后要清理 dist 旧文件**:重命名文件后(db/department.ts → team.ts,api/departments.ts → teams.ts),dist 里旧 .js 还在,要 `rm dist/master/db/department.* dist/master/api/departments.*` 否则 server.js 可能引用旧路径。
- **FedServer 必须用 noServer 模式**:如果用 `WebSocketServer({ server, path: "/federation" })`,WSHub 的 wss(path=/ws)收到 `/federation` upgrade 会 `abortHandshake(400)`。借鉴 `src/master/terminal-hub.ts` 的 upgrade 接管 pattern。
- **publisher 要等握手成功才发**:`FedPublisher.start()` 后用 1s 轮询等 `client.isConnected()`,切到 30s 间隔。直接 start 后立即 `publishAll()` 会因 handshake 未完成而 skip。
- **OPC bootstrap 的 ensureLocalExecutor 只在 defaultAgent 存在时调**:用户已有 agents 时 `opcResult.defaultAgent` 是 undefined,但 `ensureLocalExecutor` 仍要调(用 `opcResult.defaultAgent?.name`)。否则用户已有 agent 时 executor 不会 spawn。
- **token 字段类型松绑**:`ClientAuthMessage.token` 改为 `string | undefined`,`isClientMessage` guard 允许 token 为空。否则 executor 发空 token 会被 guard 拒绝 → 4400 close。
- **CLI scanClis 模式的 worker name = CLI 名**:executor 无 config 时,worker.name = "claude"/"codex"/... 而非用户起的中文名。要让用户中文名生效,需配 `~/.rotom/executor.config.json`(master 自动 spawn 时用它)。
- 旧 9 条 + 7 条(详见 git history):build script 不能丢 cp、token migration 016 明文、postSystemToGroup sender 字面量 "system"、写盘必须挂 issue、rotom CLI 身份解析顺序、WS 心跳 10s/90s、dashboard build 路径、pnpm executor tsx 直跑、native 模块版本。

## Do Not Revisit

- 不要恢复 mesh_token 必填(OPC 模式本机信任,免 token 是核心特性)。
- 不要把"团队"(federation team)和"分组"(老 Domain)混淆:team = 跨机协作;Domain = 本机内分组(UI 已改"分组",DB 表名 domains 保留)。
- 不要把 Dashboard 重新写成 Vue。已经是 React 18 + Vite。
- 不要把私聊(`direct` a2a 通道)加回来。所有点对点交流走 `rotom group send`。
- 不要在 worker 侧复活 `~/.rotom/sessions.json` 落盘(已迁 master DB)。
- 不要在 CLI 加 `--from` 旋钮(身份伪造风险)。
- 不要用 IP 做 master 标识(移动电脑 IP 会变,用 hostname/masterId)。
