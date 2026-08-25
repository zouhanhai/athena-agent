#!/usr/bin/env bash
# monitor-ticket.sh — Eng-Director-side ticket monitor for OpenCode workers (6900XT).
# Polls a ticket's status + the worker session; auto-wakes a STALLED worker and reports completion.
# Lifecycle bound to ONE ticket: start on dispatch, exits on done/approved/failed/rejected.
#
# Usage: monitor-ticket.sh <ticket-path> <session-id> [interval-secs=60] [stall-threshold-secs=300]
set -u

TICKET="${1:?ticket path required}"
SID="${2:?session id required}"
INTERVAL="${3:-60}"
STALL="${4:-300}"
BASE="http://127.0.0.1:4096"
LOGFILE="/tmp/monitor-$(basename "$(dirname "$TICKET")")-$(basename "$TICKET" .md).log"

log(){ echo "[$(date '+%H:%M:%S')] $*" >> "$LOGFILE"; echo "[$(date '+%H:%M:%S')] $*"; }
status(){ grep -E '^status:' "$TICKET" | head -1 | sed 's/^status:[[:space:]]*//'; }
last_update_ms(){ curl -s -m 10 "$BASE/session/$SID" 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); t=d.get("time",{}); print(t.get("updated",0))' 2>/dev/null || echo 0; }
wake(){
  local msg="You are working on $(basename "$TICKET"). Your session has had no new output for over ${STALL}s. STOP and TAKE ACTION: if in_progress, continue toward completion (run tests, commit, mark done). Do not keep silently reasoning."
  local payload="{\"parts\":[{\"type\":\"text\",\"text\":$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$msg")}]}"
  curl -s -m 20 -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' -d "$payload" 2>/dev/null
}

log "monitor start: $TICKET (sid=$SID, every ${INTERVAL}s, stall=${STALL}s)"
WOKE_TIME=0
while true; do
  ST=$(status)
  NOW_MS=$(($(date +%s%N)/1000000))
  LAST_MS=$(last_update_ms)
  AGE=$(( (NOW_MS - LAST_MS) / 1000 ))
  if [ "$ST" = "done" ] || [ "$ST" = "approved" ] || [ "$ST" = "failed" ] || [ "$ST" = "rejected" ]; then
    log "FINAL status=$ST — exiting."
    break
  fi
  if { [ "$ST" = "in_progress" ] || [ "$ST" = "backlog" ]; } && [ "$LAST_MS" != "0" ] && [ "$AGE" -gt "$STALL" ] && [ "$(date +%s)" -gt "$WOKE_TIME" ]; then
    CODE=$(wake)
    log "STALLED (${AGE}s no update). Sent wake -> HTTP $CODE"
    WOKE_TIME=$(date +%s)
  else
    log "status=$ST session-age=${AGE}s"
  fi
  sleep "$INTERVAL"
done
