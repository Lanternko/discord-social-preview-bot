#!/bin/bash

set -euo pipefail

PROJECT_DIR="."

cd "$PROJECT_DIR"

pkill -f 'src/index.js' >/dev/null 2>&1 || true
pkill -f 'npm start' >/dev/null 2>&1 || true

if [ ! -d node_modules ]; then
  if [ -x /opt/homebrew/opt/node@22/bin/npm ]; then
    /opt/homebrew/opt/node@22/bin/npm install
  else
    npm install
  fi
fi

if [ -x /opt/homebrew/opt/node@22/bin/node ]; then
  /opt/homebrew/opt/node@22/bin/node src/index.js
else
  node src/index.js
fi
