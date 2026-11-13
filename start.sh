#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 22 or newer, then run this script again.' >&2
  exit 1
fi
if [ ! -d node_modules/@modelcontextprotocol/sdk ]; then npm ci --no-audit --no-fund --cache .local/npm-cache; fi
exec node scripts/cli.mjs setup "$@"
