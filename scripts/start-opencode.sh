#!/usr/bin/env bash
# =============================================================================
# Athena Agent — Start / Restart OpenCode serve (6900XT)
# -----------------------------------------------------------------------------
# Starts a headless OpenCode server (the athena Kanban worker). Official default
# port is 4096; the project historically used 4100. Use OPENCODE_PORT to pick.
# Idempotent: if a server is already healthy on the port, it does nothing.
#
# Usage:
#   bash scripts/start-opencode.sh            # start (or keep) server on :4096
#   OPENCODE_PORT=4100 bash scripts/start-opencode.sh
#   bash scripts/start-opencode.sh --restart  # force kill + restart
#
# Logs go to ~/.athena-tmp/opencode-serve.log. Monitor with:
#   bash scripts/monitor-opencode.sh
# =============================================================================
set -u

PORT="${OPENCODE_PORT:-4096}"
LOG_DIR="$HOME/.athena-tmp"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/opencode-serve.log"
BASE="http://127.0.0.1:${PORT}"

red(){ printf '\033[31m%s\033[0m\n' "$1"; }
grn(){ printf '\033[32m%s\033[0m\n' "$1"; }

# optional forced restart
if [ "${1:-}" = "--restart" ]; then
  echo "Restarting OpenCode serve (killing existing on :$PORT)..."
  pkill -f "opencode serve.*--port $PORT" 2>/dev/null
  pkill -f "opencode serve.*--port $PORT" 2>/dev/null
  sleep 2
fi

# idempotent: already healthy?
if curl -s -m 3 "$BASE/global/health" 2>/dev/null | grep -q '"healthy":true'; then
  grn "OpenCode serve already healthy on :$PORT — nothing to do."
  exit 0
fi

echo "Starting OpenCode serve on :$PORT ..."
# start in a detached session; logs captured for the monitor script
setsid opencode serve --port "$PORT" --hostname 0.0.0.0 \
  < /dev/null > "$LOG" 2>&1 & disown

# wait for health
for i in $(seq 1 20); do
  sleep 2
  if curl -s -m 3 "$BASE/global/health" 2>/dev/null | grep -q '"healthy":true'; then
    grn "OpenCode serve healthy on :$PORT (after ${i}s)."
    exit 0
  fi
done

red "OpenCode serve did not become healthy on :$PORT within 40s. See $LOG"
exit 1
