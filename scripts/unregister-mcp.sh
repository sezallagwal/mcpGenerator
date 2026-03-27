#!/usr/bin/env bash
# Remove a generated MCP server from ~/.gemini/settings.json
# Usage: ./scripts/unregister-mcp.sh <project-name>
#
# The project name follows the same convention as the generator:
# underscores are converted to hyphens (moderation_bot → moderation-bot).
set -e

if [[ -z "$1" ]]; then
  echo "Usage: $0 <project-name>"
  echo "  Removes the MCP server entry from ~/.gemini/settings.json"
  echo ""
  echo "Examples:"
  echo "  $0 moderation-bot"
  echo "  $0 moderation_bot   # underscores auto-converted to hyphens"
  exit 1
fi

# Normalise: underscores → hyphens (matches registration logic in server.ts)
SERVER_NAME="${1//_/-}"

SETTINGS_FILE="${HOME}/.gemini/settings.json"

if [[ ! -f "$SETTINGS_FILE" ]]; then
  echo "No settings file found at $SETTINGS_FILE — nothing to remove."
  exit 0
fi

if ! command -v node &>/dev/null; then
  echo "Error: node is required but not found on PATH." >&2
  exit 1
fi

node -e "
  const fs = require('fs');
  const path = process.argv[1];
  const name = process.argv[2];

  const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
  const servers = cfg.mcpServers || {};

  if (!(name in servers)) {
    console.log('MCP server \"' + name + '\" not found in settings.json — nothing to remove.');
    process.exit(0);
  }

  const entry = servers[name];
  delete servers[name];
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  console.log('Removed MCP server \"' + name + '\" from ' + path);
  if (entry && entry.cwd) {
    console.log('  (was pointing to: ' + entry.cwd + ')');
  }
" "$SETTINGS_FILE" "$SERVER_NAME"
