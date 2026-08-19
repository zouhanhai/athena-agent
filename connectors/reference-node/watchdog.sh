#!/usr/bin/env bash
# Watches the reference-node connector and restarts it if it dies.
# WTS/no-admin friendly: uses wmic to count real node.exe processes running
# index.js (robust vs MSYS pid mangling), never spawns duplicates (>=1 = ok).
# Single instance via lockfile. No secrets.
#
# Usage:   CHECK_SEC=30 ATHENA_AGENT_ID=... ATHENA_TOKEN=... bash watchdog.sh
# The connector reads env itself (set them when you start THIS script, and it
# passes its own environment to the child).

set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="index.js"
LOCKFILE="$DIR/.watchdog.lock"
CHECK_SEC="${CHECK_SEC:-30}"
LOGFILE="$DIR/watchdog.log"

log() { echo "[$(date -Iseconds)] $*" >> "$LOGFILE"; }

count_connectors() {
  wmic process where "name='node.exe'" get ProcessId,CommandLine 2>/dev/null \
    | grep -i "index.js" | grep -i "athena\|reference-node" | grep -v "^$" | wc -l
}

if [ -f "$LOCKFILE" ]; then
  LP=$(cat "$LOCKFILE" 2>/dev/null)
  if [ -n "$LP" ] && kill -0 "$LP" 2>/dev/null; then
    echo "watchdog already running (pid $LP). Exiting."; exit 0
  fi
  echo "stale lock $LP -> taking over"
fi
echo $$ > "$LOCKFILE"
log "watchdog started (check every ${CHECK_SEC}s) pid=$$"

spawn() {
  cd "$DIR" && nohup node "$SCRIPT" >> "$LOGFILE" 2>&1 &
  disown 2>/dev/null || true
  log "spawned connector (bash bg pid $!)"
}

if [ "$(count_connectors)" -lt 1 ]; then spawn; fi

while true; do
  N=$(count_connectors)
  if [ "$N" -lt 1 ]; then log "connector count=$N -> spawning"; spawn;
  else log "connector alive (count=$N)"; fi
  sleep "$CHECK_SEC"
done