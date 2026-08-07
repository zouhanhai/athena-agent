#!/usr/bin/env bash
# =============================================================================
# Athena Agent — Start All Services (6900XT)
# -----------------------------------------------------------------------------
# Idempotent startup for the athena knowledge-base stack. Safe to re-run:
# each service only starts if its port is not already in use.
#
# Services (ports):
#   1. LightRAG   :9621   (knowledge graph + retrieval, Postgres/pgvector)
#   2. llm_wiki   :19828  (wiki API server; clip server :19827)
#   3. athena-back:3000   (Fastify backend, tsx watch)
#   4. Vite front:5173    (Vue3 dev server)
#
# LightRAG prerequisite: the uv tool env needs asyncpg + pgvector (install once):
#   /home/hh/.local/bin/uv pip install --python \
#     /home/hh/.local/share/uv/tools/lightrag-hku/bin/python asyncpg pgvector
#
# llm_wiki: Tauri desktop app, must run under Xvfb (virtual display :99).
#   Data dir remembered in app-state.json (~/.local/share/com.llmwiki.app),
#   project root = ~/athena-data/wiki.
# =============================================================================
set -u

USER_HOME="$HOME"
LIGHTRAG_BIN="/home/hh/.local/share/uv/tools/lightrag-hku/bin/lightrag-server"
LLM_WIKI_BIN="/home/hh/llm_wiki-dist/llm-wiki"
LOG_DIR="$HOME/.athena-tmp"
mkdir -p "$LOG_DIR"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
port_in_use() { ss -tlnp 2>/dev/null | grep -q ":$1 " ; }

# --- 1. LightRAG -----------------------------------------------------------
if port_in_use 9621; then
  log "LightRAG :9621 already running"
else
  log "Starting LightRAG :9621"
  cd "$HOME/lightrag"  # must cd here so .env loads
  setsid "$LIGHTRAG_BIN" --host 0.0.0.0 --port 9621 \
    < /dev/null > "$LOG_DIR/lightrag-server.log" 2>&1 & disown
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
if port_in_use 3000; then
  log "athena-back :3000 already running"
else
  log "Starting athena backend :3000"
  ( cd "$HOME/athena-agent/server" && setsid npm run dev \
    < /dev/null > "$LOG_DIR/athena-server.log" 2>&1 & disown )
fi

# --- 5. Vite frontend ------------------------------------------------------
if port_in_use 5173; then
  log "Vite :5173 already running"
else
  log "Starting Vite :5173"
  ( cd "$HOME/athena-agent/web" && setsid npm run dev \
    < /dev/null > "$LOG_DIR/vite.log" 2>&1 & disown )
fi

log "--- All services launched. Logs in $LOG_DIR ---"
log "Check: LightRAG http://$(hostname -I | awk '{print $1}'):9621/health"
log "Check: Vite     http://$(hostname -I | awk '{print $1}'):5173/"
