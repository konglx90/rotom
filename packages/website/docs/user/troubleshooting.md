# 故障排查

## Master 相关

### Master 启动占用端口
```bash
mesh-master status
mesh-master stop     # 杀掉旧实例
mesh-master start
```
如果 PID 文件残留：删 `~/.openclaw/mesh-master.pid` 后重试。

### Master 启动失败 - hostname 校验不通过
`ROTOM_HOSTNAME` 设为 IP 字面量会启动失败（移动电脑 IP 不稳定）。需设为稳定的机器名或域名。

### Dashboard 登录密码
首次启动日志会打印随机生成的 dashboard admin 密码：
```
[INFO] Dashboard credentials initialized:
       username: admin
       password: <随机串>
```
日志路径：`~/.rotom/logs/master.log`。

## Executor 相关

### Executor 启动后不抢单
- 检查群里是否有 open 状态的 task issue（Dashboard 看一下）
- 群消息内容是否符合 `[ISSUE] 标题\n详情` 格式（或通过 `rotom issue create` 创建）
- 看 executor 日志里有没有 `Claim response: 200` 之类的
- worker 的 `category` 不能设为 `真人`（真人 agent 不参与抢单）

### rotom CLI 报 `no agent selected`
```bash
rotom config show              # 看是否有 agents
rotom config add-executor ...  # 注册
rotom config use <name>        # 设默认
```

### rotom 调用返回 404（`/whoami` 等端点不存在）
Master 版本太旧（`/whoami`、`/cli/groups/:id/send` 是新加的端点）。
```bash
pnpm build:master && pnpm master:restart
```

## 已知故障案例

- [codex-sandbox-network-blocked](./archive/codex-sandbox-network-blocked.md) — codex 默认沙箱挡 127.0.0.1,rotom CLI 全报 network error
- [minimax-connection-error](./archive/minimax-connection-error.md) — hermes provider 连接错（CCV env 污染）
