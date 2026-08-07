#!/usr/bin/env bash
# =============================================================================
# Athena Agent — OpenCode serve Worker Monitor (6900XT)
# -----------------------------------------------------------------------------
# Checks OpenCode headless server health using its OFFICIAL HTTP API:
#   GET /global/health      -> { healthy, version }   (server liveness)
#   GET /session            -> Session[]               (list worker sessions)
#   GET /session/status     -> { [id]: SessionStatus } (per-session activity)
# Plus local log freshness as a fallback for "stuck worker / no response".
#
# Log:   ~/.local/share/opencode/log/opencode.log   (timestamps UTC)
# Local: CEST = UTC+2  → a UTC line of 12:00 = 14:00 local.
#
# Usage:
#   bash scripts/monitor-opencode.sh                  # one-shot report
#   watch -n 30 bash scripts/monitor-opencode.sh       # periodic
# Exit 0 = healthy, 1 = degraded, 2 = down.
#
# Env overrides:
#   OPENCODE_PORT        server port (default 4096; try 4100 if it was historic)
#   OPENCODE_BASE_URL    full base URL override
#   OPENCODE_SERVER_PASSWORD   if the server uses HTTP basic auth
# =============================================================================
set -u

PORT="${OPENCODE_PORT:-4096}"
BASE="${OPENCODE_BASE_URL:-http://127.0.0.1:${PORT}}"
LOG="${OPENCODE_LOG:-$HOME/.local/share/opencode/log/opencode.log}"
STALE_MIN="${OPENCODE_STALE_MIN:-10}"
NOW_EPOCH=$(date +%s)

red(){ printf '\033[31m%s\033[0m\n' "$1"; }
grn(){ printf '\033[32m%s\033[0m\n' "$1"; }
ylw(){ printf '\033[33m%s\033[0m\n' "$1"; }
CURL_AUTH=()
[ -n "${OPENCODE_SERVER_PASSWORD:-}" ] && CURL_AUTH=(-u "opencode:${OPENCODE_SERVER_PASSWORD}")

echo "OpenCode server monitor @ $(date '+%Y-%m-%d %H:%M:%S %Z')  (API $BASE)"
echo "------------------------------------------------"
DEGRADED=0; DOWN=0

# ---- 1. official health endpoint ------------------------------------------
HEALTH=$(curl -s -m 5 "${CURL_AUTH[@]}" "$BASE/global/health" 2>/dev/null)
if [ -n "$HEALTH" ] && echo "$HEALTH" | grep -q '"healthy":true'; then
  VER=$(echo "$HEALTH" | grep -oE '"version":"[^"]*"' | cut -d'"' -f4)
  grn "  OK    /global/health -> healthy (version ${VER:-?})"
else
  # fall back to port-listening check
  if ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
    ylw "  WARN  port :$PORT listening but /global/health not healthy: $HEALTH"
    DEGRADED=1
  else
    red "  DOWN  opencode serve not reachable on $BASE"
    DOWN=1
  fi
fi

# ---- 2. session status (worker activity) ----------------------------------
SESSIONS=$(curl -s -m 5 "${CURL_AUTH[@]}" "$BASE/session/status" 2>/dev/null)
if [ -n "$SESSIONS" ]; then
  CNT=$(echo "$SESSIONS" | grep -oE '"[a-zA-Z0-9_-]{20,}"' | wc -l)
  if [ "$CNT" -gt 0 ]; then
    grn "  OK    $CNT active session(s) reported by /session/status"
  else
    ylw "  INFO  no active sessions (idle server is fine)"
  fi
  # print per-session state compactly
  echo "$SESSIONS" | grep -oE '"[a-zA-Z0-9_-]{20,}":\{"[^}]*' | head -20 \
    | sed 's/^/        /' || true
else
  ylw "  WARN  /session/status returned nothing (server may still be warming up)"
  DEGRADED=1
fi

# ---- 3. log freshness (stuck-worker fallback) -----------------------------
if [ -f "$LOG" ]; then
  TS=$(tail -n 1 "$LOG" | grep -oE 'timestamp=[0-9T:.Z-]+' | head -1 | cut -d= -f2)
  if [ -n "$TS" ]; then
    LAST=$(date -d "${TS/Z/+00:00}" +%s 2>/dev/null || echo 0)
    AGE=$(( NOW_EPOCH - LAST ))
    if [ "$AGE" -gt $(( STALE_MIN * 60 )) ]; then
      ylw "  STUCK log idle ${AGE}s (>${STALE_MIN}m) — worker may be hung"
      DEGRADED=1
    else
      grn "  OK    log fresh (${AGE}s ago)"
    fi
  else
    ylw "  WARN  no timestamp in last log line"
  fi
else
  ylw "  WARN  no log at $LOG (server may use in-memory logs)"
fi

# ---- 4. summary -----------------------------------------------------------
echo "------------------------------------------------"
if [ "$DOWN" -eq 1 ]; then
  red "VERDICT: DOWN — restart with: bash scripts/start-opencode.sh"
  exit 2
elif [ "$DEGRADED" -eq 1 ]; then
  ylw "VERDICT: DEGRADED — inspect /global/event or ~/.local/share/opencode/log/opencode.log"
  exit 1
else
  grn "VERDICT: HEALTHY"
  exit 0
fi
