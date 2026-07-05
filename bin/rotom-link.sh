#!/usr/bin/env bash
#
# rotom-link —— 轻量 federation link daemon 启停脚本。
#
# 用法: rotom-link <command> [options]
# 命令: start | stop | restart | status | logs
# 选项: --port/-p <port>   默认 28900
#
# 运行时目录: ~/.rotom/{run,logs}
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LINK_JS="$SCRIPT_DIR/dist/link/server.js"

ROTOM_HOME="${ROTOM_HOME:-$HOME/.rotom}"
RUN_DIR="$ROTOM_HOME/run"
LOG_DIR="$ROTOM_HOME/logs"
LINK_PID="$RUN_DIR/link.pid"
LINK_LOG="$LOG_DIR/link.log"
LINK_CONFIG="$ROTOM_HOME/link.json"

PORT="${ROTOM_LINK_PORT:-28900}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

is_pid_alive() {
  local pid_file="$1"
  [ -f "$pid_file" ] || return 1
  local pid; pid=$(cat "$pid_file" 2>/dev/null || true)
  [ -z "$pid" ] && return 1
  kill -0 "$pid" 2>/dev/null
}

stop_pid_file() {
  local pid_file="$1" label="$2"
  if ! is_pid_alive "$pid_file"; then
    rm -f "$pid_file"
    return 1
  fi
  local pid; pid=$(cat "$pid_file")
  echo "[rotom-link] 停止 $label (PID $pid)..."
  kill "$pid" 2>/dev/null || true
  local i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do
    sleep 0.1; i=$((i+1))
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$pid_file"
  return 0
}

wait_link_ready() {
  local max_wait=${1:-10} i=0
  while [ $i -lt $max_wait ]; do
    if curl -sf --connect-timeout 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1; i=$((i+1))
  done
  return 1
}

do_start() {
  if is_pid_alive "$LINK_PID"; then
    echo "[rotom-link] 已在运行 (PID $(cat "$LINK_PID"))"
    return 0
  fi
  if [ ! -f "$LINK_JS" ]; then
    echo "[rotom-link] ❌ $LINK_JS 不存在,请先 \`pnpm build\`"
    return 1
  fi
  if [ ! -f "$LINK_CONFIG" ]; then
    echo "[rotom-link] ❌ $LINK_CONFIG 不存在,请先 \`rotom link join <coordEndpoint> --hostname <name>\`"
    return 1
  fi
  # 端口预检
  if command -v lsof >/dev/null 2>&1; then
    local occupier
    occupier=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true)
    if [ -n "$occupier" ]; then
      local occupier_cmd
      occupier_cmd=$(ps -p "$occupier" -o command= 2>/dev/null | head -c 120 || echo "(unknown)")
      echo "[rotom-link] ❌ 端口 $PORT 已被占用 (PID $occupier: $occupier_cmd)"
      return 1
    fi
  fi
  echo "[rotom-link] 启动 link daemon (port=$PORT)..."
  nohup node "$LINK_JS" --port "$PORT" >> "$LINK_LOG" 2>&1 &
  echo "$!" > "$LINK_PID"
  if ! wait_link_ready 10; then
    echo "[rotom-link] ❌ 启动失败,查看 $LINK_LOG"
    stop_pid_file "$LINK_PID" link || true
    return 1
  fi
  echo "[rotom-link] ✅ 就绪 (PID $(cat "$LINK_PID"), http://127.0.0.1:$PORT)"
}

do_stop() {
  stop_pid_file "$LINK_PID" link || echo "[rotom-link] 未在运行"
}

do_status() {
  if is_pid_alive "$LINK_PID"; then
    local pid; pid=$(cat "$LINK_PID")
    echo "[rotom-link] running (PID $pid, port=$PORT)"
    if curl -sf --connect-timeout 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      curl -s "http://127.0.0.1:$PORT/health"
      echo
    fi
  else
    echo "[rotom-link] stopped"
  fi
}

do_logs() {
  if [ -f "$LINK_LOG" ]; then
    tail -n 200 "$LINK_LOG"
  else
    echo "[rotom-link] no log at $LINK_LOG"
  fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  logs)    do_logs ;;
  *)
    echo "usage: rotom-link <start|stop|restart|status|logs> [--port N]"
    exit 1
    ;;
esac
