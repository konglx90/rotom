#!/bin/bash
# 数据驱动的 deck build
# - pages.json 描述每页(file, title, tag),顺序就是页面顺序
# - 加页:写新 slide html,在 pages.json 末尾加一行
# - 改顺序/改名/删页:只改 pages.json
# - 占位符 {{N}} {{NN}} {{TOTAL}} {{TOC}} 在 build 时替换
#
# 用法:
#   ./build.sh           # 拼装
#   ./build.sh --check   # 拼 + 校验
#   ./build.sh --open    # 拼 + 浏览器开

set -e
TPL="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TPL/../.." && pwd)"
OUT="$ROOT/docs/rotom-deck-v3.html"
PAGES="$TPL/pages.json"
TMP="$TPL/.build.tmp"

[ -f "$PAGES" ] || { echo "✗ 找不到 $PAGES"; exit 1; }
command -v python3 >/dev/null || { echo "✗ 需要 python3"; exit 1; }

# 1) 让 Python 一次性完成:读 pages.json + 渲染每个 slide + 生成 toc + 拼装
python3 - "$PAGES" "$TPL" "$OUT" <<'PYEOF'
import json, os, re, sys

pages_path, tpl_dir, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
pages = json.load(open(pages_path, encoding="utf-8"))
total = len(pages)

# 校验:文件都存在
for p in pages:
    fp = os.path.join(tpl_dir, "slides", p["file"])
    assert os.path.exists(fp), f"✗ 找不到 slide 文件: {fp}"

# 生成 toc HTML(给 agenda.html 用)
toc_items = []
for i, p in enumerate(pages, 1):
    if i <= 2: continue  # 跳过封面和目录本身
    tag = p.get("tag")
    if tag == "背景":
        tag_html = '<span class="tag-bg">背景</span>'
    elif tag == "主线":
        tag_html = '<span class="tag-v3">主线</span>'
    else:
        tag_html = ''
    nstr = f"{i:02d}"
    toc_items.append(f'    <a data-goto="{i}"><span class="n">{nstr}</span>{tag_html}{p["title"]}</a>')
toc_html = "\n".join(toc_items)

# 拼装
parts = []
# head:含 <body><div class="deck">
parts.append(open(os.path.join(tpl_dir, "head.html"), encoding="utf-8").read())
# 逐张 slide:替换占位符
for i, p in enumerate(pages, 1):
    fp = os.path.join(tpl_dir, "slides", p["file"])
    s = open(fp, encoding="utf-8").read()
    # 把 {{TOTAL}} {{N}} {{NN}} {{TOC}} {{TITLE}} 替换
    s = s.replace("{{TOTAL}}", f"{total:02d}")
    s = s.replace("{{N}}", str(i))
    s = s.replace("{{NN}}", f"{i:02d}")
    s = s.replace("{{TITLE}}", p["title"])
    # 目录页特殊:替换 {{TOC}}
    if p["file"] == "agenda.html":
        s = s.replace("{{TOC}}", toc_html)
    parts.append(s)
# nav:也走占位符替换
nav = open(os.path.join(tpl_dir, "nav.html"), encoding="utf-8").read()
nav = nav.replace("{{TOTAL}}", f"{total:02d}")
parts.append(nav)

content = "".join(parts)
open(out_path, "w", encoding="utf-8").write(content)
print(f"✓ build OK: {out_path} ({len(content)} bytes, {total} pages)")
PYEOF

# 2) 可选校验
if [ "$1" = "--check" ] || [ "$2" = "--check" ]; then
  python3 - "$OUT" "$PAGES" <<'PYEOF'
import re, json, sys
out, pages_path = sys.argv[1], sys.argv[2]
pages = json.load(open(pages_path, encoding="utf-8"))
total = len(pages)
h = open(out, encoding="utf-8").read()

# 残留占位符
for ph in ["{{N}}", "{{NN}}", "{{TOTAL}}", "{{TOC}}", "{{TITLE}}"]:
    if ph in h:
        print(f"✗ 残留占位符 {ph}")
        sys.exit(1)
print("✓ 无残留占位符")

# JS 解析
m = re.search(r'<script>([\s\S]*?)</script>', h)
try:
    # 用 Function 构造器校验(等同于浏览器解析)
    # 注:deck.js 里有 let/const,Function() 会包成全局,这里只校验语法
    js = m.group(1)
    # 简单校验:括号配对 + 没有明显语法错
    open("/tmp/_js_check.js", "w").write(js)
    import subprocess
    r = subprocess.run(["node", "--check", "/tmp/_js_check.js"],
                       capture_output=True, text=True)
    if r.returncode == 0:
        print("✓ JS parse OK (node --check)")
    else:
        print(f"✗ JS FAIL: {r.stderr.strip()}")
        sys.exit(1)
except Exception as e:
    print(f"✗ JS check error: {e}")
    sys.exit(1)

# data-n 唯一 + 1..total
ns = re.findall(r'data-n="(\d+)"', h)
if sorted(set(int(n) for n in ns)) != list(range(1, total+1)):
    print(f"✗ data-n 不连续或缺失: {sorted(set(int(n) for n in ns))}")
    sys.exit(1)
print(f"✓ data-n 唯一 + 连续 (1..{total})")

# data-goto 都合法
gotos = [int(g) for g in re.findall(r'data-goto="(\d+)"', h)]
bad = [g for g in gotos if g < 1 or g > total]
if bad:
    print(f"✗ bad data-goto: {bad}")
    sys.exit(1)
print(f"✓ data-goto all valid (1..{total})")
PYEOF
fi

# 3) 可选打开
if [ "$1" = "--open" ] || [ "$2" = "--open" ]; then
  open "http://localhost:28803/docs/rotom-deck-v3.html" 2>/dev/null || \
    echo "(open 失败,你浏览器手动刷新即可)"
fi
