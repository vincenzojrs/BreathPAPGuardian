#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo 'Open Docker Desktop, wait until it is ready, then run this file again.'
  read -r -p 'Press Enter to close.'
  exit 1
fi
if ! docker image inspect pap-locale:1 >/dev/null 2>&1; then
  echo 'Initial setup. Internet access is needed to download the Python image.'
  docker build -t pap-locale:1 .
fi
(sleep 2; open 'http://127.0.0.1:8765') &
exec docker run --rm --init -it --read-only --cap-drop ALL \
  --security-opt no-new-privileges=true \
  -p 127.0.0.1:8765:8765 pap-locale:1
