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

PORT="${MESH_MASTER_PORT:-28800}"
HOST="${MESH_MASTER_HOST:-0.0.0.0}"
# data dir 默认跟 ROTOM_HOME 保持一致 —— 让 ROTOM_HOME 真正起到"切换数据目录"的作用。
DATA="${MESH_MASTER_DATA:-$ROTOM_HOME}"
SKIP_BUILD=false
DEV_MODE=false

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
  if [ "$DEV_MODE" = true ]; then
    echo "[rotom-up] 构建中 (build, skip dashboard)..."
    case "$pkg" in
      pnpm) (cd "$SCRIPT_DIR" && pnpm build) ;;
      npm)  (cd "$SCRIPT_DIR" && npm run build) ;;
      yarn) (cd "$SCRIPT_DIR" && yarn build) ;;
    esac
  else
    echo "[rotom-up] 构建中 (build:master)..."
    case "$pkg" in
      pnpm) (cd "$SCRIPT_DIR" && pnpm build:master) ;;
      npm)  (cd "$SCRIPT_DIR" && npm run build:master) ;;
      yarn) (cd "$SCRIPT_DIR" && yarn build:master) ;;
    esac
  fi
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

# 校验 Claude Code CLI 已安装（默认执行器依赖它）
ensure_claude_installed() {
  if command -v claude &>/dev/null; then
    return 0
  fi
  echo "[rotom-up] ❌ 未检测到 Claude Code CLI (\`claude\`)"
  echo ""
  echo "  Rotom 默认以 Claude Code 作为执行器，请先安装："
  echo "    npm install -g @anthropic-ai/claude-code"
  echo "  详细文档: https://docs.claude.com/en/docs/claude-code"
  return 1
}

# 在 master 已就绪的前提下，自动创建「默认公司」+ 注册 Claude Code worker，
# 写入 executor.config.json，并把 rotom CLI 的 defaultAgent 指向该 worker。
bootstrap_default_worker() {
  local domain="默认公司"
  local short_host
  short_host=$(hostname -s 2>/dev/null | tr -cd '[:alnum:]_-' || echo local)
  [ -z "$short_host" ] && short_host=local
  local base="http://127.0.0.1:$PORT/api"

  # 1. 创建默认公司（201 新建 / 409 已存在 均视为成功）
  local domain_code
  domain_code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/domains" \
    -H 'Content-Type: application/json' \
    --data-raw "{\"name\":\"$domain\",\"description\":\"默认公司\"}")
  case "$domain_code" in
    201|409) ;;
    *) echo "[rotom-up] ❌ 创建默认公司失败 (HTTP $domain_code)"; return 1 ;;
  esac

  # 2. 注册 worker；若 409 冲突则追加序号重试
  local base_name="claude-$short_host" try_name="" token=""
  for attempt in 1 2 3 4 5; do
    local name="$base_name"
    [ $attempt -gt 1 ] && name="$base_name-$attempt"
    local body_file; body_file=$(mktemp)
    local code
    code=$(curl -s -o "$body_file" -w '%{http_code}' -X POST "$base/agents" \
      -H 'Content-Type: application/json' \
      --data-raw "{\"name\":\"$name\",\"domain\":\"$domain\"}")
    if [ "$code" = "201" ]; then
      token=$(sed -nE 's/.*"token"[[:space:]]*:[[:space:]]*"(mesh_[^"]+)".*/\1/p' "$body_file")
      try_name="$name"
      rm -f "$body_file"
      break
    fi
    local resp; resp=$(cat "$body_file"); rm -f "$body_file"
    [ "$code" = "409" ] && continue
    echo "[rotom-up] ❌ 注册 worker 失败 (HTTP $code): $resp"
    return 1
  done
  if [ -z "$token" ]; then
    echo "[rotom-up] ❌ 注册 worker 失败：名字 \"$base_name\" 多次冲突"
    return 1
  fi

  # 3. 写入 executor.config.json
  cat > "$EXECUTOR_CONFIG" <<EOF
{
  "master": "ws://localhost:$PORT",
  "workers": [
    { "name": "$try_name", "token": "$token", "cliTool": "claude" }
  ]
}
EOF

  # 4. 设置 rotom CLI 默认身份（不覆盖已有配置）
  local rotom_cfg="$ROTOM_HOME/config.json"
  if [ ! -f "$rotom_cfg" ]; then
    cat > "$rotom_cfg" <<EOF
{
  "defaultAgent": "$try_name",
  "agents": {}
}
EOF
  fi

  echo "[rotom-up] ✅ 已注册默认 worker: $try_name (domain=$domain)"
  echo "           executor 配置: $EXECUTOR_CONFIG"
  echo "           rotom CLI 默认身份: $try_name"
}

# 若 `rotom` 不在 PATH 中，尝试用 pnpm link --global 让它全局可用
ensure_rotom_on_path() {
  local expected="$SCRIPT_DIR/bin/rotom"
  if command -v rotom &>/dev/null; then
    local current; current=$(command -v rotom)
    # 递归解析 symlink 到绝对路径(BSD readlink 不支持 -f,手动展开)
    local resolved="$current"
    while [ -L "$resolved" ]; do
      local dir; dir=$(cd "$(dirname "$resolved")" && pwd)
      local link; link=$(readlink "$resolved")
      case "$link" in
        /*) resolved="$link" ;;
        *)  resolved="$dir/$link" ;;
      esac
    done
    # 解析后仍是当前仓库的 bin/rotom(或当前本身就是),无需重复链接
    if [ "$resolved" = "$expected" ] || [ "$current" = "$expected" ]; then
      return 0
    fi
  fi
  echo "[rotom-up] 注册 rotom CLI 为全局命令..."
  if command -v pnpm &>/dev/null && (cd "$SCRIPT_DIR" && pnpm link --global >/dev/null 2>&1); then
    echo "[rotom-up] ✅ rotom 已全局可用"
    return 0
  fi
  echo "[rotom-up] ⚠️  自动注册失败，可手动执行任一命令："
  echo "    cd $SCRIPT_DIR && pnpm link --global"
  echo "    ln -s $SCRIPT_DIR/bin/rotom /usr/local/bin/rotom"
  return 0
}

# ── 命令 ──────────────────────────────────────────────────────────────────────

do_start() {
  fix_path || true

  # 0. 校验 Claude Code 已安装（默认执行器依赖它）
  ensure_claude_installed || return 1

  # 1. 已经在跑就别重复起
  if is_pid_alive "$MASTER_PID" && is_pid_alive "$EXECUTOR_PID"; then
    echo "[rotom-up] 已在运行 (master PID $(cat "$MASTER_PID"), executor PID $(cat "$EXECUTOR_PID"))"
    return 0
  fi

  # 2. 构建
  ensure_built

  mkdir -p "$ROTOM_HOME" "$RUN_DIR" "$LOG_DIR" "$DATA"

  # 3. 启 Master
  if is_pid_alive "$MASTER_PID"; then
    echo "[rotom-up] master 已在运行 (PID $(cat "$MASTER_PID"))，跳过"
  else
    # 端口预检:避免 6月 14 那次悄无声息的 EADDRINUSE 崩 master。
    # 检测到非自己 pid 占着端口时,把占用的 PID/进程报出来,让用户/脚本
    # 能立刻看出"旧 master 没死干净"vs"别的程序占着端口"。
    if command -v lsof >/dev/null 2>&1; then
      local occupier
      occupier=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n1 || true)
      if [ -n "$occupier" ]; then
        local occupier_cmd
        occupier_cmd=$(ps -p "$occupier" -o command= 2>/dev/null | head -c 120 || echo "(unknown)")
        echo "[rotom-up] ❌ 端口 $PORT 已被占用 (PID $occupier: $occupier_cmd)"
        echo "[rotom-up] 如需强制接管,先 \`lsof -nP -iTCP:$PORT -sTCP:LISTEN\` 找到占用进程并 stop,或 \`rotom-up stop\` 清理旧 master"
        return 1
      fi
    fi
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

  # 4. Executor 由 master 自动 spawn(Phase 1 OPC 行为)。
  #    master 启动时如果检测到 ~/.rotom/executor.config.json 不存在,
  #    会自动生成 .auto-executor.json 并 spawn 本机 executor 子进程,
  #    master 退出时一并 kill。这里不再单独启动 executor。
  if [ -f "$EXECUTOR_CONFIG" ]; then
    echo "[rotom-up] 检测到 $EXECUTOR_CONFIG — master 将尊重用户配置,不会自动 spawn"
  else
    echo "[rotom-up] executor 将由 master 自动 spawn(OPC 模式,免 token 配置)"
  fi

  # 5. 让 rotom CLI 全局可用
  ensure_rotom_on_path

  if [ "$DEV_MODE" != true ]; then
    echo ""
    echo "  Dashboard: http://localhost:$PORT/dashboard"
    echo "  Logs:      $LOG_DIR/{master,executor}.log"
    echo "  Stop:      pnpm stop"
  fi
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

do_start_dev() {
  # 1. Start master + executor as daemons (reuse do_start logic)
  DEV_MODE=true do_start || return 1

  # 2. Start Vite dev server in foreground
  local pkg; pkg=$(detect_pkg)
  if [ -z "$pkg" ]; then
    echo "[rotom-up] 未找到包管理器"; return 1
  fi

  echo "[rotom-up] 启动 Vite dev server (hot reload)..."
  echo ""
  echo "  Frontend: http://localhost:3000"
  echo "  Backend:  http://localhost:$PORT"
  echo "  Ctrl+C 停止所有服务"
  echo ""

  # Cleanup background processes on exit
  dev_cleanup() {
    echo ""
    echo "[rotom-up] 停止所有服务..."
    stop_pid_file "$EXECUTOR_PID" executor 2>/dev/null || true
    stop_pid_file "$MASTER_PID" master 2>/dev/null || true
    exit 0
  }
  trap dev_cleanup INT TERM

  case "$pkg" in
    pnpm) exec pnpm --filter @a2a-gateway/dashboard dev ;;
    npm)  exec npm run --prefix "$SCRIPT_DIR/packages/dashboard" dev ;;
    yarn) exec yarn --cwd "$SCRIPT_DIR/packages/dashboard" dev ;;
  esac
}

do_help() {
  cat <<EOF
Rotom 一站式启停 —— Master（含 Dashboard）+ Executor 守护进程

用法: rotom-up <command> [options]

命令:
  start      启动 master + executor（守护进程，自动 build）
  stop       停止所有进程
  restart    重启
  status     查看运行状态
  logs       tail -F 两个日志

选项:
  --port, -p <port>    Master 端口 (默认: $PORT)
  --host <addr>        Master 监听地址 (默认: $HOST)
  --data, -d <dir>     Master 数据目录 (默认: $DATA)
  --no-build           跳过构建检查直接启动
  --dev                前端开发模式：Vite dev server + hot reload (localhost:3000)

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
    --dev)     DEV_MODE=true; shift ;;
    --help|-h) do_help; exit 0 ;;
    *) echo "未知选项: $1"; do_help; exit 1 ;;
  esac
done

case "$CMD" in
  start)   [ "$DEV_MODE" = true ] && do_start_dev || do_start ;;
  stop)    do_stop ;;
  restart) do_restart ;;
  status)  do_status ;;
  logs)    do_logs ;;
  help|-h|--help) do_help ;;
  *) echo "未知命令: $CMD"; do_help; exit 1 ;;
esac
