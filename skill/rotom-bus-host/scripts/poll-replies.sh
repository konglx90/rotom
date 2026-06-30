#!/usr/bin/env bash
# poll-replies.sh — 轮询 rotom 群最近 10 条消息,等出现新消息后 dump 给大模型判断
#
# 用法:
#   poll-replies.sh <groupId> --as <agent> [options]
#
# 必填:
#   <groupId>            群 ID
#   --as <agent>         轮询身份(对应 ~/.rotom/executor.config.json 的 worker 名)
#
# 可选:
#   --max-rounds N       最多轮询 N 轮(默认 10)
#   --interval S         每轮间隔秒数(默认 30)
#   --limit N            每次拉多少条最近消息(默认 10)
#   --once               只拉一次当前最近 N 条,不轮询(LLM 自己看现状用)
#   --quiet              静默模式:轮询中不打印 "still waiting..." 心跳
#
# 默认 10×30s = 5min,正好覆盖 ask-bridge 5min 超时窗口。
#
# 原理:不靠 --since 时间过滤(那是 JSON/表格列位陷阱)。开局拉一次最近 N 条
# 记下哈希,每轮再拉一次比哈希。哈希变了 = 有新消息到位,把当前最近 N 条
# 完整 dump 到 stdout,退出码 0。大模型自己读这 N 条判断里面有没有自己等
# 的回复。如果没有就再调一次脚本继续等。
#
# 退出码:
#   0  检测到新消息(最近 N 条已 echo 到 stdout)
#   1  命令行参数错
#   2  轮询 N 轮仍无新消息(超时)
#   3  其它错误(rotom 命令失败、group 不存在等)
#
# 例子:
#   poll-replies.sh 7cada00f-... --as codex-xihua
#   poll-replies.sh 7cada00f-... --as codex-xihua --max-rounds 20 --interval 15
#   poll-replies.sh 7cada00f-... --as codex-xihua --once            # 只看当前,不等
set -euo pipefail

print_usage() {
  sed -n '2,/^set -/p' "$0" | sed '$d'
}

# ----- 参数解析 -----
if [ $# -lt 1 ]; then
  print_usage
  exit 1
fi

GID="$1"; shift

AS=""
MAX_ROUNDS=10
INTERVAL=30
LIMIT=10
ONCE=false
QUIET=false

while [ $# -gt 0 ]; do
  case "$1" in
    --as)         AS="$2"; shift 2;;
    --max-rounds) MAX_ROUNDS="$2"; shift 2;;
    --interval)   INTERVAL="$2"; shift 2;;
    --limit)      LIMIT="$2"; shift 2;;
    --once)      ONCE=true; shift;;
    --quiet)     QUIET=true; shift;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$AS" ]; then
  echo "--as <agent> is required" >&2
  exit 1
fi

if ! [[ "$MAX_ROUNDS" =~ ^[0-9]+$ ]] || [ "$MAX_ROUNDS" -lt 1 ]; then
  echo "--max-rounds must be a positive integer" >&2
  exit 1
fi

if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || [ "$INTERVAL" -lt 0 ]; then
  echo "--interval must be a non-negative integer (seconds)" >&2
  exit 1
fi

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [ "$LIMIT" -lt 1 ]; then
  echo "--limit must be a positive integer" >&2
  exit 1
fi

# ----- 拉取函数 -----
fetch_latest() {
  # --clean 剥 [status:thinking]/[tool:exec] 等标记,--pretty 出表格
  # 便于人/LLM 直读。返回内容用作哈希比较 + 最终 dump。
  rotom --pretty --as="$AS" group history "$GID" --limit "$LIMIT" --clean 2>&1
}

# 哈希:去掉 [rotom] Resolving... 这类 stderr 前缀行,只对表格本体算哈希。
# 这样 master 日志/agent 解析行不会污染比较。
hash_output() {
  printf '%s\n' "$1" | grep -v '^\[rotom\]' | shasum | cut -d' ' -f1
}

# ----- --once 模式:拉一次就走 -----
if [ "$ONCE" = true ]; then
  fetch_latest
  exit 0
fi

# ----- 主循环 -----
INITIAL=$(fetch_latest)
INITIAL_HASH=$(hash_output "$INITIAL")
if [ -z "$INITIAL_HASH" ]; then
  echo "[poll-replies] initial fetch failed (empty output)" >&2
  exit 3
fi

echo "[poll-replies] group=$GID as=$AS limit=$LIMIT rounds=$MAX_ROUNDS interval=${INTERVAL}s" >&2

for i in $(seq 1 "$MAX_ROUNDS"); do
  sleep "$INTERVAL"

  CURRENT=$(fetch_latest)
  CURRENT_HASH=$(hash_output "$CURRENT")

  if [ -z "$CURRENT_HASH" ]; then
    echo "[poll-replies] round $i: fetch failed, retry next round" >&2
    continue
  fi

  if [ "$CURRENT_HASH" != "$INITIAL_HASH" ]; then
    echo "[poll-replies] round $i/$MAX_ROUNDS: new message detected, dumping latest $LIMIT" >&2
    printf '%s\n' "$CURRENT"
    exit 0
  fi

  if [ "$QUIET" = false ]; then
    echo "[poll-replies] round $i/$MAX_ROUNDS: no change, waiting ${INTERVAL}s..." >&2
  fi
done

echo "[poll-replies] timed out after $MAX_ROUNDS rounds (~$((MAX_ROUNDS * INTERVAL))s), no new messages" >&2
exit 2
