#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

NODE_VERSION=$(tr -d '[:space:]' < .nvmrc)
NODE_BIN="${NVM_DIR:-$HOME/.nvm}/versions/node/v$NODE_VERSION/bin/node"
NPM_BIN="$(dirname "$NODE_BIN")/npm"

if [ ! -x "$NODE_BIN" ] || [ ! -x "$NPM_BIN" ]; then
  echo "Node $NODE_VERSION is required. Run: nvm install $NODE_VERSION" >&2
  exit 1
fi

pkill -f 'src/index.js' >/dev/null 2>&1 || true
pkill -f 'npm start' >/dev/null 2>&1 || true

if [ ! -d node_modules ]; then
  "$NPM_BIN" install
fi

"$NODE_BIN" src/index.js
