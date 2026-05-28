#!/usr/bin/env bash
#
# 数字员工 Mesh — Agent 安装/升级脚本
#
# 用法:
#   ./bin/install-agent.sh
#
# 自动检测包管理器 (pnpm/npm/yarn)，交互式配置 OpenClaw 插件和技能。
# 支持升级：清理旧路径、保留用户自定义配置、移除旧版 npm 安装残留。

set -euo pipefail

# ── 颜色 ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── 检测包管理器 ─────────────────────────────────────────────────────────────
detect_pkg_manager() {
  if command -v pnpm &> /dev/null; then
    echo "pnpm"
  elif command -v npm &> /dev/null; then
    echo "npm"
  elif command -v yarn &> /dev/null; then
    echo "yarn"
  else
    error "未找到包管理器 (pnpm/npm/yarn)，请先安装 Node.js"
  fi
}

# ── 检测 OpenClaw ─────────────────────────────────────────────────────────────
OPENCLAW_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

check_openclaw() {
  if [ ! -d "$OPENCLAW_DIR" ]; then
    error "OpenClaw 未安装。请先安装 OpenClaw: https://docs.openclaw.ai"
  fi

  if [ ! -f "$CONFIG_FILE" ]; then
    warn "openclaw.json 不存在，将自动创建"
    echo '{}' > "$CONFIG_FILE"
  fi

  success "OpenClaw 已安装"
}

# ── 安装依赖 ─────────────────────────────────────────────────────────────────
install_deps() {
  local pkg_manager
  pkg_manager=$(detect_pkg_manager)
  info "使用 $pkg_manager 安装依赖..."

  cd "$SCRIPT_DIR"
  # Agent 不需要 better-sqlite3 (仅 Master 使用)，跳过 optionalDependencies 避免原生编译失败
  case "$pkg_manager" in
    pnpm)
      pnpm install --no-optional
      pnpm build
      ;;
    npm)
      npm install --omit=optional
      npm run build
      ;;
    yarn)
      yarn install --ignore-optional
      yarn build
      ;;
  esac

  success "依赖安装完成"
}

# ── 交互式输入 ────────────────────────────────────────────────────────────────
prompt_input() {
  echo ""
  echo -e "${YELLOW}请输入以下信息（联系 Master 管理员获取）:${NC}"
  echo ""

  # 检测已有配置，作为默认值
  local default_master default_name default_token default_desc
  default_master=$(node -e "
    const c = require('$CONFIG_FILE');
    console.log(c.channels?.['a2a-gateway']?.master || '');
  " 2>/dev/null || echo "")
  default_name=$(node -e "
    const c = require('$CONFIG_FILE');
    console.log(c.channels?.['a2a-gateway']?.name || '');
  " 2>/dev/null || echo "")
  default_token=$(node -e "
    const c = require('$CONFIG_FILE');
    console.log(c.channels?.['a2a-gateway']?.token || '');
  " 2>/dev/null || echo "")
  default_desc=$(node -e "
    const c = require('$CONFIG_FILE');
    console.log(c.channels?.['a2a-gateway']?.description || '');
  " 2>/dev/null || echo "")

  # Master 地址
  if [ -n "$default_master" ]; then
    read -p "Master 地址 [$default_master]: " MASTER_URL
    MASTER_URL="${MASTER_URL:-$default_master}"
  else
    read -p "Master 地址 (如 ws://10.x.x.x:18800): " MASTER_URL
  fi
  [ -z "$MASTER_URL" ] && error "Master 地址不能为空"

  # Agent 名称
  if [ -n "$default_name" ]; then
    read -p "Agent 名称 [$default_name]: " AGENT_NAME
    AGENT_NAME="${AGENT_NAME:-$default_name}"
  else
    read -p "Agent 名称 (全局唯一，如 xiaozhu): " AGENT_NAME
  fi
  [ -z "$AGENT_NAME" ] && error "Agent 名称不能为空"

  # Token
  if [ -n "$default_token" ]; then
    read -p "注册令牌 [$default_token]: " AGENT_TOKEN
    AGENT_TOKEN="${AGENT_TOKEN:-$default_token}"
  else
    read -p "注册令牌 (mesh_xxxx): " AGENT_TOKEN
  fi
  [ -z "$AGENT_TOKEN" ] && error "Token 不能为空"

  # 描述
  if [ -n "$default_desc" ]; then
    read -p "Agent 描述 [$default_desc]: " AGENT_DESC
    AGENT_DESC="${AGENT_DESC:-$default_desc}"
  else
    read -p "Agent 描述 (可选，回车跳过): " AGENT_DESC
  fi
}

# ── 配置 OpenClaw ─────────────────────────────────────────────────────────────
configure_openclaw() {
  info "正在配置 openclaw.json..."

  node -e "
    const fs = require('fs');
    const path = require('path');
    const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
    const pluginPath = '$SCRIPT_DIR';
    const skillDir = path.join(pluginPath, 'skill');
    const upgraded = [];

    // ── 1. channels.a2a-gateway: 合并而非覆写，保留用户自定义字段 ──
    config.channels = config.channels || {};
    const existing = config.channels['a2a-gateway'] || {};
    config.channels['a2a-gateway'] = {
      ...existing,                     // 保留已有字段 (filter, allowFrom 等)
      master: '$MASTER_URL',
      name: '$AGENT_NAME',
      token: '$AGENT_TOKEN',
      description: '${AGENT_DESC:-}',
      enabled: true
    };

    // ── 2. plugins.load.paths: 清理旧的 a2a-gateway 路径，写入当前路径 ──
    config.plugins = config.plugins || {};
    config.plugins.load = config.plugins.load || {};
    config.plugins.load.paths = config.plugins.load.paths || [];
    const oldPaths = config.plugins.load.paths.filter(p => p.includes('a2a-gateway') && p !== pluginPath);
    if (oldPaths.length) {
      config.plugins.load.paths = config.plugins.load.paths.filter(p => !p.includes('a2a-gateway'));
      upgraded.push('清理旧插件路径: ' + oldPaths.join(', '));
    }
    if (!config.plugins.load.paths.includes(pluginPath)) {
      config.plugins.load.paths.push(pluginPath);
    }

    // ── 3. 启用插件 ──
    config.plugins.entries = config.plugins.entries || {};
    config.plugins.entries['a2a-gateway'] = { enabled: true };

    // ── 4. skills.load.extraDirs: 清理旧的 a2a-gateway 路径，写入当前路径 ──
    config.skills = config.skills || {};
    config.skills.load = config.skills.load || {};
    config.skills.load.extraDirs = config.skills.load.extraDirs || [];
    const oldDirs = config.skills.load.extraDirs.filter(d => d.includes('a2a-gateway') && d !== skillDir);
    if (oldDirs.length) {
      config.skills.load.extraDirs = config.skills.load.extraDirs.filter(d => !d.includes('a2a-gateway'));
      upgraded.push('清理旧技能路径: ' + oldDirs.join(', '));
    }
    if (!config.skills.load.extraDirs.includes(skillDir)) {
      config.skills.load.extraDirs.push(skillDir);
    }

    // ── 5. 清理旧版 npm 安装残留 ──
    if (config.plugins?.installs?.['a2a-gateway']) {
      delete config.plugins.installs['a2a-gateway'];
      upgraded.push('清理旧版 npm 安装记录');
    }
    const npmExtDir = path.join('$OPENCLAW_DIR', 'extensions', 'a2a-gateway');
    if (fs.existsSync(npmExtDir)) {
      fs.rmSync(npmExtDir, { recursive: true });
      upgraded.push('删除旧版 npm 扩展目录: ' + npmExtDir);
    }

    // ── 写入 ──
    fs.writeFileSync('$CONFIG_FILE', JSON.stringify(config, null, 2) + '\n');

    if (upgraded.length) {
      console.log('升级清理:');
      upgraded.forEach(u => console.log('  ✓ ' + u));
    }
    console.log('配置完成');
  "

  success "配置已写入 $CONFIG_FILE"
}

# ── 显示结果 ──────────────────────────────────────────────────────────────────
show_result() {
  echo ""
  echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  安装完成！${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
  echo ""
  echo "已配置:"
  echo "  • Master: $MASTER_URL"
  echo "  • Agent:  $AGENT_NAME"
  echo "  • 插件:   a2a-gateway ($(node -e "console.log(require('$SCRIPT_DIR/package.json').version)"))"
  echo "  • 技能:   a2a-peer-comm, a2a-monitor"
  echo "  • 路径:   $SCRIPT_DIR"
  echo ""
  echo -e "${YELLOW}下一步:${NC}"
  echo "  openclaw gateway restart"
  echo ""
  echo "验证连接:"
  echo "  openclaw gateway logs | grep -i mesh"
  echo ""
}

# ── 主入口 ────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║     数字员工 Mesh — Agent 安装/升级向导           ║${NC}"
  echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
  echo ""

  check_openclaw
  install_deps
  prompt_input
  configure_openclaw
  show_result
}

main "$@"
