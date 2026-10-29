#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo 'Python 3 unavailable. Use Avvia-con-Docker.command with Docker Desktop running.'
  read -r -p 'Press Enter to close.'
  exit 1
fi
(sleep 1; open 'http://127.0.0.1:8765') &
exec python3 server.py
