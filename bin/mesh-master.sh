#!/usr/bin/env bash
#
# Digital Employee Mesh — Master 管理脚本
#
# 用法: mesh-master <command> [options]
# 命令: start | stop | restart | status | install-service | uninstall-service
# 选项: --port/-p <port>  --host <addr>  --data/-d <dir>  --daemon
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_JS="$SCRIPT_DIR/dist/master/server.js"
OPENCLAW_DIR="$HOME/.openclaw"
PID_FILE="$OPENCLAW_DIR/mesh-master.pid"
LOG_FILE="$OPENCLAW_DIR/mesh-master.log"
SVC="com.openclaw.mesh-master"

PORT="${MESH_MASTER_PORT:-18800}"
HOST="${MESH_MASTER_HOST:-0.0.0.0}"
DATA="${MESH_MASTER_DATA:-$SCRIPT_DIR/mesh-data}"
DAEMON=false

# ── 工具函数 ──────────────────────────────────────────────────────────────────

detect_os() { [[ "$OSTYPE" == darwin* ]] && echo macos || echo linux; }

# 查找占用端口的 PID（lsof 在 macOS SIP 下可能看不到 launchd 子进程）
find_port_pid() {
  if command -v lsof &>/dev/null; then
    lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null || true
  elif command -v ss &>/dev/null; then
    ss -tlnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true
  elif command -v fuser &>/dev/null; then
    fuser "$PORT/tcp" 2>/dev/null | tr -d ' ' || true
  else
    echo ""
  fi
}

# 通过 launchctl 获取服务 PID（macOS）
find_service_pid() {
  if [ "$(detect_os)" = "macos" ]; then
    launchctl list "$SVC" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]+$' || true
  fi
}

# 检测端口是否被占用：lsof → TCP 探测 → curl health
is_port_in_use() {
  # 1. lsof（快，但 macOS SIP 下可能看不到 launchd 子进程）
  [ -n "$(find_port_pid)" ] && return 0
  # 2. TCP 连接探测（不受 SIP 限制）
  python3 -c "
import socket, sys
s = socket.socket()
s.settimeout(1)
try:
    s.connect(('127.0.0.1', $PORT))
    s.close()
except:
    sys.exit(1)
" 2>/dev/null && return 0
  # 3. curl health 端点
  curl -sf --connect-timeout 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
  return 1
}

# 轮询等待端口就绪（默认最多 10 秒）
wait_for_port() {
  local max_wait=${1:-10} i=0
  while [ $i -lt $max_wait ]; do
    is_port_in_use && return 0
    sleep 1
    i=$((i+1))
  done
  return 1
}

# 轮询等待端口释放（默认最多 5 秒）
wait_for_port_free() {
  local max_wait=${1:-5} i=0
  while [ $i -lt $max_wait ]; do
    is_port_in_use || return 0
    sleep 1
    i=$((i+1))
  done
  return 1
}

# 检查系统服务是否已安装（plist/service 文件存在）
is_service_installed() {
  if [ "$(detect_os)" = "macos" ]; then
    [ -f "$HOME/Library/LaunchAgents/$SVC.plist" ]
  else
    [ -f "$HOME/.config/systemd/user/mesh-master.service" ]
  fi
}

# 停止系统服务（不删除 plist 文件）
# macOS: bootout 替代废弃的 stop+unload，彻底停止并阻止 KeepAlive 重启
stop_service() {
  if [ "$(detect_os)" = "macos" ]; then
    local domain="gui/$(id -u)"
    launchctl bootout "$domain/$SVC" 2>/dev/null || true
  else
    systemctl --user stop mesh-master 2>/dev/null || true
  fi
}

# 启动系统服务
# macOS: bootstrap + kickstart 替代废弃的 load，确保进程实际启动
start_service() {
  if [ "$(detect_os)" = "macos" ]; then
    local domain="gui/$(id -u)"
    local plist="$HOME/Library/LaunchAgents/$SVC.plist"
    # bootstrap 注册服务（如果已注册则忽略错误）
    launchctl bootstrap "$domain" "$plist" 2>/dev/null || true
    # kickstart -k 强制（重新）启动，解决 bootstrap 不触发 RunAtLoad 的已知问题
    launchctl kickstart -k "$domain/$SVC" 2>/dev/null || true
  else
    systemctl --user start mesh-master 2>/dev/null || true
  fi
}

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

ensure_built() {
  local need=false
  [ ! -f "$SERVER_JS" ] && need=true
  [ "$need" = false ] && {
    local newer
    newer=$(find "$SCRIPT_DIR/packages" \( -name '*.ts' -o -name '*.html' \) -newer "$SERVER_JS" -print -quit 2>/dev/null)
    [ -n "$newer" ] && need=true
  }
  if [ "$need" = true ]; then
    echo "[mesh-master] 构建中..."
    local pkg; pkg=$(detect_pkg)
    case "$pkg" in
      pnpm) (cd "$SCRIPT_DIR" && pnpm build:master) ;;
      npm)  (cd "$SCRIPT_DIR" && npm run build:master) ;;
      yarn) (cd "$SCRIPT_DIR" && yarn build:master) ;;
      *)    echo "[mesh-master] 未找到包管理器"; return 1 ;;
    esac
  fi
}

# 杀掉进程（PID 文件 → launchctl 查询 → 端口查找）
kill_process() {
  local pid
  # 1. PID 文件
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  # 2. launchctl list（macOS，SIP 下 lsof 看不到 launchd 子进程）
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    pid=$(find_service_pid)
  fi
  # 3. 端口查找
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    pid=$(find_port_pid)
  fi
  if [ -z "$pid" ]; then
    return 1
  fi
  echo "[mesh-master] 停止中 (PID $pid)..."
  kill "$pid" 2>/dev/null || true
  local i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  return 0
}

# ── 命令 ──────────────────────────────────────────────────────────────────────

do_run() {
  fix_path || true
  ensure_built || true
  mkdir -p "$OPENCLAW_DIR" "$DATA"
  exec node "$SERVER_JS" --port "$PORT" --host "$HOST" --data "$DATA"
}

do_start() {
  if is_port_in_use; then
    echo "[mesh-master] 端口 $PORT 已被占用"; return 1
  fi
  ensure_built
  mkdir -p "$OPENCLAW_DIR" "$DATA"
  if [ "$DAEMON" = true ]; then
    nohup node "$SERVER_JS" --port "$PORT" --host "$HOST" --data "$DATA" >> "$LOG_FILE" 2>&1 &
    echo "$!" > "$PID_FILE"
    sleep 1
    if kill -0 "$!" 2>/dev/null; then
      echo "[mesh-master] 启动成功 (PID $!, port $PORT)"
    else
      rm -f "$PID_FILE"; echo "[mesh-master] 启动失败，查看 $LOG_FILE"; return 1
    fi
  else
    echo "$$" > "$PID_FILE"
    trap 'rm -f "$PID_FILE"' EXIT INT TERM
    exec node "$SERVER_JS" --port "$PORT" --host "$HOST" --data "$DATA"
  fi
}

do_stop() {
  local was_running=false

  # 如果有系统服务，先 bootout（彻底停止 + 阻止 KeepAlive 重启）
  if is_service_installed; then
    echo "[mesh-master] 检测到系统服务，停止服务..."
    stop_service
    was_running=true
    sleep 1
  fi

  # 再杀残留进程（手动启动的、或 bootout 未杀干净的）
  if kill_process 2>/dev/null; then
    was_running=true
  fi

  if [ "$was_running" = true ]; then
    wait_for_port_free 5 || true
    echo "[mesh-master] 已停止"
  elif is_port_in_use; then
    echo "[mesh-master] 警告: 端口 $PORT 被未知进程占用"
    return 1
  else
    echo "[mesh-master] 未在运行"
  fi
}

do_restart() {
  do_stop
  sleep 1
  # 如果有系统服务，用系统服务启动
  if is_service_installed; then
    echo "[mesh-master] 通过系统服务启动..."
    start_service
    if wait_for_port 10; then
      echo "[mesh-master] 重启成功"
    else
      echo "[mesh-master] 重启失败，查看 $LOG_FILE"; return 1
    fi
  else
    do_start
  fi
}

do_status() {
  if is_port_in_use; then
    echo "[mesh-master] 运行中 (port $PORT)"
    is_service_installed && echo "  模式: 系统服务" || echo "  模式: 手动"
    curl -sf "http://127.0.0.1:$PORT/health" 2>/dev/null | python3 -m json.tool 2>/dev/null || true
  else
    echo "[mesh-master] 未运行"; return 1
  fi
}

# ── 系统服务 ──────────────────────────────────────────────────────────────────

do_install_service() {
  # 先停掉现有进程和旧服务
  if is_service_installed || is_port_in_use; then
    echo "[mesh-master] 停止现有服务/进程..."
    do_stop
    sleep 1
  fi

  ensure_built
  mkdir -p "$OPENCLAW_DIR" "$DATA"
  local self="$SCRIPT_DIR/bin/mesh-master.sh"

  if [ "$(detect_os)" = "macos" ]; then
    local plist="$HOME/Library/LaunchAgents/$SVC.plist"
    local domain="gui/$(id -u)"
    mkdir -p "$HOME/Library/LaunchAgents"

    local data_args=""
    if [ -n "$DATA" ]; then
      data_args="        <string>--data</string><string>${DATA}</string>"
    fi

    cat > "$plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${SVC}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${self}</string><string>_run</string>
        <string>--port</string><string>${PORT}</string>
        <string>--host</string><string>${HOST}</string>
${data_args}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>${PATH}</string>
        <key>HOME</key><string>${HOME}</string>
        <key>LANG</key><string>${LANG:-en_US.UTF-8}</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${LOG_FILE}</string>
    <key>StandardErrorPath</key><string>${LOG_FILE}</string>
    <key>WorkingDirectory</key><string>${SCRIPT_DIR}</string>
</dict>
</plist>
PLIST
    # 现代 API: bootstrap 注册 + kickstart 强制启动
    if ! launchctl bootstrap "$domain" "$plist" 2>&1; then
      echo "[mesh-master] bootstrap 失败"; return 1
    fi
    launchctl kickstart -k "$domain/$SVC" 2>/dev/null || true
  else
    local svc_file="$HOME/.config/systemd/user/mesh-master.service"
    mkdir -p "$(dirname "$svc_file")"

    local data_flag=""
    [ -n "$DATA" ] && data_flag=" --data ${DATA}"

    cat > "$svc_file" << SERVICE
[Unit]
Description=Digital Employee Mesh Master
After=network.target
[Service]
Type=simple
ExecStart=${self} _run --port ${PORT} --host ${HOST}${data_flag}
Restart=always
RestartSec=5
Environment=PATH=${PATH}
Environment=HOME=${HOME}
Environment=LANG=${LANG:-en_US.UTF-8}
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
WorkingDirectory=${SCRIPT_DIR}
[Install]
WantedBy=default.target
SERVICE
    systemctl --user daemon-reload
    systemctl --user enable mesh-master
    systemctl --user start mesh-master
  fi

  if wait_for_port 10; then
    echo "[mesh-master] 系统服务已安装并启动 ✅"
    echo "  升级: git pull → $0 restart"
    echo "  卸载: $0 uninstall-service"
    echo "  日志: $LOG_FILE"
  else
    echo "[mesh-master] 启动失败，查看 $LOG_FILE"; return 1
  fi
}

do_uninstall_service() {
  if [ "$(detect_os)" = "macos" ]; then
    local domain="gui/$(id -u)"
    # bootout 停止并注销服务
    launchctl bootout "$domain/$SVC" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$SVC.plist"
  else
    systemctl --user stop mesh-master 2>/dev/null || true
    systemctl --user disable mesh-master 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/mesh-master.service"
    systemctl --user daemon-reload
  fi
  echo "[mesh-master] 系统服务已卸载 ✅"
}

# ── 帮助 ──────────────────────────────────────────────────────────────────────

do_help() {
  cat <<EOF
Digital Employee Mesh — Master 管理脚本

用法: mesh-master <command> [options]

命令:
  start              启动 (默认前台, --daemon 后台)
  stop               停止（自动识别手动/系统服务）
  restart            重启（自动识别手动/系统服务）
  status             查看状态
  install-service    安装系统服务（开机自启 + 守护进程 + 升级自动编译）
  uninstall-service  卸载系统服务

选项:
  --port, -p <port>    端口 (默认: ${PORT})
  --host <addr>        地址 (默认: ${HOST})
  --data, -d <dir>     数据目录 (默认: ~/Library/Application Support/a2a-gateway/mesh-data)
  --daemon             后台运行

示例:
  mesh-master start --daemon                 # 后台启动
  mesh-master install-service                # 安装为系统服务
  mesh-master restart                        # 重启（升级后用）
  mesh-master status                         # 查看状态
EOF
}

# ── 入口 ──────────────────────────────────────────────────────────────────────

CMD="${1:-help}"; shift 2>/dev/null || true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port|-p) PORT="$2"; shift 2 ;; --host) HOST="$2"; shift 2 ;;
    --data|-d) DATA="$2"; shift 2 ;; --daemon) DAEMON=true; shift ;;
    --help) do_help; exit 0 ;; *) echo "未知选项: $1"; do_help; exit 1 ;;
  esac
done

case "$CMD" in
  start)   do_start ;; stop) do_stop ;; restart) do_restart ;;
  status)  do_status ;; _run) do_run ;;
  install-service) do_install_service ;; uninstall-service) do_uninstall_service ;;
  help|-h|--help) do_help ;; *) echo "未知命令: $CMD"; do_help; exit 1 ;;
esac
