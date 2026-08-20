#!/usr/bin/env bash
# =============================================================================
# Athena Agent — Dispatch a ticket to the OpenCode serve worker (6900XT)
# -----------------------------------------------------------------------------
# Encapsulates the correct headless-worker dispatch recipe:
#   1. POST /session        → create session (ONLY title — the API ignores
#      `task`/`dir` fields; sending them creates a session with agent=null and
#      NO agent loop starts — this burned us on G4.S7.T12, 2026-08-20)
#   2. POST /session/:id/prompt_async → send the task (HTTP 204 non-blocking;
#      body MUST be {"parts":[{"type":"text","text":"..."}]})
#   3. Verify via /session/status that the worker is busy
#
# Usage:
#   bash scripts/dispatch-opencode.sh <session-title> "<task text>"
#   bash scripts/dispatch-opencode.sh T13 "Implement X" \
#         --agent build --port 4096 --monitor docs/kanban/Gx/Sx/T13.md
#   TASK_FILE=/tmp/prompt.txt bash scripts/dispatch-opencode.sh <title>
#
# Options:
#   --agent <name>     Agent to use (default: build)
#   --port  <port>     OpenCode serve port (default: 4096)
#   --monitor <md>     ticket path → also start monitor-ticket.sh for it
#   --title <t>        overrides positional title
#   --no-verify        skip the post-dispatch busy check
# =============================================================================
set -u

PORT="4096"
AGENT="build"
MONITOR=""
VERIFY="1"

# ---- parse args -------------------------------------------------------------
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --agent)  AGENT="$2"; shift 2 ;;
    --port)   PORT="$2"; shift 2 ;;
    --monitor) MONITOR="$2"; shift 2 ;;
    --no-verify) VERIFY=""; shift 1 ;;
    --title)  TITLE="$2"; shift 2 ;;
    -*) echo "unknown option: $1"; exit 2 ;;
    *) ARGS+=("$1"); shift 1 ;;
  esac
done

TITLE="${TITLE:-${ARGS[0]:-}}"
if [ -z "$TITLE" ]; then
  echo "usage: $0 <session-title> \"<task text>\" [--agent A] [--port P] [--monitor TICKET.md]"
  exit 2
fi
TASK="${ARGS[1]:-}"
TASK_FILE="${TASK_FILE:-}"   # explicit default: --title-only calls must not trip set -u unbound-var
if [ -z "$TASK" ] && [ -n "$TASK_FILE" ] && [ -r "$TASK_FILE" ]; then
  # shellcheck disable=SC2154
  TASK="$(cat "$TASK_FILE")"
fi
if [ -z "$TASK" ]; then
  echo "error: no task text given (2nd positional arg or \$TASK_FILE)"
  exit 2
fi

BASE="http://127.0.0.1:${PORT}"
SID=""

red(){ printf '\033[31m%s\033[0m\n' "$1"; }
grn(){ printf '\033[32m%s\033[0m\n' "$1"; }

# 0. health check
if ! curl -s -m 3 "$BASE/global/health" 2>/dev/null | grep -q '"healthy":true'; then
  red "OpenCode serve not healthy on :$PORT — start it first: bash scripts/start-opencode.sh --port $PORT"
  exit 1
fi

# 1. create session (title only! task/dir are ignored by this endpoint)
CREATE=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"$(echo "$TITLE" | tr -d '"')\"}")
SID=$(python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('id', ''))
except Exception:
    print('')
" <<< "$CREATE")
if [ -z "$SID" ]; then
  red "Failed to create session. Response:"; echo "$CREATE"
  exit 1
fi
grn "session: $SID"

# 2. dispatch the task (async 204, parts[] payload)
BODY=$(python3 -c "
import json, sys
task = sys.stdin.read()
print(json.dumps({'agent': sys.argv[1], 'parts': [{'type': 'text', 'text': task}]}, ensure_ascii=False))
" "$AGENT" <<< "$TASK")
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "$BODY")
if [ "$CODE" != "204" ]; then
  red "prompt_async returned HTTP $CODE (expected 204)"
  exit 1
fi
grn "task queued (204) — worker should start shortly"

# 3. verify busy — POLL (the session may take a moment to appear in /session/status)
if [ -n "$VERIFY" ]; then
  BUSY=0
  for _ in $(seq 1 8); do
    sleep 2
    STATUS=$(curl -s -m 3 "$BASE/session/status")
    if echo "$STATUS" | grep -q "\"$SID\""; then
      if echo "$STATUS" | grep -q "busy"; then
        BUSY=1
        break
      fi
    fi
    # also check the session object itself (agent resolved + tokens moving)
    SDETAIL=$(curl -s -m 3 "$BASE/session/$SID")
    if echo "$SDETAIL" | grep -q '"agent"'; then
      BUSY=1
      break
    fi
  done
  if [ "$BUSY" = "1" ]; then
    grn "verified: session busy (worker executing)"
  else
    red "warning: session not busy after 16s — check: curl $BASE/session/$SID"
  fi
fi

# optional monitor
if [ -n "$MONITOR" ]; then
  if [ -x /home/hh/scripts/monitor-ticket.sh ]; then
    nohup /home/hh/scripts/monitor-ticket.sh "$MONITOR" "$SID" 60 300 \
      > /tmp/monitor-ticket.log 2>&1 &
    grn "monitor-ticket started for $MONITOR (sess $SID)"
  else
    red "monitor-ticket.sh not found on this host — skipping monitor"
  fi
fi

echo "---"
echo "session id: $SID"
echo "agent:      $AGENT"
echo "title:      $TITLE"
exit 0