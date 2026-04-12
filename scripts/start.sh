#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

pkill -f 'src/index.js' >/dev/null 2>&1 || true
pkill -f 'npm start' >/dev/null 2>&1 || true

if [ ! -d node_modules ]; then
  npm install
fi

node src/index.js
