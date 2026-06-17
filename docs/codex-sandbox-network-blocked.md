# Codex Executor Sandbox 拦截本机回环 — rotom CLI 全部走 network error

**发现日期**: 2026-06-17
**状态**: 根因已定位,rotom 端 spawn codex 时显式 `sandbox: "danger-full-access"`
**影响范围**: 所有经 codex worker 跑的 rotom CLI 命令(group send / issue 操作 / directory 等),
表现为 100% 命中 `rotom: network error talking to master` + exit 75

## 现象

群里 @ 西花-codex 让它跑任意 rotom 命令(典型:`rotom issue delete <id>`),
codex 永远拿到:

```
rotom: network error talking to master at http://127.0.0.1:28800/api/issues/<id>: fetch failed
  next: run `rotom status` to verify reachability.
  caveat: on HTTP/1.1 keep-alive sockets, the request may have reached master but the
          response was cut off — check master log to see if your request was processed.
```

exit code 75(EX_TEMPFAIL)。codex 据此回报"master 没开,要不要拉起来"。

**对照实验(同一台机、同一个 master URL、同一份 `~/.rotom/executor.config.json`)**:

| 调用方 | 结果 |
|---|---|
| 用户在 terminal 直接 `rotom issue delete <id>` | ✅ 正常拿到 404 / 200 |
| `curl http://127.0.0.1:28800/health` | ✅ `{"status":"ok",...}` |
| 西花-hermes 群里跑 `rotom issue delete <id>` | ✅ `command failed: HTTP 404 ... master is up` |
| 西花-codex 群里跑 `rotom issue delete <id>` | ❌ `network error talking to master ... fetch failed` |

也就是说,问题只出现在 codex 路径,且**与 master 实际是否在线无关**(master
在线时 codex 也报 master 挂了)。

## 根因

**codex CLI 在 macOS 上的默认 sandbox(read-only / seatbelt)把所有出站网络
挡掉了,包括 `127.0.0.1` 本机回环。rotom 的 `fetch()` 在 codex 沙箱里被拒,
抛 "fetch failed",走 `failKind("network", ...)` 分支。**

证据链:

1. `src/executor/executors/codex.ts:690` 在 `thread/start` 里传
   `sandbox: null`,意思是"用 codex 自己的默认沙箱"。
2. codex CLI 0.140(用户当前版本)的默认 sandbox 是 `read-only`,该模式
   **网络默认全挡**,参见 openai/codex#10390(seatbelt 在某些版本下甚至
   无视 `network_access = true` 配置,只能 CLI flag 解决)。
3. rotom 的 `api()`(src/cli/rotom.ts:242)调 `fetch()` 失败时,catch 里
   `partial = false`,直接走 `failKind("network", ...)` 报 exit 75。
   报错文案本身没问题 — 它确实就是网络层失败,只是失败原因是沙箱,
   不是 master 真挂了。
4. hermes executor 没有原生 sandbox,`fetch()` 直接打到 master → 拿到
   HTTP 404 → 走 `failKind("http", ...)` 报 exit 1。

**为什么之前的 `ea69b40` 那批错误分类改动看着像"没解决问题"**:

那批改动解决的是"真有 HTTP 业务错(404/401/500)时怎么让 LLM 不把它
误读成 master 挂了" — 这部分**完全有效**,西花-hermes 的回报证明了:
hermes 看到的 `command failed: HTTP 404 (master is up)` 就是规则里
要求的样子。

但 codex 这条路根本走不到 HTTP 层 — 它在 TCP connect 阶段就被沙箱
挡了。LLM 看到的永远是 "fetch failed",前缀分类逻辑正确地把它归类成
network 错,然后 LLM 自信地断"master 挂了"。这是另一个独立 bug,
被 network error 这同一个表象掩盖了。

## 修法(走 A:rotom 这边把 codex 拉满权限)

文件:`src/executor/executors/codex.ts` 的 `startOrResumeThread()`,
`thread/start` 请求里把:

```ts
sandbox: null,
```

改成:

```ts
sandbox: "danger-full-access",
```

**为什么拉满,不走走 B(在 `~/.codex/config.toml` 里设 `network_access = true`)**:

- 走 B 跨 codex 版本不稳:openai/codex#10390 明确说 seatbelt 在某些版本下
  无视 `network_access` 配置项,需要同时传 CLI flag 才生效。等 codex 升级
  一次就可能再翻车。
- rotom worker 派任务给 codex 之前已经过 dashboard 审批
  (`approval_policy`),沙箱那层防护本来就是冗余的。worker 的 cwd 是
  `~/.rotom/results/<groupId>`,任务也是受信进程派的。
- 拉 `danger-full-access` 是 codex 官方支持的稳态选项,行为跨版本一致。

**风险**:等于把 codex agent 的工作目录裸给所有写盘+网络。考虑到
rotom worker 本身就是受信进程,且 codex 跑的命令是 dashboard 派发的,
这个风险可接受。如果以后要做更细粒度的隔离,可以再切回 `workspace-write`
+ 自定义 seatbelt profile,但短期内不必。

## 验证

改完之后重新 `pnpm build`(executor daemon 跑的是 `dist/`,见
`feedback_executor_daemon_dist.md`),重启 daemon,然后在群里 @ 西花-codex
跑:

```
rotom issue delete 350c4206bd74
```

**预期输出**(和 hermes 一致):

```
rotom: command failed: HTTP 404 DELETE /issues/350c4206bd74: Issue not found
  (this is a command error, master is up — fix the command and retry)
```

exit code 1(不是 75)。

如果还看到 `network error talking to master ... fetch failed`,说明 sandbox
flag 没生效,需要进一步查 codex CLI 版本是否接受 `"danger-full-access"`
字符串(早期 codex 用的是别的 enum 值)。

## 经验教训

1. **同一份 CLI 在不同 agent 下行为不一致时,先查 agent 自己的执行环境
   (sandbox / 容器 / env),不要怀疑 CLI 本身**。这次绕了半小时纠结
   "为什么 rotom 直接跑就好,codex 跑就错",最后才意识到要查 codex 的
   sandbox 默认行为。
2. **"network error" 这条文案在用户眼里永远等于"master 挂了"**,即使
   我们在 caveat 里写了"可能已处理"。要根本消除歧义,得让 CLI 在 catch
   时**自己**探一下 `/health`,把确定结论塞进 stderr 第 1 行 — 但那是
   另一个独立的优化,本次修法不需要。
3. **spawn 外部 agent CLI 时,任何"用默认值"的参数都假定默认值跟我们
   预期一致**。`sandbox: null` 这个看似无害的传参,直接把 rotom 整条
   codex 路废掉。以后引入新 executor 时,sandbox / approvalPolicy / 网络
   相关参数要显式列出来,不要靠默认值。

## 相关文件

- `src/executor/executors/codex.ts:690` — sandbox 改动点
- `src/cli/rotom.ts:335-378` — `failKind()` 错误分类(network / partial / http)
- `src/shared/rotom-cli-prompt.ts:23-29` — LLM 看到的错误解读规则
- `docs/minimax-connection-error.md` — 类似的"子进程环境导致 CLI 行为异常"案例
