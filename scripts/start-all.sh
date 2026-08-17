#!/usr/bin/env bash
# =============================================================================
# Athena Agent — Start All Services (6900XT)
# -----------------------------------------------------------------------------
# Idempotent startup for the athena knowledge-base stack. Safe to re-run:
# each service only starts if its port is not already in use.
#
# Services (ports):
#   1. Neo4j     :7687   (self-built RAG graph, G4.S2)
#   2. llm_wiki  :19828  (wiki API server; clip server :19827)
#   3. athena-back:3000  (Fastify backend, tsx watch)
#   4. Vite front:5173   (Vue3 dev server)
#   5. OpenCode  :4096   (kanban worker serve; cd to athena-agent so plugin loads)
#   6. llama-server :9632 (cross-encoder rerank, BGE-Reranker-v2-M3)
#
# llm_wiki: Tauri desktop app, must run under Xvfb (virtual display :99).
#   Data dir remembered in app-state.json (~/.local/share/com.llmwiki.app),
#   project root = ~/athena-data/wiki.
# =============================================================================
set -u

USER_HOME="$HOME"
LLM_WIKI_BIN="/home/hh/llm_wiki-dist/llm-wiki"
LOG_DIR="$HOME/.athena-tmp"
mkdir -p "$LOG_DIR"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
port_in_use() { ss -tlnp 2>/dev/null | grep -q ":$1 " ; }

# --- 0. Load OPENROUTER_API_KEY (needed by athena-back for docling picture
#        descriptions via parse_doc.py's OpenRouter VLM). The key lives in
#        ~/.bashrc as a base64 command; export the decoded plaintext here so the
#        detached server process inherits it.
load_openrouter_key() {
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    return  # already set
  fi
  local b64
  b64=$(sed -n 's/.*echo \([A-Za-z0-9+/=]\{16,\}\).*base64.*/\1/p' "$HOME/.bashrc" 2>/dev/null | head -1)
  if [ -n "$b64" ]; then
    export OPENROUTER_API_KEY="$(echo "$b64" | base64 -d 2>/dev/null)"
    [ -n "${OPENROUTER_API_KEY:-}" ] && log "Loaded OPENROUTER_API_KEY from ~/.bashrc (decoded)"
  fi
}
load_openrouter_key

# --- 1. Neo4j (RAG graph, G4.S2) -------------------------------------------
# Neo4j 2026 Community in Docker, used by the self-built RAG store.
if port_in_use 7687; then
  log "Neo4j :7687 already running"
else
  log "Starting Neo4j :7687"
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^neo4j-spike$'; then
    setsid docker start neo4j-spike < /dev/null > "$LOG_DIR/neo4j.log" 2>&1 & disown
  else
    setsid docker run -d --name neo4j-spike -p 7687:7687 -p 7474:7474 \
      -e NEO4J_AUTH=neo4j/athena-spike-2026 -e NEO4J_PLUGINS='["apoc"]' \
      neo4j:2025-community < /dev/null > "$LOG_DIR/neo4j.log" 2>&1 & disown
  fi
fi

# --- 2. Xvfb (virtual display for llm_wiki) --------------------------------
if ! pgrep -f "Xvfb :99" > /dev/null 2>&1; then
  log "Starting Xvfb :99"
  setsid Xvfb :99 -screen 0 1280x800x24 < /dev/null > "$LOG_DIR/xvfb.log" 2>&1 & disown
else
  log "Xvfb :99 already running"
fi

# --- 3. llm_wiki -----------------------------------------------------------
if port_in_use 19828; then
  log "llm_wiki :19828 already running"
else
  log "Starting llm_wiki :19828 (DISPLAY=:99)"
  ( cd "$USER_HOME" && DISPLAY=:99 setsid "$LLM_WIKI_BIN" \
    < /dev/null > "$LOG_DIR/llm-wiki.log" 2>&1 & disown )
fi

# --- 4. athena backend -----------------------------------------------------
# Prints the pid of the process bound to :3000 (empty if none).
server_3000_pid() {
  ss -tlnp 2>/dev/null | grep ":3000 " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
}

# True when the process bound to :3000 carries DATABASE_URL (Postgres mode).
# A server started without the env (e.g. memory registry) still binds :3000,
# so port-in-use alone is NOT a healthy signal — check the process env.
server_3000_healthy() {
  local pid
  pid=$(server_3000_pid)
  [ -z "$pid" ] && return 1
  [ ! -r "/proc/$pid/environ" ] && return 1
  tr '\0' '\n' < "/proc/$pid/environ" | grep -q '^DATABASE_URL='
}

start_athena_backend() {
  log "Starting athena backend :3000"
  # Run tsx watch from a detached subshell so SSH disconnect (SIGHUP) can't kill
  # it; export the athena env + load .env.local so the process has everything.
  (
    cd "$HOME/athena-agent/server" || exit 1
    export DATABASE_URL="postgres://hh@/athena?host=/var/run/postgresql"
    export ADMIN_EMAIL="zouha108@caleo.com"
    export APP_BASE_URL="${APP_BASE_URL:-https://athenakb.com}"
    export NEO4J_URI="bolt://localhost:7687"
    export NEO4J_USER="neo4j"
    export NEO4J_PASSWORD="athena-spike-2026"
    # Local secrets (RESEND_API_KEY etc.) load from a git-ignored .env.local
    set -a
    [ -f .env.local ] && . .env.local
    set +a
    setsid nohup npx tsx watch src/index.ts \
      < /dev/null > "$LOG_DIR/athena-server.log" 2>&1 & disown
  ) || true
  # give tsx a moment to bind :3000
  for _ in $(seq 1 15); do port_in_use 3000 && break; sleep 1; done
  if port_in_use 3000; then
    log "athena-back :3000 up"
  else
    log "WARN athena-back :3000 not up yet — check $LOG_DIR/athena-server.log"
  fi
}

if port_in_use 3000; then
  if server_3000_healthy; then
    log "athena-back :3000 already running (healthy)"
  else
    # Exact-pid kill: pattern-matching pkill can miss a process that doesn't
    # share the tsx command line (env-less node, python placeholder, etc.).
    local_badpid=$(server_3000_pid)
    log "athena-back :3000 running but UNHEALTHY (missing DATABASE_URL) — killing pid ${local_badpid:-?} and restarting"
    [ -n "$local_badpid" ] && kill "$local_badpid" 2>/dev/null || true
    # tsx watch spawns a parent npm/sh wrapper; pkill the whole chain as well.
    pkill -f 'tsx watch src/index.ts' 2>/dev/null || true
    for _ in $(seq 1 10); do port_in_use 3000 || break; sleep 1; done
    if port_in_use 3000; then
      log "WARN :3000 still in use after kill — refusing to start a second instance"
    else
      start_athena_backend
    fi
  fi
else
  start_athena_backend
fi

# --- 5. Vite frontend ------------------------------------------------------
if port_in_use 5173; then
  log "Vite :5173 already running"
else
  log "Starting Vite :5173"
  ( cd "$HOME/athena-agent/web" && setsid npm run dev \
    < /dev/null > "$LOG_DIR/vite.log" 2>&1 & disown )
fi

# --- 6. OpenCode serve (Kanban worker) -------------------------------------
OPENCODE_PORT="${OPENCODE_PORT:-4096}"
if port_in_use "$OPENCODE_PORT"; then
  log "OpenCode serve :$OPENCODE_PORT already running"
else
  log "Starting OpenCode serve :$OPENCODE_PORT"
  # cd to the athena-agent repo root so the worker plugin (.opencode/plugins/) loads.
  # Load the athena .env.local (DATABASE_URL / GITHUB_TOKEN / GITHUB_EMPLOYEE) so
  # the worker plugin's auto-sync (resolveGithubCredential → Postgres employee
  # store / GITHUB_TOKEN) can actually resolve a GitHub credential (G4.S5.T14).
  # Use `setsid nohup ... & disown` (NOT `disown -a`) so SSH disconnect can't kill it.
  ( cd "$HOME/athena-agent" && \
    export DATABASE_URL="postgres://hh@/athena?host=/var/run/postgresql" \
    export ADMIN_EMAIL="zouha108@caleo.com" \
    export NEO4J_URI="bolt://localhost:7687" \
    export NEO4J_USER="neo4j" \
    export NEO4J_PASSWORD="athena-spike-2026" \
    export GITHUB_EMPLOYEE="$(grep -oE '^GITHUB_EMPLOYEE=.*' "$HOME/athena-agent/server/.env.local" 2>/dev/null | cut -d= -f2-)" \
    export GITHUB_TOKEN="$(grep -oE '^GITHUB_TOKEN=.*' "$HOME/athena-agent/server/.env.local" 2>/dev/null | cut -d= -f2-)" \
    # NOTE: do NOT redirect stdin to /dev/null — opencode serve 1.18 exits
    # immediately after binding when stdin is EOF. Keep stdin inherited (or a
    # fifo/tty) so it stays up. Verified 2026-08-14.
    setsid nohup opencode serve --port "$OPENCODE_PORT" --hostname 0.0.0.0 \
    > "$LOG_DIR/opencode-serve.log" 2>&1 & disown ) || true
  for _ in $(seq 1 15); do port_in_use "$OPENCODE_PORT" && break; sleep 1; done
  if port_in_use "$OPENCODE_PORT"; then
    log "OpenCode serve :$OPENCODE_PORT up"
  else
    log "WARN OpenCode serve :$OPENCODE_PORT not up yet — check $LOG_DIR/opencode-serve.log"
  fi
fi

# --- 7. llama-server (cross-encoder rerank, G4.S2.T14) ---------------------
# BGE-Reranker-v2-M3 via llama.cpp /rerank endpoint. Optional — retrieval falls
# back to RRF-only if this is down. Models live in llamacpp-rocm/models/ (all
# llama.cpp GGUF: Qwythos LLM, nomic-embed, bge-reranker). HF cache is pointed
# at models/hub so the bge GGUF downloads/loads from there (a user-owned dir —
# the default ~/.cache/huggingface is root-owned after a prior root run).
RERANK_PORT="${RERANK_PORT:-9632}"
if port_in_use "$RERANK_PORT"; then
  log "llama-server rerank :$RERANK_PORT already running"
else
  log "Starting llama-server rerank :$RERANK_PORT"
  mkdir -p "$HOME/llamacpp-rocm/models/hub"
  ( cd "$USER_HOME" && export HF_HOME="$HOME/llamacpp-rocm/models" && \
    setsid /home/hh/llamacpp-rocm/llama-server \
      --hf-repo gpustack/bge-reranker-v2-m3-GGUF:Q8_0 \
      --port "$RERANK_PORT" --rerank --pooling rank --host 0.0.0.0 \
      < /dev/null > "$LOG_DIR/llama-rerank.log" 2>&1 & disown )
fi

log "--- All services launched. Logs in $LOG_DIR ---"
log "Check: Neo4j    http://$(hostname -I | awk '{print $1}'):7474/"
log "Check: Vite     http://$(hostname -I | awk '{print $1}'):5173/"
log "Check: OpenCode bash scripts/monitor-opencode.sh"
log "Check: Rerank  http://$(hostname -I | awk '{print $1}'):$RERANK_PORT/"
