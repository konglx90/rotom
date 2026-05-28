#!/usr/bin/env bash
#
# 把本仓库的 skill/rotom-a2a-communicate/SKILL.md 安装到 AI 工具的 skills 目录，
# 让工具自动加载"rotom-a2a-communicate"技能（即知道如何通过 Bash 调用 rotom）。
#
# Usage:
#   ./bin/install-skill.sh                   # 装到 ~/.agents/skills/ + 软链到 ~/.claude/skills/ 和 ~/.hermes/skills/
#   ./bin/install-skill.sh --project DIR     # 装到 DIR/.claude/skills/（项目级）
#   ./bin/install-skill.sh --copy            # 用拷贝而非软链（更新后需重装）
#   ./bin/install-skill.sh --uninstall       # 卸载
#
# 默认先装到 ~/.agents/skills/，再在 ~/.claude/skills/ 和 ~/.hermes/skills/ 建软链指向它。
#
# 默认使用软链：你在项目内改了 SKILL.md，Claude Code / Hermes 下次启动立即看到新版。

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()      { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
die()     { echo -e "${RED}[ERR]${NC} $1" >&2; exit 1; }

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO/skill/rotom-a2a-communicate"
SRC_FILE="$SRC_DIR/SKILL.md"

MODE="link"               # link | copy
TARGET_BASE="$HOME/.claude/skills"
UNINSTALL=false
ALL_MODE=true

# 安装到单个目标
install_one() {
  local base="$1"
  local dir="$base/$SKILL_NAME"

  mkdir -p "$base"

  if [ -e "$dir" ] || [ -L "$dir" ]; then
    warn "$dir 已存在，将覆盖"
    rm -rf "$dir"
  fi

  if [ "$MODE" = "link" ]; then
    ln -s "$SRC_DIR" "$dir"
    info "已安装 ($MODE): $dir"
  else
    cp -r "$SRC_DIR" "$dir"
    info "已安装 ($MODE): $dir"
  fi
}

# 卸载单个目标
uninstall_one() {
  local dir="$1/$SKILL_NAME"
  if [ -e "$dir" ] || [ -L "$dir" ]; then
    rm -rf "$dir"
    ok "已卸载 $dir"
  else
    warn "$dir 不存在，跳过"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) [ -z "${2:-}" ] && die "--project 需要路径"
               TARGET_BASE="$(cd "$2" && pwd)/.claude/skills"; shift 2;;
    --all)     ALL_MODE=true; shift;;
    --copy)    MODE="copy"; shift;;
    --link)    MODE="link"; shift;;
    --uninstall) UNINSTALL=true; shift;;
    -h|--help) sed -n '3,16p' "$0"; exit 0;;
    *) die "未知参数: $1";;
  esac
done

# 从 SKILL.md frontmatter 里读 name 作为目录名
[ -f "$SRC_FILE" ] || die "找不到 $SRC_FILE"
SKILL_NAME="$(awk '/^name:/{print $2; exit}' "$SRC_FILE")"
[ -n "$SKILL_NAME" ] || die "$SRC_FILE frontmatter 缺少 name 字段"

CLAUD_DIR="$HOME/.claude/skills/$SKILL_NAME"
AGENT_DIR="$HOME/.agents/skills/$SKILL_NAME"
HERMES_DIR="$HOME/.hermes/skills/$SKILL_NAME"

if [ "$ALL_MODE" = true ]; then
  # --all: 先装到 ~/.agents/skills/，再软链到 ~/.claude/skills/ 和 ~/.hermes/skills/
  install_one "$HOME/.agents/skills"
  rm -f "$CLAUD_DIR"
  ln -s "$AGENT_DIR" "$CLAUD_DIR"
  ok "软链: $CLAUD_DIR -> $AGENT_DIR"
  rm -f "$HERMES_DIR"
  ln -s "$AGENT_DIR" "$HERMES_DIR"
  ok "软链: $HERMES_DIR -> $AGENT_DIR"
elif [ "$UNINSTALL" = true ]; then
  uninstall_one "$TARGET_BASE"
  # 同时清理 hermes 目录
  if [ -e "$HERMES_DIR" ] || [ -L "$HERMES_DIR" ]; then
    rm -rf "$HERMES_DIR"
    ok "已卸载 $HERMES_DIR"
  fi
else
  install_one "$TARGET_BASE"
fi

echo
echo "验证:"
echo "  cat ~/.claude/skills/$SKILL_NAME/SKILL.md | head -3"
echo "  cat ~/.agents/skills/$SKILL_NAME/SKILL.md | head -3"
echo "  cat ~/.hermes/skills/$SKILL_NAME/SKILL.md | head -3"