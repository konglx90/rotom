#!/usr/bin/env bash
# poll-replies.sh — 轮询 rotom 群新消息,等到 reply 或超时
#
# 用法:
#   poll-replies.sh <groupId> --as <agent> [options]
#
# 必填:
#   <groupId>            群 ID
#   --as <agent>         轮询身份(对应 ~/.rotom/executor.config.json 的 worker 名)
#
# 可选:
#   --since <时间>        起始时间(北京时间字符串如 "2026-06-30 18:02:04" 或 UTC ISO)。
#                        不传则自动取群里"最近一条"消息的时间作为起点
#   --max-rounds N       最多轮询 N 轮(默认 10)
#   --interval S         每轮间隔秒数(默认 30)
#   --quiet              静默模式:轮询中不打印 "still waiting..." 心跳
#
# 默认 10×30s = 5min,正好覆盖 ask-bridge 5min 超时窗口。
#
# 退出码:
#   0  找到新消息(已 echo 到 stdout)
#   1  命令行参数错
#   2  轮询 N 轮仍未找到新消息(超时)
#   3  其它错误(rotom 命令失败、group 不存在等)
#
# 例子:
#   poll-replies.sh 7cada00f-... --as codex-xihua
#   poll-replies.sh 7cada00f-... --as codex-xihua --max-rounds 20 --interval 15
#   poll-replies.sh 7cada00f-... --as codex-xihua --since "2026-06-30 18:02:04"
#
# 设计要点:
#   - 强制 --pretty —— rotom 默认输出 JSON(`[{"time":"...",...}]`),直接
#     `awk '{print $1,$2}'` 会抽到 `[{"time":"2026-06-29` 当 SINCE,SINCE 全废。
#     --pretty 出表格后,SINCE 抽取用 `grep -oE 'YYYY-MM-DD HH:MM:SS'` 抓任意
#     位置,不依赖列宽/对齐。
#   - 空响应检测用 "匹配 YYYY-MM-DD 起始" 的行数,不靠 [ -n "$NEW" ](会被
#     表头或 [] 误判为非空)。表头 "time ..." 不含日期,空表 0 数据行 → 继续轮询。
#   - 起始时间用群最近一条消息,避免 "since 一个很久以前的时间" 拉到一堆旧消息。
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
SINCE=""
MAX_ROUNDS=10
INTERVAL=30
QUIET=false

while [ $# -gt 0 ]; do
  case "$1" in
    --as)         AS="$2"; shift 2;;
    --since)      SINCE="$2"; shift 2;;
    --max-rounds) MAX_ROUNDS="$2"; shift 2;;
    --interval)   INTERVAL="$2"; shift 2;;
    --quiet)      QUIET=true; shift;;
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

if ! [[ "$INTERVAL" =~ ^[0-9]+$ ]] || [ "$INTERVAL" -lt 1 ]; then
  echo "--interval must be a positive integer (seconds)" >&2
  exit 1
fi

# ----- 解析 SINCE:缺省取群最近一条 -----
# 关键:rotom 默认输出 JSON(`[{"time":"...",...}]`),[ -n "$NEW" ]/awk 抽列位
# 会拉到一堆无意义字符,SINCE 就废了。强制 --pretty 出表格,再用 grep -oE
# 把里面所有 YYYY-MM-DD HH:MM:SS(.mmm)? 模式抓出来(不依赖列宽/对齐)。
if [ -z "$SINCE" ]; then
  RAW=$(rotom --pretty --as="$AS" group history "$GID" --limit 1 2>/dev/null)
  SINCE=$(printf '%s\n' "$RAW" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?' | tail -1)
  if [ -z "$SINCE" ]; then
    echo "[poll-replies] no SINCE: group history returned no messages or rotom failed (raw: ${RAW:-<empty>})" >&2
    exit 3
  fi
fi

# ----- 主循环 -----
echo "[poll-replies] group=$GID as=$AS since=\"$SINCE\" rounds=$MAX_ROUNDS interval=${INTERVAL}s" >&2

for i in $(seq 1 "$MAX_ROUNDS"); do
  sleep "$INTERVAL"

  if ! NEW=$(rotom --pretty --as="$AS" group new-messages "$GID" --since "$SINCE" 2>/dev/null); then
    echo "[poll-replies] round $i: rotom command failed, retry next round" >&2
    continue
  fi

  # 计数数据行:匹配 YYYY-MM-DD 开头的行(表头 "time ..." 不含日期)。
  # --pretty 表输出每条消息一行,日期开头,正好用来判断"有没有新消息"。
  DATA_LINES=$(printf '%s\n' "$NEW" | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)

  if [ "$DATA_LINES" -gt 0 ]; then
    echo "[poll-replies] round $i/$MAX_ROUNDS: found $DATA_LINES new message(s)" >&2
    printf '%s\n' "$NEW"
    exit 0
  fi

  if [ "$QUIET" = false ]; then
    echo "[poll-replies] round $i/$MAX_ROUNDS: no new messages, waiting ${INTERVAL}s..." >&2
  fi
done

echo "[poll-replies] timed out after $MAX_ROUNDS rounds (~$((MAX_ROUNDS * INTERVAL))s)" >&2
exit 2
