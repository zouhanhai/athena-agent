---
id: g2_s2
title: "G2.S2: llm_wiki Service Deployment"
layer: S
parent: G2
owner: eng-director
status: active
milestone: M2
acceptance_criteria:
  - "llm_wiki (nashsu/llm_wiki) running headless on 6900XT"
  - "Provides HTTP API (127.0.0.1:19828)"
  - "Can read Markdown from shared input-dir and generate wiki pages"
  - "Has hybrid retrieval (keyword + vector) capability"
  - "Service bound to 0.0.0.0 for Tailscale access"
  - "Rust/Cargo installed and successfully compiled"
---

# G2.S2: llm_wiki Service Deployment

## Task

Deploy llm_wiki service (Karpathy-style wiki knowledge base) on 6900XT.

## Key Dependencies

- Rust/Cargo (needs install, not yet on 6900XT)
- Xvfb (headless display, already on 6900XT)
- DeepSeek API (for wiki page generation)

## Implementation

1. **Install Rust**: rustup install stable (Rust/Cargo)
2. **Clone & Compile**: nashsu/llm_wiki (Tauri application)
   - Compile Rust backend (includes tiny_http :19828 + MCP server)
3. **Headless run**: Use Xvfb (xvfb-run) to start, providing :19828 API
   - Even without GUI, background runs Rust backend providing HTTP API
4. **Configure**:
   - Data directory (wiki md files + index)
   - Read Markdown from shared input-dir to generate wiki pages
   - DeepSeek LLM configuration
5. **Verify**:
   - :19828 API accessible (health check)
   - Ingest Markdown → generate wiki pages
   - Keyword retrieval (wiki_search equivalent) usable
   - MCP server whether exposes retrieval tools (confirm)
6. **Service binding**: 0.0.0.0 (for Tailscale)

## Reference

- Spec: `docs/kanban/G2/Goal.md`
- Design: `docs/knowledge-rag-design.md`
- ADR: `docs/adr/0004-llm-wiki-service.md`
- 6900XT: requires SSH operation

## How to Locate Reference Docs

- `parent: G2` → `docs/kanban/G2/Goal.md`
- ADR-0004: `docs/adr/0004-llm-wiki-service.md`

## Notes

- llm_wiki is a Tauri desktop app, frontend cannot be web iframe → backend calls API, frontend custom renders
- Core value: hybrid retrieval (keyword+vector+graph) + incremental interlinked wiki generation
- **Risk**: headless running + Rust compilation are main verification points
- Use **implement** + tdd (verification scripts) + code-review

## Dependencies

- None (can parallel with G2.S1)

## Log

### 2026-08-05 — S2 deployed (T1+T2 done)

- Rust 1.97.1 installed; nashsu/llm_wiki compiled in Docker builder (host lacks webkit2gtk dev pkgs + passwordless sudo) → `~/llm_wiki-dist/llm-wiki` (66MB).
- Running headless via `xvfb-run`, bound `0.0.0.0:19828` (env `LLM_WIKI_BIND_HOST=0.0.0.0`), detached.
- LLM = OpenRouter `https://openrouter.ai/api/v1` (`api.openrouter.ai` DNS broken on this network) + `deepseek/deepseek-v4-flash`, key from `~/.bashrc`.
- Verified: health, projects, rescan/ingest, LLM wiki page generation (interlinked), keyword search, graph, MCP `tools/list` retrieval tools.
- Data: project `~/athena-data/wiki` (+ `~/athena-data/input` shared input-dir). Config: `~/.local/share/com.llmwiki.app/app-state.json`.
