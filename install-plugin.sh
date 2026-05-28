#!/bin/bash
set -euo pipefail

CONFIG_FILE="$HOME/.openclaw/openclaw.json"
USAGE="Usage: $(basename "$0") <plugin-name> <tgz-path>
Example: $(basename "$0") a2a-gateway ~/ai-work/open-a2a-gateway/a2a-gateway-2.0.0.tgz"

if [ $# -lt 2 ]; then
  echo "$USAGE"
  exit 1
fi

PLUGIN_NAME="$1"
TGZ_PATH="$2"

if [ ! -f "$TGZ_PATH" ]; then
  echo "Error: tgz not found: $TGZ_PATH"
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: config not found: $CONFIG_FILE"
  exit 1
fi

# Check if already installed
EXISTING=$(node -e "
  const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8'));
  console.log(cfg.plugins?.installs?.['$PLUGIN_NAME'] ? 'yes' : 'no');
")

if [ "$EXISTING" = "yes" ]; then
  echo "Plugin '$PLUGIN_NAME' already installed. Use update-plugin.sh to upgrade."
  echo "  ~/.openclaw/update-plugin.sh $PLUGIN_NAME <new-tgz>"
  exit 1
fi

echo "==> Installing plugin: $PLUGIN_NAME"
echo "    Package: $TGZ_PATH"

# Backup
cp "$CONFIG_FILE" "${CONFIG_FILE}.bak"

# Install
if ! openclaw plugins install "$TGZ_PATH"; then
  echo "Error: install failed, restoring backup..."
  cp "${CONFIG_FILE}.bak" "$CONFIG_FILE"
  exit 1
fi

# Verify
REGISTERED=$(node -e "
  const cfg = JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8'));
  console.log(cfg.plugins?.installs?.['$PLUGIN_NAME'] ? 'yes' : 'no');
")

if [ "$REGISTERED" = "no" ]; then
  echo "Error: plugin not registered after install"
  exit 1
fi

echo "==> Done. Plugin '$PLUGIN_NAME' installed."
