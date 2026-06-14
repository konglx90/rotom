# AGENTS.md

This file is the entry point for coding agents working in this repository. Keep it short and operational. 深背景在 `README.md`、`DESIGN.md` 和 `docs/`。

## Project Overview

Rotom（仓库名 `a2a-gateway`）是一个**数字员工 Mesh** —— 一个中心化的 agent 协作网络。三个独立组件：

- **Master**（`src/master/`）：唯一中枢服务，HTTP `/api` + WS `/ws` + 内置 Vue Dashboard 都挂在 `:28800`，用 SQLite WAL 持久化群 / Issue / 协作 / 消息日志。
- **Executor**（`src/executor/`）：长连接守护进程，单进程托管 N 个 Worker，**1 Worker = 1 Agent**。Worker 持 mesh token 与 Master 维持 WS（接 Issue / 推送），并 spawn 对应 CLI 进程（claude / codex / openclaw / hermes / gemini / generic）作为 Agent。
- **rotom CLI**（`src/cli/rotom.ts`）：所有数字员工行为的统一出口，借 Agent token 调 REST。既被 Agent 在容器内通过 Bash 调用（加载 `skill/rotom-a2a-communicate`），也能由真人 / Claude Code 在 shell 里手动用。

Agent 不直连 Master，所有 agent-to-agent 通讯都经 Master 中转，没有点对点连接。Dashboard 是真人渠道（`category=真人` 的 agent 不参与 Issue 抢单）。

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

pnpm executor                    # 前台跑 Executor（tsx 直跑 TS 源码）

pnpm dashboard:dev               # Vite dev server（仅 dashboard）
pnpm dashboard:build
pnpm dashboard:preview

pnpm test                        # node --import tsx --test tests/*.test.ts

# rotom CLI（构建后软链到 PATH）
pnpm build && ln -s "$PWD/bin/rotom" /usr/local/bin/rotom
rotom whoami
rotom directory --pretty
rotom group list --pretty
rotom issue create <groupId> --title "..." --description "..."
```

Master 默认监听 `0.0.0.0:28800`；PID / 日志固定在 `~/.openclaw/mesh-master.{pid,log}`。SQLite 数据目录默认 `./mesh-data/`。

## Read These Docs

- `README.md`：架构图、特性、快速开始、REST API 总表、WS 协议、close codes
- `docs/INSTALL.md`：Master / Executor / rotom CLI 三件套完整安装手册
- `docs/AGENT_USER_GUIDE.md`：Agent 协作用户指南
- `docs/AGENT_COLLABORATION_GUIDE.md`：系统通知 vs Agent 聊天的发送链区分、协作流程
- `docs/GROUP_CHAT_ARCHITECTURE.md`：群聊子系统、Router 决策、离线队列、WS 协议 7+9 消息类型
- `docs/QUICK_REF.md`：任务 Issue / 协作 Issue / 群消息的三场景速查
- `DESIGN.md`：Dashboard 视觉系统（Wise 风格设计规范）
- `skill/rotom-a2a-communicate/SKILL.md`：注入到 agent 的协作 skill —— 行动判定四象限、Issue 类型决策、写盘必须挂 issue 的硬规则

## Runtime Summary

- 数据主路径：Worker WS → `src/master/ws-hub.ts` → `src/master/router.ts` → SQLite（`src/master/db.ts`）→ 推送给目标 client；离线收件人走 `src/master/offline-queue.ts`（100 条 / 24h TTL）。
- REST 路径：所有 `/api/*` 端点集中在 `src/master/api.ts`，鉴权走 `src/master/auth.ts`（token sha256 + JWT 双重）；Dashboard 用 cookie session，CLI 用 `Authorization: Bearer mesh_xxx`。
- Worker 生命周期：`src/executor/index.ts` 启动 → 读 `~/.rotom/executor.config.json` → 为每个 worker 拉起 `src/executor/worker.ts` → 通过 `src/executor/cli-executor.ts` 调度具体 backend（`src/executor/executors/*.ts`）。
- Issue 抢单：按身份分组，`Agent` 类参与抢单，`真人` 不参与；并发上限 `maxConcurrent`（默认 2）。Issue 进度 / 输出 / 产物实时回传 Master。
- rotom CLI 身份解析顺序：`ROTOM_AGENT` env > `--as <name>` > `~/.rotom/config.json#defaultAgent`；自动发现 `~/.rotom/executor.config.json` 里的所有 worker，免二次注册。
- WS 心跳：10s 间隔 / 90s 超时；重连时 Master 自动下发离线消息；`requestId` 关联请求与回复。
- 限流：默认 60 msg/min/agent；消息去重走 `src/shared/dedup.ts`；审计日志最大 500 条（`/api/audit`）。
- Dashboard SPA：`packages/dashboard`（React 18 + Vite + react-router 6 + monaco + xterm），build 产物拷到 `dist/master/dashboard/` 由 Master 同源 serve。
- Claude Code 钩子：`src/executor/claude-code-hook.cjs` 是 `.cjs`，需要 `pnpm build` 时显式拷贝到 `dist/executor/`（已写在 build script 里）。

## Core Files

| File | Responsibility |
|------|------|
| `src/master/server.ts` | Master 独立入口，监听 28800，serves Dashboard + WS + REST |
| `src/master/embedded.ts` | Master 的可嵌入版本（同进程使用） |
| `src/master/api.ts` | 全部 REST 端点：agents / domains / groups / messages / issues / artifacts / audit / stats |
| `src/master/ws-hub.ts` | WebSocket Hub：连接管理、auth、心跳、a2a_send / reply 中转、`postSystemToGroup` 系统通知 |
| `src/master/router.ts` | 路由决策（按 target 名 / 域 / 跨域规则） |
| `src/master/auth.ts` | token sha256 + JWT 校验 |
| `src/master/db.ts` | SQLite 数据层（WAL），群 / 成员 / 消息 / Issue / artifacts |
| `src/master/offline-queue.ts` | 离线消息暂存（100 条 / 24h TTL） |
| `src/master/group-paths.ts` | 群对应工作目录 / artifact 路径解析 |
| `src/master/terminal-hub.ts` | Dashboard 内嵌终端的 WS / xterm 桥 |
| `src/executor/index.ts` | Executor 主进程入口，读配置 + 拉起 N 个 worker |
| `src/executor/worker.ts` | Worker 抽象：WS 连接、心跳、抢单、状态上报、output / artifact 回传 |
| `src/executor/cli-executor.ts` | CLI 后端的通用执行框架（spawn / 收 stdout / 完成判定） |
| `src/executor/claude-code-hook.cjs` | Claude Code 的 SessionStart / 输出追踪钩子（CommonJS，需要随 build 拷贝） |
| `src/executor/executors/*.ts` | 后端适配：claude-code / codex / hermes-cli / openclaw / generic-cli |
| `src/cli/rotom.ts` | rotom CLI 入口：身份解析 + 全部子命令调度 |
| `src/shared/protocol.ts` | WS 消息类型定义（7 client→master + 9 master→client） |
| `src/shared/constants.ts` | 全局常量（端口、心跳、限流） |
| `src/shared/dedup.ts` | 消息去重 |
| `src/shared/group-context.ts` | 群上下文工具（注入 `[群消息 context: ...]` / `[当前群活跃 issue]` prompt 段） |
| `src/shared/slash-commands.ts` | 斜杠命令协议（issue approval policy） |
| `src/shared/logger.ts` | 统一日志 |
| `packages/dashboard/src/` | Vue ~~~~ 实为 React 18 + Vite + xterm + monaco 的 SPA；按 features 拆分（agents / chat / groups / kanban / messages） |
| `bin/mesh-master.sh` | Master 启停脚本（start / stop / restart / status / install-service） |
| `bin/rotom` | rotom CLI launcher：prefers `dist/cli/rotom.js`，无 dist 时回退到 `tsx src/cli/rotom.ts` |
| `bin/rotom-send-with-status` | rotom 带状态发消息辅助脚本 |
| `migrations/*.sql` | SQLite schema migrations（001~017，覆盖 init / message log / agent profile / issues / collaboration / groups working-dir / approval-policy / token-plaintext / groups-pinned） |
| `skill/rotom-a2a-communicate/SKILL.md` | 注入 Agent 的协作 skill：行动判定、写盘必须挂 issue 的硬规则 |
| `scripts/fix-node-pty-perms.mjs` | postinstall：修 node-pty 权限 |
| `scripts/clear-legacy-category.mjs` | 一次性数据清理脚本 |

## Constraints

- 仓库使用 **pnpm workspace**（`pnpm-workspace.yaml` 声明 `packages/*`）。不要用 `npm install` / `yarn install`，会破坏 workspace symlink 和 onlyBuiltDependencies 白名单。
- 顶层 `tsconfig.json` 显式 `exclude: ["packages"]`：根 `pnpm build` 不会编译 dashboard，dashboard 由 `pnpm dashboard:build` 独立走 vite。要打全量产物用 `pnpm build:master`。
- `src/executor/claude-code-hook.cjs` 是 **CommonJS**（与项目 `"type": "module"` 相反），必须保留 `.cjs` 后缀；build script 显式 `cp` 到 `dist/executor/`，不能改成全自动 tsc 输出。
- Master 端口范围固定 `:28800`（`MESH_MASTER_PORT` 可覆盖）；PID / 日志固定写 `~/.openclaw/mesh-master.{pid,log}` —— 不要改路径，`bin/mesh-master.sh` 和外部监控脚本依赖这个约定。
- Agent token 是 `mesh_` 前缀的明文（migration 016 把它从 hash-only 改回 plaintext，方便 Dashboard 取回展示）；存储层留意不要再退回成 hash-only。
- **rotom CLI 永远不接受 `--from`**：身份由 token 推断（`ROTOM_AGENT` env > `--as` > 默认 agent），不要新增 CLI flag 覆盖发送者身份，避免身份伪造。
- 系统通知必须走 `ws-hub.postSystemToGroup()`，sender 固定 `"system"`；Agent 之间正常对话走 `sendAsAgent()`。两条链路不要混用 —— `docs/AGENT_COLLABORATION_GUIDE.md` 有完整规范。
- 写盘必须挂 issue（skill 里的硬规则）：当你作为被 spawn 的 agent 在群里被 @ 时，没 `in_progress` issue 就只能 Read / Grep / Glob；遇到改动诉求先 `rotom issue create` 或提示发起方建。这条约束写在 `skill/rotom-a2a-communicate/SKILL.md` 里，**对运行中的数字员工生效**，与 Claude Code 本身的行为约束分开。
- 私聊功能已下线，所有 a2a 通信走群聊（`rotom group send`）。不要在 protocol / API / CLI 里复活 `direct` 通道。
- `category=真人` 的 agent 不参与 Issue 抢单（只作人类参与者占位）；改抢单逻辑（`src/master/router.ts`、`src/executor/worker.ts`）时要保留这条过滤。
- SQLite 数据库走 WAL；新增 migration 文件命名格式 `NNN-description.sql`，必须**追加**而不能改老文件；`migrations/003-schema-version.sql` 维护版本表。
- WS close codes 是协议契约：`4001 Auth timeout` / `4002 Auth failed` / `4400 Invalid JSON` / `4401 Not auth` / `4429 Rate limited`。改这些会让所有 client 误判，不要轻易动。
- Dashboard 是 React 18 + Vite（不是 Vue —— 早期文档把它写成 Vue 是历史遗留）；UI 视觉规范在 `DESIGN.md`（Wise 风格）。
- `better-sqlite3` 和 `node-pty` 是 `optionalDependencies` + `pnpm.onlyBuiltDependencies` 白名单；postinstall 会自动跑 `scripts/fix-node-pty-perms.mjs` 修 mac 上的执行位。新增 native dep 要走相同路径，不要默默加到普通 dependencies。

## Testing

- 自动化测试使用 Node 内置 test runner + tsx：`pnpm test` → `node --import tsx --test tests/*.test.ts`。
- 目前 `tests/` 只有 `master-agent.test.ts`，覆盖 Master + Agent 注册 / WS / 路由的最小回路。新增 Master 端 API / Router / Hub / DB 逻辑时优先扩这个文件或拆同级文件。
- Executor 后端、rotom CLI 子命令、Dashboard SPA 目前没有自动化测试；改动它们要走手动回路：起 Master → 起 Executor → 在 Dashboard / CLI 上跑一遍 issue create / claim / complete。
- SQLite migration 改动请用一个新的空 `mesh-data/` 目录跑一次冷启动，确认 `migrate.up()` 序列无报错。
- WS 协议改动需要同时检查 `src/shared/protocol.ts`、`ws-hub.ts` 的 server 解析、所有 client（executor worker / dashboard / cli）的发送和接收 —— 漏改任何一端都会导致 4400 / 4401。

## High-Risk Gotchas

- **build script 不能丢 `cp src/executor/claude-code-hook.cjs ...`**：丢了 Claude Code agent 启动时找不到钩子文件，但 tsc 不会报错。
- **token migration 016 之后是明文存储**：写新代码时不要看到 `token_hash` 字段就当成只读 hash，Dashboard 需要把明文 token 回显给用户复制。
- **`postSystemToGroup` 的 sender 必须是字面量 `"system"`**：Dashboard / CLI 渲染端会根据这个字符串切样式，写成 `System` / `SYSTEM` / 真实 agent 名都会破样式。
- **写盘必须挂 issue 是 skill 层硬规则**：改 `src/shared/group-context.ts` 注入的 `[当前群活跃 issue]` prompt 段时要确认仍包含 issue id + state + cwd，否则 agent 端的自检会失败、跳过写盘或乱写。
- **rotom CLI 身份解析顺序不可调换**：`ROTOM_AGENT` env 必须最高优先，因为 executor spawn agent 子进程时是通过 env 注入身份的；调换会让 worker 之间互相串身份。
- **WS 心跳 10s/90s 是和 Worker 重连 / 离线队列联动的**：心跳过短会触发离线队列堆积，过长会让 directory_update 卡延迟。改 `src/shared/constants.ts` 里的心跳间隔时记得同步更新 Worker 的 `activeDispatches` 上报节奏。
- **Dashboard build 输出在 `packages/dashboard/dist/src/master/dashboard/`**，build:master 才会再 cp 到 `dist/master/dashboard/`。本地直接跑 `pnpm dashboard:build` 不会让 Master 看到新前端，要再跑 `pnpm build:master` 或手动 cp。
- **`pnpm executor` 是 tsx 直跑 TS 源**：改 `src/executor/*.ts` 不用重新 build，但改 `src/shared/*.ts` 后如果你同时跑着 master（dist 模式），shared 在两边是两份编译产物，行为可能不一致 —— 排错先看是不是这个。
- **node-pty / better-sqlite3 是 native 模块**：Node 版本切换 / Electron 嵌入时要重新 build，否则启动报 NODE_MODULE_VERSION 不匹配。Master 启动失败时优先怀疑 native dep。

## Do Not Revisit

- 不要把私聊（`direct` a2a 通道）加回来。曾经做过、删掉是有意为之 —— 它和群上下文 / 离线队列 / 审计 / 协作 issue 是冲突的设计。所有点对点交流走 `rotom group send <groupId> <target> ...`，由 Master 落库。
- 不要尝试把 Dashboard 重新写成 Vue。包名里的 `Vue` / 早期文档措辞是历史遗留，技术栈已经是 React 18 + Vite，迁移过一次没有收益。
