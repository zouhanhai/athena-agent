---
id: s7
title: "G4.S7: Remote agent federation (reverse WebSocket + Cloudflare Tunnel) + KB-as-MCP"
layer: S
parent: G4
owner: consultant
status: in_progress
milestone: M4
acceptance_criteria:
  - "Local agents (remote wts, LAN 6900XT, and the local Hermes) register to the platform via an invitation flow {agent_id, api_url, token}"
  - "Communication is bidirectional over a reverse WebSocket: the agent connects INTO the platform (outbound, works behind NAT/CGNAT); the platform drives it back through the tunnel"
  - "The platform's WebSocket endpoint + public site are exposed via Cloudflare Tunnel on the athenakb.com domain"
  - "Platform Chat panel routes to a selected remote agent's API Server, streaming tool progress (tool.started / tool.completed) into the panel"
  - "Knowledge base exposed as an MCP server (search_knowledge / get_wiki_page / get_graph) so any agent can retrieve company KB"
  - "Agent identity traceable: each agent connects with a unique id + token (invitation-issued); the platform knows which agent is where and how to reach it"
---

# G4.S7: Remote agent federation (reverse WebSocket + Cloudflare Tunnel) + KB-as-MCP

## Background

The AgentIDE vision: users manage remote agents from the platform. Each agent stays LOCAL (tools run on
the agent's machine); the platform is the control plane. Users send commands → forwarded to the right
local agent → agent works locally → streams the process + result back.

**Concrete goal (user, 2026-08-09):** register BOTH
1. the remote **wts** agent, and
2. the **LAN 6900XT** agent
into the platform via the federation, so either can be controlled from the platform.

## Full design

> **Reference (2026-08-10)**: [Avernet](https://github.com/inclusionAI/Avernet) — production-grade
> distributed agent coordination platform (Ant Group, 12 BGs, 90%+ completion). Evaluate vs lean
> federation; see `docs/avernet-reference.md`. Not a required dependency — lean S6 first.

See `docs/knowledge-rag-design.md` §8 (RAG system selection & self-build direction) and the M4

See `docs/knowledge-rag-design.md` + M4 federation items in `TODO.md`. Key points:

- **Reachability**: agents connect INTO the platform's WebSocket endpoint, exposed publicly via **Cloudflare
  Tunnel** (named for stability / quick for testing). **Tailscale is NOT used** (remote wts has no admin).
  Set `APP_BASE_URL` to a reachable address so invite/magic-link URLs open remotely.
- **Architecture**: agents stay local; platform is the control plane. **Agent actively connects INTO the
  platform (outbound, reverse-tunnel style) — WebSocket for bidirectional real-time** (agent initiates the
  WS connection, platform drives it back through the tunnel), HTTP for command/registration. Rationale
  (2026-08-15): agent-outbound connect works behind NAT/CGNAT with no public IP, and matches the AgentIDE
  model where agents register into the platform. See `docs/remote-agent-connectivity.md` for the
  Tailscale vs Cloudflare-Tunnel vs reverse-WebSocket analysis + Helix/Avernet/K3s/OpenClaw references.
- **Invitation onboarding** (like employee invites): admin generates `{agent_id, api_url, token}` →
  hand to the agent → agent registers (auth'd, so the platform knows which agent is where/how to reach it).
- **Chat routing**: platform Chat panel → selected remote agent's API Server (Hermes `/api/sessions/{id}/chat/stream`
  SSE, OpenCode `/global/event`), streaming tool progress into the panel.
- **KB as MCP server**: wrap `KnowledgeRetrievalService` (LightRAG + llm_wiki + semantic) into an MCP server;
  each local agent adds one `mcpServers` entry over the platform's public URL (Cloudflare Tunnel). Bonus: Workbench GitHub + kanban ops as MCP tools.

### KB-as-MCP: topic-scoped search contract for external agents

When building the MCP server, the **topic contract for external agents MUST be documented** so any
MCP client agent (OpenCode/Claude Code/Codex/Hermes) retrieves the KB correctly:

- **Tool**: `search_knowledge(query, topic?)` — `topic` is a wiki frontmatter topic subtree (e.g.
  `internal/events`, `sap`, or `sap/group_reporting`). Omit/empty = whole-corpus search.
- **How an agent chooses `topic`**: the agent's LLM decides the relevant domain(s) from the question
  (topic = Athena's knowledge-navigation: determine topic → converge document domain → search within it).
  The MCP tool description should teach this: "if the question is about a specific domain, pass its
  topic subtree to scope the search; otherwise omit for a whole-corpus search."
- **Sibling tools**: `get_wiki_page(path)` (read a wiki page's content + frontmatter), `get_graph()`
  (knowledge-graph nodes/edges). Retrieval results carry `wikiPath`/`sectionPath` so an agent can
  group chunks by source page and fuse analysis.
- **Auth**: MCP server auth'd (per-employee/agent token); agents reach it over the platform's public URL (Cloudflare Tunnel).
- Alias mapping (G4.S3.T6) + bilingual aliases (G4.S2.T1) apply at query time, so a
  colloquial/cross-language term in `query` still matches canonical text within the scoped topic.
- A2A deferred to M6.

### KB-as-MCP endpoint contract (T3 — DONE 2026-08-16)

The KB MCP server is mounted on the platform's Fastify server (Streamable HTTP, `@modelcontextprotocol/sdk`)
at a single authenticated endpoint reachable over the public URL:

- **Endpoint**: `https://athenakb.com/api/kb/mcp` (Cloudflare Tunnel → `localhost:3000`; `GET/POST/DELETE`).
- **Auth**: every request carries `Authorization: Bearer <platform-session-token>` (a per-employee/agent
  token resolved via the auth service; 401 without a valid token). Any MCP client agent adds ONE entry:

  ```json
  {
    "mcpServers": {
      "athena-kb": {
        "type": "http",
        "url": "https://athenakb.com/api/kb/mcp",
        "headers": { "Authorization": "Bearer <token>" }
      }
    }
  }
  ```

- **The 5 tools** (all wrapping `KnowledgeRetrievalService`, KB-retrieval only — `answer()`/AgenticRAG Q&A
  is A2A, deferred to M6):
  - `search_knowledge(query, topic?)` — fused retrieval (vector + BM25 + graph + topic across the RAG
    store + llm_wiki keyword). `topic` = wiki frontmatter topic subtree; omit/empty = whole-corpus. Results
    carry `wikiPath`/`sectionPath`. Aliases (semantic mappings + bilingual entity variants) applied at
    query time within the scoped topic.
  - `get_wiki_page(path)` — full markdown (frontmatter + body) of one wiki page by its `wikiPath`.
  - `get_graph()` — knowledge-graph nodes/edges.
  - `get_kb_topics()` — every wiki topic subtree (the valid `topic` values for `search_knowledge`).
  - `get_wiki_tree()` — the wiki page tree (structure/navigation, per-page type + topic metadata).

## Dependencies

- **G4.S6 (GDD) — prerequisite**: S7 federates/controls remote agents that run the GDD dev-flow, so GDD
  must be packaged/decoupled first (S6). S7 is deliberately ordered AFTER S6.
- G4.S2 (RAG) for the KB the MCP server wraps.

## Deliverables

- Platform WS endpoint exposed via Cloudflare Tunnel (athenakb.com) + APP_BASE_URL / remote access. (T1) — **DONE (2026-08-15)**: `wss://athenakb.com/ws/agent`, reverse-WebSocket endpoint with handshake + echo; tunnel `athenakb.com/ws/*` → `localhost:3000` (named tunnel `athena-platform`, systemd `cloudflared-athenakb`); verified reachable from outside the LAN.
- Invitation-based agent onboarding + manual register form (S2.T9). (T2)
- Reverse-WebSocket bidirectional connection from agents to the platform (push tasks, stream progress). (T4)
- KB MCP server (search_knowledge / get_wiki_page / get_graph / get_kb_topics / get_wiki_tree). (T3) — **DONE (2026-08-16)**: streamable-HTTP `/api/kb/mcp`, 5 tools wrapping KnowledgeRetrievalService, topic-scoped contract documented, Bearer-token auth, tests green + typecheck clean.
- Integration demo: register real remote + 6900XT agents, chat to each, KB via MCP, identity tracked. (T5)
- Email + password authentication for public sign-in (plus magic-link fallback). (T6)
- Global auth guard: public site pages require login (redirect to /login). (T7)
- Hide the Chat panel for signed-out users (auth guard covers chat, not just page routes). (T8)
