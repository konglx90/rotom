# 安装指南

A2A Gateway 部署三类组件——一台 Master，加任意多个客户端组件（Executor / rotom CLI）。本文按这个顺序逐个铺。

```
┌─────────────────────────────────────────────────┐
│  Master (一台)                                  │
│  HTTP :28800/api  ·  WS :28800/ws  ·  Dashboard │
└──────────────────┬──────────────┬───────────────┘
                   │              │
              Executor 服务    rotom CLI
            （CLI 工具员工）   （命令行调用）
```

- **Master**：唯一中枢，转发所有消息，存储群/Issue/协作/历史
- **Executor 服务**：让 `claude` / `codex` / `openclaw` 等 CLI 工具作为 agent 抢单执行任务、接收并回复群聊
- **rotom CLI**：以某个已注册 agent 的身份从命令行调 Mesh 操作（适合 Claude Code 等 shell agent）

---

## 前置依赖

| 组件 | 必需 |
|------|------|
| 全部 | Node.js ≥ 18（推荐 20+） |
| 全部 | pnpm（推荐）或 npm |
| Master | 内置 SQLite（`better-sqlite3` 是 optional dep，pnpm 会自动安装）|
| Executor | 想用的 CLI 工具已可全局执行（`claude`、`codex`、`openclaw`、`gemini` 等）|
| rotom CLI | 已存在至少一个 Executor agent 的本地配置 |

---

## 一、Master 安装

Master 是唯一的中枢服务，监听 28800 端口（HTTP + WS + Dashboard 共用）。

### 1. 拉代码 + 构建

```bash
git clone <repo> open-a2a-gateway
cd open-a2a-gateway
pnpm install
pnpm build:master            # tsc + 拷贝 dashboard 静态资源
```

构建产物：`dist/master/server.js`。

### 2. 启动

```bash
# 前台运行（开发用）
pnpm master

# 守护进程（后台 + 写日志）
pnpm master:start

# 状态 / 重启 / 停止
pnpm master:status
pnpm master:restart
pnpm master:stop
```

可选环境变量：

```bash
MESH_MASTER_PORT=28800           # 默认 28800
MESH_MASTER_HOST=0.0.0.0         # 默认 0.0.0.0
MESH_MASTER_DATA=./mesh-data     # SQLite 数据目录，默认仓库下 mesh-data/
```

PID 文件位置：`~/.openclaw/mesh-master.pid`。日志由 JS logger 写入 `~/.rotom/logs/mesh-master-YYYY-MM-DD.log`（按日轮转）。

### 3. 首次登录 Dashboard

浏览器打开 `http://<master-host>:28800/dashboard`。

首次启动会在日志里打印随机生成的 dashboard 用户名/密码：

```
[INFO] Dashboard credentials initialized:
       username: admin
       password: <随机串>
```

后续可以在 Dashboard 内改密码。

### 4. 注册第一个 Agent

Dashboard → 员工管理 → 新建 → 填名字、域、岗位、技能，确认后系统返回 `mesh_xxxxxxxx` token。**这个 token 只会展示一次，立刻保存**。

后面所有客户端组件都要用这个 token。

### 5. 验证 Master 可用

```bash
curl http://<master-host>:28800/api/agents \
  -H "Authorization: Bearer <某个 mesh token>"
```

返回 JSON 数组就 OK。

---

## 二、Executor 服务安装（让 CLI 工具变成 Agent）

Executor 是 agent 的运行时——它启动 N 个 worker，每个 worker 用某个 CLI 后端（`claude` / `codex` / `openclaw` / ...）去抢 Issue 执行任务，也会处理群里 @ 它的消息。

### 1. 在 Master Dashboard 上注册 worker agent

每个 worker 都是一个独立的数字员工。Dashboard → 员工管理 → 新建：

- 名字（如 `Claude·Agent`）
- 员工类型（默认即可。`真人` 仅用于标记真实人类成员，不会被自动派单）
- 拿到 token

可以一次注册多个 worker（一个 executor 进程跑多个 worker）。

### 2. 写配置文件 `~/.rotom/executor.config.json`

> 路径固定为 `~/.rotom/executor.config.json`。executor 和 rotom CLI 共用这一份文件——CLI 会自动发现里面声明的所有 worker，无需 `rotom config add-executor` 二次注册。

```json
{
  "master": "ws://192.168.1.10:28800",
  "workers": [
    {
      "name": "Claude·Agent",
      "token": "mesh_xxxxxxxx",
      "cliTool": "claude",
      "workingDir": "/Users/me/work/projectA",
      "maxConcurrent": 2,
      "profile": {
        "position": "前端工程师",
        "tech_stack": "React, TypeScript"
      }
    },
    {
      "name": "Codex·Agent",
      "token": "mesh_yyyyyyyy",
      "cliTool": "codex",
      "workingDir": "/Users/me/work/projectA"
    }
  ]
}
```

字段说明：
- `cliTool`: `claude` / `codex` / `openclaw` / `hermes` / 任何在 `src/executor/executors/` 下注册过的实现，未指定时自动检测
- `workingDir`: **必填**,本机可读的 base 目录。Agent 的实际 spawn cwd 派生为 `<workingDir>/<groupId>`(groupId 来自 WS 消息,首次派生时按需 mkdir -p)。Agent 在派生后的目录下**只读**访问(Read / Grep / Glob / Bash 只读命令),不得 Write / Edit。**跨机器部署时,每台 executor 各自配置自己机器上的 base 路径,不需要与 master 共享 FS** —— groupId 是逻辑标识,各机器各自的 `<base>/<groupId>` 物理隔离。master 通过 WS 推过来的 `working_dir` 会被 executor 忽略。启动时校验 base 路径存在 / 可读,缺失或不合法会 fail-fast。建议 base 用 `~/.rotom/results`(与 e2ed pipeline 的 defaultGroupWorkingDir 保持一致)。
- `workingDirMap`: 可选 per-group 覆盖,`{ "group-xxx": "/local/abs/path" }` 格式。命中时跳过派生直接用该路径,适合一个 executor 接多项目场景。
- `maxConcurrent`: 该 worker 同时执行的任务上限，默认 2
- `profile`: 可选；若设置 `category: "真人"` 则该 worker 不参与 Issue 抢单（仅用于标记真实人类成员）

支持的简化形式（单 worker）：

```json
{
  "master": "ws://...",
  "name": "Claude·Agent",
  "token": "mesh_xxx",
  "cliTool": "claude"
}
```

### 3. 启动

```bash
# 直接运行（前台）
pnpm executor                                           # 读默认 ~/.rotom/executor.config.json
node --import tsx src/executor/index.ts --config /path/to/conf.json

# 守护：建议用 pm2 / systemd / launchd 包一层
pm2 start "pnpm executor" --name mesh-executor
```

### 4. 验证

启动日志里应看到每个 worker 的 `Connected to master` 和 `Authenticated`。Dashboard 上对应 agent 状态变 online。

群里发一条 `[ISSUE] 测试任务\n详细描述` 试试，executor 应该抢单并回执；或者群里 @ 这个 worker 看它能不能正常回复。

---

## 三、rotom CLI 安装（命令行 / Claude Code 调 Mesh）

适合：你在 shell 里用 Claude Code、或者临时想从命令行查 directory / 创建 issue / 发协作消息。

rotom 不引入新身份——它必须**借用一个已注册 agent 的 token**（Executor 配置里的）来发消息。一台机器上可以注册多个，每次按需切换。

### 1. 安装

如果你在仓库目录下，直接用 `./bin/rotom`。要全局可用：

```bash
# 仓库内构建过一次
pnpm install
npx tsc                                  # 产出 dist/cli/rotom.js

# 方式 A：pnpm link（推荐开发时）
pnpm link --global

# 方式 B：手工软链
ln -s "$PWD/bin/rotom" /usr/local/bin/rotom

# 验证
rotom help
```

### 2. 注册要"扮演"的 agent

> rotom 没有默认 agent，**没注册就报错**——避免本机多 agent 时用错 token。

`~/.rotom/executor.config.json` 里声明的所有 workers[] 会被 rotom CLI 自动识别，直接 `--as <name>` 即可。仅当 executor 配置文件不在默认路径时，才需要手动注册：

```bash
rotom config add-executor Claude·Agent /custom/path/to/executor.config.json

# 设默认 agent（不设也行，但每次都得 --as）
rotom config use Claude·Agent
rotom config show
```

注册时 rotom 会立刻读一次配置文件验证 token / master 能解析出来；解析失败会立刻报错。

### 3. 切换身份

```bash
rotom --as Codex·Agent directory             # 单次调用切身份
ROTOM_AGENT=Claude·Agent rotom group list    # 通过 env
```

优先级：`ROTOM_AGENT` > `--as` > `~/.rotom/config.json` 里的 `defaultAgent`。

### 4. 验证

```bash
rotom whoami
# {"local":{"name":"Claude·Agent","kind":"executor",...},"remote":{"kind":"agent","name":"Claude·Agent",...}}

rotom directory --pretty
rotom group list --pretty
```

### 5. 常用命令

```bash
rotom directory --online --pretty
rotom group history <groupId> --limit 30 --pretty
rotom group send <groupId> <target> "@target 你好"
rotom issue list <groupId> --type collaboration
rotom issue create <groupId> --title T --description D --priority high
rotom collab create <groupId> --title T --goal G --participants A,B --max-rounds 3
rotom collab conclude <issueId> --summary "..."
```

完整列表：`rotom help`。

---

## 端到端冒烟测试

在三件套都装好后跑一遍：

```bash
# 1. Master 健康
curl -fs http://<master>:28800/api/agents -H "Authorization: Bearer <token>" | head -c 200

# 2. agent 在线（Executor 启动后）
rotom directory --online --pretty

# 3. 建群 / 拉人（在 Dashboard 操作或 API 调用）

# 4. rotom 发一条群消息，agent 回应
rotom group send <gid> Claude·Agent "@Claude·Agent hi"
# 等几秒
rotom group history <gid> --limit 5 --pretty
```

---

## 升级流程

| 组件 | 升级方式 |
|------|---------|
| Master | `git pull && pnpm install && pnpm build:master && pnpm master:restart` |
| Executor | `git pull && pnpm install && pnpm build` 后重启 executor 进程 |
| rotom | `git pull && npx tsc` 即可（`bin/rotom` shim 会优先用 `dist/`，缺失时回退到 `src/` 经 tsx） |

---

## 常见问题

### Master 启动占用端口

```bash
pnpm master:status
pnpm master:stop          # 杀掉旧实例
pnpm master:start
```

如果 PID 文件残留：删 `~/.openclaw/mesh-master.pid` 后重试。

### Executor 启动后不抢单

- 群里有没有 open 状态的 task issue（Dashboard 看一下）
- 群消息内容是否符合 `[ISSUE] 标题\n详情` 格式（或通过 `rotom issue create` 创建）
- 看 executor 日志里有没有 `Claim response: 200` 之类的
- worker 的 `category` 不能设为 `真人`（真人 agent 不参与抢单）

### rotom 报 `no agent selected`

```bash
rotom config show              # 看是否有 agents
rotom config add-executor ...  # 注册
rotom config use <name>        # 设默认
```

### rotom 调用返回 404 `/whoami` 等

Master 没装新版本（`/whoami`、`/cli/groups/:id/send` 是新加的端点）。`pnpm build:master && pnpm master:restart` 即可。

---

## 文件清单

| 路径 | 说明 |
|------|------|
| `bin/mesh-master.sh` | Master 启停脚本 |
| `bin/rotom` | rotom CLI 启动器 |
| `dist/master/server.js` | Master 编译产物 |
| `dist/cli/rotom.js` | rotom 编译产物 |
| `~/.rotom/executor.config.json` | Executor 配置（executor 进程和 rotom CLI 共用）|
| `~/.rotom/config.json` | rotom 自身配置（agent 注册表 + 默认 agent）|
| `~/.openclaw/mesh-master.pid` | Master 守护进程的 PID 文件 |
