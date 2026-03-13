#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f gmgn_bot.pid ]]; then
  OLD_PID="$(cat gmgn_bot.pid 2>/dev/null || true)"
  if [[ -n "${OLD_PID}" ]] && ps -p "${OLD_PID}" >/dev/null 2>&1; then
    kill "${OLD_PID}" 2>/dev/null || true
    sleep 1
  fi
fi

pkill -f "/root/gmgn-venv/bin/python .*gmgn.py" 2>/dev/null || true
sleep 1

nohup bash -c 'while true; do /root/gmgn-venv/bin/python gmgn.py >> gmgn_bot.log 2>&1; sleep 120; done' >/dev/null 2>&1 &
echo $! > gmgn_bot.pid

echo "GMGN loop started PID: $(cat gmgn_bot.pid)"
