#!/bin/bash
set -e

EXT_DIR="/Users/kong/.openclaw/extensions/a2a-gateway"

echo "📦 Installing a2a-gateway plugin..."

rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"

# 复制 dist 目录内容
cp -r dist/* "$EXT_DIR/"

# 复制 openclaw.plugin.json
cp openclaw.plugin.json "$EXT_DIR/"

# 复制 skill
if [ -d "skill" ]; then
  cp -r skill "$EXT_DIR/"
fi

echo "✅ Plugin installed!"
echo "📂 Location: $EXT_DIR"
