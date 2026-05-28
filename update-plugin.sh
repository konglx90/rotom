#!/bin/bash
set -euo pipefail

CONFIG_FILE="$HOME/.openclaw/openclaw.json"
USAGE="Usage: $(basename "$0") <plugin-name> <new-tgz-path>
Example: $(basename "$0") a2a-gateway ~/ai-work/open-a2a-gateway/a2a-gateway-2.1.0.tgz"

if [ $# -lt 2 ]; then
  echo "$USAGE"
  exit 1
fi

PLUGIN_NAME="$1"
NEW_TGZ="$2"

if [ ! -f "$NEW_TGZ" ]; then
  echo "Error: tgz not found: $NEW_TGZ"
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: config not found: $CONFIG_FILE"
  exit 1
fi

echo "==> Updating plugin: $PLUGIN_NAME"
echo "    New package: $NEW_TGZ"

# --- 1. Save all plugin-related config before anything changes ---
SAVED=$(node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE','utf8'));
  const result = {
    entries: cfg.plugins?.entries?.['$PLUGIN_NAME'] || null,
    channels: cfg.channels?.['$PLUGIN_NAME'] || null,
    installPath: cfg.plugins?.installs?.['$PLUGIN_NAME']?.installPath || ''
  };
  console.log(JSON.stringify(result));
")

echo "    Saved config: $SAVED"

# --- 2. Backup config file ---
cp "$CONFIG_FILE" "${CONFIG_FILE}.bak"
echo "    Backup: ${CONFIG_FILE}.bak"

# --- 3. Remove old install directory ---
OLD_INSTALL_PATH=$(echo "$SAVED" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).installPath)")

if [ -n "$OLD_INSTALL_PATH" ] && [ -d "$OLD_INSTALL_PATH" ]; then
  echo "    Removing old install: $OLD_INSTALL_PATH"
  rm -rf "$OLD_INSTALL_PATH"
fi

# --- 4. Clean up stale config entries (entries, installs, channels) ---
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE','utf8'));

  // Remove stale plugin entries
  if (cfg.plugins?.entries?.['$PLUGIN_NAME']) delete cfg.plugins.entries['$PLUGIN_NAME'];
  if (cfg.plugins?.installs?.['$PLUGIN_NAME']) delete cfg.plugins.installs['$PLUGIN_NAME'];
  if (cfg.channels?.['$PLUGIN_NAME']) delete cfg.channels['$PLUGIN_NAME'];

  // Clean up empty objects
  if (cfg.plugins?.entries && Object.keys(cfg.plugins.entries).length === 0) delete cfg.plugins.entries;
  if (cfg.plugins?.installs && Object.keys(cfg.plugins.installs).length === 0) delete cfg.plugins.installs;
  if (cfg.channels && Object.keys(cfg.channels).length === 0) delete cfg.channels;

  fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
"
echo "    Cleaned stale config entries"

# --- 5. Install new version ---
echo "    Installing new version..."
if ! openclaw plugins install "$NEW_TGZ"; then
  echo "Error: install failed, restoring backup..."
  cp "${CONFIG_FILE}.bak" "$CONFIG_FILE"
  exit 1
fi

# --- 6. Verify plugin is registered, then restore custom config ---
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE','utf8'));
  const saved = JSON.parse('$SAVED');

  // Check plugin actually registered after install
  const installed = cfg.plugins?.installs?.['$PLUGIN_NAME'];
  if (!installed) {
    console.error('Error: plugin not registered after install, skipping config restore');
    process.exit(1);
  }

  // Restore entries config (enabled, custom config)
  if (saved.entries) {
    if (!cfg.plugins.entries) cfg.plugins.entries = {};
    cfg.plugins.entries['$PLUGIN_NAME'] = Object.assign(
      cfg.plugins.entries['$PLUGIN_NAME'] || {},
      saved.entries
    );
  }

  // Restore channels config
  if (saved.channels) {
    if (!cfg.channels) cfg.channels = {};
    cfg.channels['$PLUGIN_NAME'] = saved.channels;
  }

  fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 2) + '\n');
  console.log('    Config restored');
"

echo "==> Done. Plugin '$PLUGIN_NAME' updated successfully."
