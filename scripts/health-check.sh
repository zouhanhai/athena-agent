#!/usr/bin/env bash
# =============================================================================
# Athena Agent — Service Health Monitor (6900XT)
# -----------------------------------------------------------------------------
# One-shot status of all athena services. Run manually:
#     bash scripts/health-check.sh
# Or in a loop to watch for flapping:
#     watch -n 10 bash scripts/health-check.sh
# Exit code 0 = all healthy, 1 = at least one down.
# =============================================================================
set -u

HOST="192.168.178.30"
FAIL=0

check() {
  local name="$1" url="$2"
  local code
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$url" 2>/dev/null)
  if [ "$code" = "200" ]; then
    printf '  \033[32mOK\033[0m   %-14s %s (200)\n' "$name" "$url"
  else
    printf '  \033[31mDOWN\033[0m %-14s %s (http=%s)\n' "$name" "$url" "${code:-no-resp}"
    FAIL=1
  fi
}

check_port() {
  local name="$1" port="$2"
  if ss -tlnp 2>/dev/null | grep -q ":$port "; then
    printf '  \033[32mOK\033[0m   %-14s :%s (listening)\n' "$name" "$port"
  else
    printf '  \033[31mDOWN\033[0m %-14s :%s (not listening)\n' "$name" "$port"
    FAIL=1
  fi
}

echo "Athena Agent — service health @ $(date '+%Y-%m-%d %H:%M:%S')"
echo "------------------------------------------------"
check       "LightRAG"   "http://$HOST:9621/health"
check_port  "llm_wiki"   "19828"
check_port  "athena-back" "3000"
check_port  "Vite"       "5173"
echo "------------------------------------------------"

if [ "$FAIL" = "0" ]; then
  echo "All services healthy ✓"
  exit 0
else
  echo "One or more services DOWN ✗  (logs in ~/.athena-tmp/)"
  exit 1
fi
