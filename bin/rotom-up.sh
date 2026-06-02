#!/usr/bin/env bash
#
# Rotom 一站式启停脚本 —— 守护方式同时跑 Master（含 Dashboard）+ Executor。
#
# 用法: rotom-up <command> [options]
# 命令: start | stop | restart | status | logs
# 选项: --port/-p <port>  --host <addr>  --data/-d <dir>  --no-build
#
# 运行时目录: ~/.rotom/{run,logs}
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MASTER_JS="$SCRIPT_DIR/dist/master/server.js"
EXECUTOR_JS="$SCRIPT_DIR/dist/executor/index.js"

ROTOM_HOME="${ROTOM_HOME:-$HOME/.rotom}"
RUN_DIR="$ROTOM_HOME/run"
LOG_DIR="$ROTOM_HOME/logs"
MASTER_PID="$RUN_DIR/master.pid"
EXECUTOR_PID="$RUN_DIR/executor.pid"
MASTER_LOG="$LOG_DIR/master.log"
EXECUTOR_LOG="$LOG_DIR/executor.log"
EXECUTOR_CONFIG="$ROTOM_HOME/executor.config.json"

PORT="${MESH_MASTER_PORT:-18800}"
HOST="${MESH_MASTER_HOST:-0.0.0.0}"
DATA="${MESH_MASTER_DATA:-$SCRIPT_DIR/mesh-data}"
SKIP_BUILD=false

# ── 工具函数 ──────────────────────────────────────────────────────────────────

fix_path() {
  [ -d "/opt/homebrew/bin" ] && export PATH="/opt/homebrew/bin:$PATH"
  [ -d "/usr/local/bin" ] && export PATH="/usr/local/bin:$PATH"
  [ -d "$HOME/.nodejs/bin" ] && export PATH="$HOME/.nodejs/bin:$PATH"
  [ -s "$HOME/.nvm/nvm.sh" ] && { export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; }
  [ -d "$HOME/.fnm" ] && { export PATH="$HOME/.fnm:$PATH"; eval "$(fnm env 2>/dev/null)" || true; }
  [ -d "$HOME/.volta" ] && export PATH="$HOME/.volta/bin:$PATH"
}

detect_pkg() {
  command -v pnpm &>/dev/null && echo pnpm && return
  command -v npm &>/dev/null && echo npm && return
  command -v yarn &>/dev/null && echo yarn && return
  echo ""
}

# 是否需要重新 build（dist 缺失，或 src/packages 下有更新的源文件）
need_build() {
  [ ! -f "$MASTER_JS" ] && return 0
  [ ! -f "$EXECUTOR_JS" ] && return 0
  local newer
  newer=$(find "$SCRIPT_DIR/src" "$SCRIPT_DIR/packages" \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.html' -o -name '*.css' \) \
    -newer "$MASTER_JS" -print -quit 2>/dev/null || true)
  [ -n "$newer" ]
}

ensure_built() {
  [ "$SKIP_BUILD" = true ] && return 0
  need_build || return 0
  local pkg; pkg=$(detect_pkg)
  if [ -z "$pkg" ]; then
    echo "[rotom-up] 未找到包管理器（pnpm/npm/yarn）"; return 1
  fi
  echo "[rotom-up] 构建中 (build:master)..."
  case "$pkg" in
    pnpm) (cd "$SCRIPT_DIR" && pnpm build:master) ;;
    npm)  (cd "$SCRIPT_DIR" && npm run build:master) ;;
    yarn) (cd "$SCRIPT_DIR" && yarn build:master) ;;
  esac
}

# 校验 PID 文件指向的进程是否仍存活
is_pid_alive() {
  local pid_file="$1"
  [ -f "$pid_file" ] || return 1
  local pid; pid=$(cat "$pid_file" 2>/dev/null || true)
  [ -z "$pid" ] && return 1
  kill -0 "$pid" 2>/dev/null
}

# 优雅停止 PID 文件指向的进程（SIGTERM → 等 5s → SIGKILL）
stop_pid_file() {
  local pid_file="$1" label="$2"
  if ! is_pid_alive "$pid_file"; then
    rm -f "$pid_file"
    return 1
  fi
  local pid; pid=$(cat "$pid_file")
  echo "[rotom-up] 停止 $label (PID $pid)..."
  kill "$pid" 2>/dev/null || true
  local i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do
    sleep 0.1; i=$((i+1))
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$pid_file"
  return 0
}

# 等 master 端口就绪（默认 10s）
wait_master_ready() {
  local max_wait=${1:-10} i=0
  while [ $i -lt $max_wait ]; do
    if curl -sf --connect-timeout 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1; i=$((i+1))
  done
  return 1
}

# ── 命令 ──────────────────────────────────────────────────────────────────────

do_start() {
  fix_path || true

  # 1. 校验 executor 配置
  if [ ! -f "$EXECUTOR_CONFIG" ]; then
    echo "[rotom-up] ❌ 未找到 executor 配置: $EXECUTOR_CONFIG"
    echo "  请先创建该文件，最简内容："
    cat <<EOF
    {
      "master": "ws://localhost:$PORT",
      "workers": [
        { "name": "Your·Agent", "token": "mesh_xxx", "cliTool": "claude" }
      ]
    }
EOF
    return 1
  fi

  # 2. 已经在跑就别重复起
  if is_pid_alive "$MASTER_PID" && is_pid_alive "$EXECUTOR_PID"; then
    echo "[rotom-up] 已在运行 (master PID $(cat "$MASTER_PID"), executor PID $(cat "$EXECUTOR_PID"))"
    return 0
  fi

  # 3. 构建
  ensure_built

  mkdir -p "$RUN_DIR" "$LOG_DIR" "$DATA"

  # 4. 启 Master
  if is_pid_alive "$MASTER_PID"; then
    echo "[rotom-up] master 已在运行 (PID $(cat "$MASTER_PID"))，跳过"
  else
    echo "[rotom-up] 启动 master..."
    nohup node "$MASTER_JS" --port "$PORT" --host "$HOST" --data "$DATA" \
      >> "$MASTER_LOG" 2>&1 &
    echo "$!" > "$MASTER_PID"
    if ! wait_master_ready 15; then
      echo "[rotom-up] ❌ master 启动失败，查看 $MASTER_LOG"
      stop_pid_file "$MASTER_PID" master || true
      return 1
    fi
    echo "[rotom-up] ✅ master 就绪 (PID $(cat "$MASTER_PID"), http://$HOST:$PORT)"
  fi

  # 5. 启 Executor
  if is_pid_alive "$EXECUTOR_PID"; then
    echo "[rotom-up] executor 已在运行 (PID $(cat "$EXECUTOR_PID"))，跳过"
  else
    echo "[rotom-up] 启动 executor..."
    nohup node "$EXECUTOR_JS" --config "$EXECUTOR_CONFIG" \
      >> "$EXECUTOR_LOG" 2>&1 &
    echo "$!" > "$EXECUTOR_PID"
    sleep 1
    if ! is_pid_alive "$EXECUTOR_PID"; then
      echo "[rotom-up] ❌ executor 启动失败，查看 $EXECUTOR_LOG"
      rm -f "$EXECUTOR_PID"
      return 1
    fi
    echo "[rotom-up] ✅ executor 就绪 (PID $(cat "$EXECUTOR_PID"))"
  fi

  echo ""
  echo "  Dashboard: http://localhost:$PORT/dashboard"
  echo "  Logs:      $LOG_DIR/{master,executor}.log"
  echo "  Stop:      pnpm stop"
}

do_stop() {
  local stopped=false
  stop_pid_file "$EXECUTOR_PID" executor && stopped=true || true
  stop_pid_file "$MASTER_PID" master && stopped=true || true
  if [ "$stopped" = true ]; then
    echo "[rotom-up] 已停止"
  else
    echo "[rotom-up] 未在运行"
  fi
}

do_restart() {
  do_stop || true
  sleep 1
  do_start
}

do_status() {
  local any=false
  if is_pid_alive "$MASTER_PID"; then
    echo "[rotom-up] master   运行中 (PID $(cat "$MASTER_PID"), http://$HOST:$PORT)"
    any=true
  else
    echo "[rotom-up] master   未运行"
  fi
  if is_pid_alive "$EXECUTOR_PID"; then
    echo "[rotom-up] executor 运行中 (PID $(cat "$EXECUTOR_PID"))"
    any=true
  else
    echo "[rotom-up] executor 未运行"
  fi
  [ "$any" = true ] || return 1
}

do_logs() {
  mkdir -p "$LOG_DIR"
  touch "$MASTER_LOG" "$EXECUTOR_LOG"
  echo "[rotom-up] tail -F $MASTER_LOG $EXECUTOR_LOG  (Ctrl+C 退出)"
  exec tail -F "$MASTER_LOG" "$EXECUTOR_LOG"
}

do_help() {
  cat <<EOF
Rotom 一站式启停 —— Master（含 Dashboard）+ Executor 守护进程

用法: rotom-up <command> [options]

命令:
  start      启动 master + executor（守护进程，自动 build）
  stop       停止两个进程
  restart    重启
  status     查看运行状态
  logs       tail -F 两个日志

选项:
  --port, -p <port>    Master 端口 (默认: $PORT)
  --host <addr>        Master 监听地址 (默认: $HOST)
  --data, -d <dir>     Master 数据目录 (默认: $DATA)
  --no-build           跳过构建检查直接启动

运行时目录:
  PID:  $RUN_DIR/{master,executor}.pid
  日志: $LOG_DIR/{master,executor}.log
  配置: $EXECUTOR_CONFIG
EOF
}

# ── 入口 ──────────────────────────────────────────────────────────────────────

CMD="${1:-help}"; shift 2>/dev/null || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p) PORT="$2"; shift 2 ;;
    --host)    HOST="$2"; shift 2 ;;
    --data|-d) DATA="$2"; shift 2 ;;
    --no-build) SKIP_BUILD=true; shift ;;
    --help|-h) do_help; exit 0 ;;
    *) echo "未知选项: $1"; do_help; exit 1 ;;
  esac
done

case "$CMD" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_restart ;;
  status)  do_status ;;
  logs)    do_logs ;;
  help|-h|--help) do_help ;;
  *) echo "未知命令: $CMD"; do_help; exit 1 ;;
esac
