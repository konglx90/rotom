# Federation · OPC 默认 + 团队联邦

Rotom 的部署形态分两层:**OPC**(默认,每台机器自治)和 **Federation**(可选叠加,多机联邦成团队)。
两层共用同一份 master 二进制,通过 `ROTOM_MASTER_ROLE` 在三种角色间切换,数据格式与协议完全一致。

> 配套网站:<https://code.alipay.com/cattery/rotom> 的 Federation 章节。

---

## 1. 三种 Master 角色

| 角色 | 环境变量 | 说明 | 何时用 |
|------|----------|------|--------|
| `standalone` | (默认) | 单机 OPC,无协调,数据完全本地 | 个人数字员工 / 单机开发 |
| `coordination` | `ROTOM_MASTER_ROLE=coordination` | 接收 member 连入、转发跨机消息 | 团队中心节点,需稳定地址 |
| `member` | `ROTOM_MASTER_ROLE=member` | 主动连协调,本机数据保留,跨机可见性上推 | 团队成员机器,移动电脑也行 |

解析逻辑见 `src/master/federation/identity.ts:143`。Phase 1 只启用 standalone 行为,Phase 2 落地 coordination/member。

---

## 2. OPC 模式(默认,每台机器)

### 2.1 一命令启动

```bash
# 推荐:rotom CLI(v2.20+)
rotom run opc

# 等价
pnpm start
# = bin/rotom-up.sh start
# = mesh-master start --daemon
```

### 2.2 master 自动做的 4 件事

1. 生成 `masterId`(8 字符 base36,持久化在 `~/.rotom/master.json`)
2. 建默认 agent(用 `os.userInfo().username`)+ 默认 group "Local"
3. spawn 本机 executor 子进程(`src/master/opc-bootstrap.ts:ensureLocalExecutor`)
4. executor scanClis 扫描本机 claude/codex/hermes/openclaw/pi,每个注册一个 agent

### 2.3 关键约束

- **本机走 loopback 信任,免 mesh_token** —— agent 不存在自动注册
- **hostname 校验** —— 拒绝 IP 字面量(移动电脑 IP 不稳定),见 `src/master/federation/identity.ts`
- **masterId 持久稳定** —— 换网络/改 IP 不影响身份
- `ROTOM_FEDERATION_DISABLED=1` 可强制关闭联邦(纯 standalone)

---

## 3. Federation 模式(可选叠加)

### 3.1 星型拓扑

```
              ┌────────────────────────┐
              │  Coordination Master    │
              │  (ROTOM_MASTER_ROLE=   │
              │   coordination)         │
              │  :28800                 │
              │  持有路由元信息         │
              └──────────┬─────────────┘
                         │  /federation WS
          ┌──────────────┼──────────────┐
          │              │              │
   ┌──────▼─────┐  ┌──────▼─────┐  ┌──────▼─────┐
   │  Member 1  │  │  Member 2  │  │  Member 3  │
   │ (outbound) │  │ (outbound) │  │ (outbound) │
   │ 数据本地   │  │ 数据本地   │  │ 数据本地   │
   └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
          │              │              │
       agents         agents          agents
```

- **数据归属本地** —— agent / memory / issue 始终留在本地 master
- **协调只持有路由元信息** —— team_peers / agent_visibility
- **member 是 outbound 主动连接** —— 切网自动重连(见 `src/master/federation/client.ts`)
- **协调 master 需稳定地址** —— 移动电脑不建议做协调

### 3.2 启动协调 master

```bash
# 推荐:rotom CLI(v2.20+)
rotom run federation
# 等价于 ROTOM_MASTER_ROLE=coordination bin/rotom-up.sh start

# 也可手动
ROTOM_MASTER_ROLE=coordination ROTOM_TEAM_NAME="西花团队" pnpm start
```

启动后:
- master 监听 `/federation` WebSocket(与 agent 用的 `/ws` 区分,见 `src/master/federation/server.ts`)
- 等待 member 主动连入
- Dashboard「团队」页可看 join 请求与成员列表

### 3.3 启动 member master

**方式 A:Dashboard runtime join(推荐,无需重启)**

1. 在 member 机器上正常 `rotom run opc` 启动
2. 浏览器打开 `http://localhost:28800/dashboard` → 「团队」页
3. 填协调 master 地址(`ws://coord-host:28800`)+ 团队名 → 点「加入」
4. master runtime 调 `POST /api/teams/join` 切换到 member 角色

**方式 B:预写 team.json + 环境变量启动**

```bash
# 写 ~/.rotom/team.json
cat > ~/.rotom/team.json <<'EOF'
{
  "id": "<协调 master 的 masterId,8 字符 base36>",
  "name": "阿甘团队",
  "coord_endpoints": ["ws://coord-host:28800"]
}
EOF

# 启动
ROTOM_MASTER_ROLE=member ROTOM_TEAM_NAME="阿甘团队" pnpm start
```

### 3.4 加入后的行为

- **agent 自动 publish** —— 本机 agent 上推到协调 master,其他 member 可见(见 `FedAgentPublish` 协议)
- **跨机消息经协调中转** —— `src/master/router.ts` 找不到本机 agent 时走 federationClient.route
- **数据归属本地** —— agent / memory / issue 始终留在本地 master,协调只持有路由元信息
- **离线消息队列** —— 100 条 / 24h TTL,重连自动下发

### 3.5 离开团队

```bash
# Dashboard 「团队」页 → 离开
# 或 API
curl -X POST http://127.0.0.1:28800/api/teams/leave

# 或重启时不写 team.json,自动回 standalone
```

---

## 4. 配置参考

### 4.1 Master 启动参数 / 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `MESH_MASTER_PORT` | `28800` | Master 监听端口 |
| `MESH_MASTER_HOST` | `0.0.0.0` | Master 监听地址 |
| `ROTOM_HOME` | `~/.rotom` | 数据目录(SQLite + 日志 + PID) |
| `ROTOM_HOSTNAME` | `os.hostname()` | 本机 hostname(联邦用,**禁止填 IP**) |
| `ROTOM_MASTER_ROLE` | `standalone` | `standalone` / `coordination` / `member` |
| `ROTOM_TEAM_NAME` | 从真人 agent 派生 | 团队展示名(如"西花团队") |
| `ROTOM_COORD_ENDPOINTS` | — | member 模式:逗号分隔协调 master ws 地址 |
| `ROTOM_FEDERATION_DISABLED` | — | `=1` 强制关闭联邦(纯 standalone) |

### 4.2 team.json(`~/.rotom/team.json`,member 模式)

```json
{
  "id": "<协调 master 的 masterId,8 字符 base36>",
  "name": "阿甘团队",
  "coord_endpoints": ["ws://coord-host:28800"]
}
```

也可通过 dashboard「团队」页 runtime 生成(无需重启)。

### 4.3 executor.config.json(`~/.rotom/executor.config.json`)

OPC 模式下 master 自动生成 `.auto-executor.json`(scanClis 模式),无需手写。若要给 agent 起中文名或指定 workingDir,写 `executor.config.json`(优先级高于 auto):

```json
{
  "master": "ws://localhost:28800",
  "workers": [
    {
      "name": "江德福",
      "cliTool": "claude",
      "workingDir": "/Users/me/work/projectA",
      "maxConcurrent": 2,
      "profile": { "position": "全栈工程师", "bio": "主力绝对主力" }
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `master` | `string` | Master WebSocket URL |
| `workers[]` | `array` | worker 列表(也支持单 worker 简化形式) |
| `workers[].name` | `string` | agent 名(OPC 模式下本机信任,无需与 DB 预注册) |
| `workers[].token` | `string?` | **OPC 模式可空**(本机信任);跨机连接远程 master 时必填 |
| `workers[].cliTool` | `string?` | `claude` / `codex` / `openclaw` / `hermes` / `pi`,缺省自动检测 |
| `workers[].workingDir` | `string?` | 任务执行目录,默认 `~/.rotom/workspace` |
| `workers[].maxConcurrent` | `number?` | 并发上限,默认 2 |
| `workers[].profile` | `object?` | 员工档案,`category: "真人"` 时不参与抢单 |

---

## 5. Federation REST API

所有端点挂在 `/api` 下。本机调用走 loopback 信任(免 token);远程用 `Authorization: Bearer <mesh_token>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/identity` | 本机 master 身份(masterId / hostname / role / teamName) |
| GET | `/api/teams` | 已加入的团队列表 |
| GET | `/api/teams/:id/members` | 团队内可见 agent(agent_visibility) |
| GET | `/api/teams/:id/peers` | 团队内 peer master 列表 |
| POST | `/api/teams/join` | runtime 加入上级团队(body: `{ coordEndpoint, teamName? }`) |
| POST | `/api/teams/leave` | runtime 离开团队,切回 standalone |
| POST | `/api/agents/:id/refresh-token` | 刷新 token |

---

## 6. Federation 协议(master ↔ master)

与 agent 协议(v2)分离的 v1 协议,挂在 `/federation` 路径。

- **FedAgentPublish** —— member 把本机 agent 上推到协调,协调广播 `FedDirectorySync`
- **FedRouteMessage** —— member 找不到本机 agent 时,经协调路由到目标 master
- **FedDeliver** —— 协调把消息投递到目标 member
- **FedReply** —— reply 回到来源 member,resolve pendingRequest

实现入口:
- `src/master/federation/server.ts` —— 协调端,监听 member 连接
- `src/master/federation/client.ts` —— member 端,主动连协调
- `src/master/federation/manager.ts` —— FederationManager,封装 join/leave 生命周期
- `src/master/federation/publisher.ts` —— agent 上推与可见性同步
- `src/master/router.ts:setFederation()` —— 注入到主路由

---

## 7. 常见问题

**Q:协调 master 必须有公网 IP 吗?**
A:不需要公网,但需要 member 能访问到的稳定地址。局域网 IP / 内网域名 / 公网 IP 都行,只要 member outbound 能连上。**禁止用 `127.0.0.1` 或 `localhost`**(member 在另一台机器上连不上)。

**Q:member 切网了怎么办?**
A:member 是 outbound 主动连接,客户端有指数退避重连(`src/master/federation/client.ts`)。切网恢复后自动重连,离线期间的消息走协调 master 的离线队列(100 条 / 24h TTL)。

**Q:协调 master 挂了怎么办?**
A:每个 member 仍是 standalone OPC,本机 agent / memory / issue 完整可用,只是跨机消息暂时路由不到。协调恢复后 member 自动重连。

**Q:可以同时加入多个团队吗?**
A:不能。一个 master 同时只能属于一个团队(join 前必须 leave)。`FederationManager.joinTeam` 会抛 "Already a member of a team — leave first"。

**Q:跨机消息经过协调,master 看得到内容吗?**
A:协调 master 转发 FedRouteMessage / FedDeliver,消息体对协调透明(协议层不解析业务 payload)。协调只持有路由元信息(team_peers / agent_visibility),不持有 agent / memory / issue 数据。

**Q:本机 agent 的 mesh_token 会被协调知道吗?**
A:不会。token 仅用于 agent ↔ 本机 master 鉴权;member 与协调之间用 federation 协议,不传 agent token。
