#!/usr/bin/env bash
#
# 数字员工 Mesh — Agent 卸载脚本
#
# 用法:
#   ./bin/uninstall-agent.sh [--dry-run]
#
# 从 OpenClaw 配置中移除 a2a-gateway 插件和相关配置。
# 不删除插件源码、agent workspace、任务记录等用户数据。

set -euo pipefail

# ── 参数 ──────────────────────────────────────────────────────────────────────
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# ── 颜色 ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
dry()     { echo -e "${PURPLE}[DRY]${NC}  $1"; }

# ── 路径 ──────────────────────────────────────────────────────────────────────
OPENCLAW_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_FILE="$OPENCLAW_DIR/openclaw.json"

# ── 前置检查 ──────────────────────────────────────────────────────────────────
if [[ ! -f "$CONFIG_FILE" ]]; then
  warn "配置文件不存在: $CONFIG_FILE"
  warn "无需卸载。"
  exit 0
fi

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     数字员工 Mesh — Agent 卸载向导                ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
echo ""
$DRY_RUN && info "模式: 预览 (不实际修改)"
echo ""

# ── 1. 清理 openclaw.json 配置 ───────────────────────────────────────────────
info "清理 openclaw.json 配置..."

node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
  const dryRun = $DRY_RUN;
  const changes = [];

  // channels.a2a-gateway
  if (cfg.channels?.['a2a-gateway']) {
    delete cfg.channels['a2a-gateway'];
    changes.push('channels.a2a-gateway');
  }

  // plugins.entries.a2a-gateway
  if (cfg.plugins?.entries?.['a2a-gateway']) {
    delete cfg.plugins.entries['a2a-gateway'];
    changes.push('plugins.entries.a2a-gateway');
  }

  // plugins.load.paths 中含 a2a-gateway 的条目
  const paths = cfg.plugins?.load?.paths;
  if (paths) {
    const filtered = paths.filter(p => !p.includes('a2a-gateway'));
    if (filtered.length !== paths.length) {
      cfg.plugins.load.paths = filtered;
      if (!filtered.length) delete cfg.plugins.load.paths;
      if (cfg.plugins.load && !Object.keys(cfg.plugins.load).length) delete cfg.plugins.load;
      changes.push('plugins.load.paths (a2a-gateway entry)');
    }
  }

  // plugins.installs.a2a-gateway
  if (cfg.plugins?.installs?.['a2a-gateway']) {
    delete cfg.plugins.installs['a2a-gateway'];
    changes.push('plugins.installs.a2a-gateway');
  }

  // skills.load.extraDirs 中含 a2a-gateway 的条目
  const dirs = cfg.skills?.load?.extraDirs;
  if (dirs) {
    const filtered = dirs.filter(d => !d.includes('a2a-gateway'));
    if (filtered.length !== dirs.length) {
      cfg.skills.load.extraDirs = filtered;
      if (!filtered.length) delete cfg.skills.load.extraDirs;
      changes.push('skills.load.extraDirs (a2a-gateway entry)');
    }
  }

  if (!changes.length) {
    console.log('  未找到 a2a-gateway 相关配置');
  } else {
    changes.forEach(c => console.log('  ✓ 移除 ' + c));
    if (!dryRun) {
      fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
      console.log('  ✓ 配置已保存');
    } else {
      console.log('  [DRY] 预览，未写入');
    }
  }
"
echo ""

# ── 2. 删除 npm 安装的扩展目录（如有）─────────────────────────────────────────
EXT_DIR="$OPENCLAW_DIR/extensions/a2a-gateway"
if [[ -d "$EXT_DIR" ]]; then
  if $DRY_RUN; then
    dry "将移除: $EXT_DIR"
  else
    rm -rf "$EXT_DIR"
    success "已移除: $EXT_DIR"
  fi
else
  info "未发现 npm 安装的扩展目录 (跳过)"
fi
echo ""

# ── 3. 完成 ──────────────────────────────────────────────────────────────────
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
if $DRY_RUN; then
  info "预览完成。去掉 --dry-run 重新执行以生效。"
else
  success "卸载完成！"
  echo ""
  echo "下一步:"
  echo "  openclaw gateway restart"
fi
echo -e "${GREEN}════════════════════════════════════════════════════${NC}"
echo ""
