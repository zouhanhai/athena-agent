# Wiki using llm_wiki Service + Custom Frontend

The Wiki panel uses nashsu/llm_wiki as a service (:19828 HTTP API + MCP). The portal backend calls its API to fetch wiki data; the frontend renders it with Vue (CALEO style).

**Context**: A "Wiki accumulation" capability is needed (Karpathy pattern: LLM incrementally generates interlinked markdown wikis). Candidates include nashsu/llm_wiki desktop app, nvk/llm-wiki CLI, and WeKnora's built-in agent.

**Decision**: Use nashsu/llm_wiki. Although it is a Tauri desktop app, it exposes an independent HTTP API (tiny_http, :19828) + MCP server, with complete data capabilities (hybrid retrieval: keyword + vector + graph). Its frontend is desktop-only and cannot be iframed on the web, so the frontend must be custom-built.

**Consequences**: Must verify llm_wiki can run headless (6900XT has Xvfb for virtual display); Rust compilation required; the frontend must implement a custom Wiki browsing UI (CALEO style).
