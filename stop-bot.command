#!/bin/bash

pkill -f 'src/index.js' >/dev/null 2>&1 || true
pkill -f 'npm start' >/dev/null 2>&1 || true
