#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f agent.pid ]]; then
  OLD_PID="$(cat agent.pid 2>/dev/null || true)"
  if [[ -n "${OLD_PID}" ]] && ps -p "${OLD_PID}" > /dev/null 2>&1; then
    kill "${OLD_PID}" 2>/dev/null || true
    sleep 1
  fi
fi

# extra safety: kill any stray duplicate runner
pkill -f "node agent.js" 2>/dev/null || true
sleep 1

nohup node agent.js >> agent.log 2>&1 &
echo $! > agent.pid

echo "Started PID: $(cat agent.pid)"
ps -p "$(cat agent.pid)" -o pid,etime,cmd
