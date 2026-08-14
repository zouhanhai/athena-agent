---
id: g3_s1
title: "G3.S1: Agent Registry"
layer: S
parent: G3
owner: pm
status: done
milestone: M3
acceptance_criteria:
  - "Agent registry stored in Postgres: alias, owner employee, logo, capabilities (system/MCP/tools/skills/specialty), runtime"
  - "Local Athena default declaration: knowledge assistant (llm_wiki + LightRAG, file upload, knowledge-graph Q&A), owl logo"
  - "Logo system: image-gen model generates a consistent-style set of animal logos (owl as reference) + agent self-upload"
  - "CRUD API for agent registration (register/update/query)"
  - "Capabilities shape follows Vercel-inspired standardization: {system, mcp[], tools[], skills[], specialty, description}"
  - "Agent identity usable by other G3 specs (S2/S3/S4/S5)"
---

# G3.S1: Agent Registry

## Task

Build the agent registration system — every agent connecting to Athena declares its identity and capabilities, stored in Postgres. This is the foundation for all other G3 specs (conversations, agent cards, workbench).

**Registration model (agent-era, self-declaration):** when an agent connects to the platform, it **auto-fills its capabilities** by submitting a declaration payload against our schema (`POST /api/agents/self-declare`). However **alias and logo are chosen by the owning employee**, not the agent — so there is a small **Agent registration UI** where an employee reviews the agent's self-declared capabilities, then assigns alias + logo + confirms.

## Key Dependencies

- Postgres (existing) — agent table
- Image-generation model (OpenRouter) — logo generation
- Employee identity (G3.S2) — agent must be owned by an employee

## Architecture

```
Agent (any: local Athena / employee agent / remote WTS)
  → self-declare: POST /api/agents/self-declare
      { capabilities: {system, mcp[], tools[], skills[], specialty}, runtime }
      (agent fills its own capability info automatically)
  → Employee reviews in Agent registration UI: pick alias + logo + confirm
  → stored in PG: agents table (alias, owner, logo, capabilities, runtime)
  → query: GET /api/agents (list, by employee, by alias)
  → capabilities: { system, mcp: [sap/...], tools: [...], skills: [...], specialty }
```

## UI Placement (Decided)

- **Agent registration UI** (one per employee): shows the employee's connected agents with their **self-declared capabilities**, lets the employee pick alias + logo + confirm. (Small dedicated page.)
- Agent cards appear in S4 (chat).

## Implementation

### 1. Agent data model (Postgres)
- `agents` table: id, alias, owner_employee_id, logo_url, capabilities (jsonb), runtime, created_at, updated_at
- **Capabilities shape (Vercel-inspired, §4.3):** `{ system: string, mcp: string[], tools: string[], skills: string[], specialty: string, description: string }`
  - `skills[]`: deep-dive guides/capabilities the agent can run (Vercel 28-skills model)
  - `specialty`: agent's expertise area (Vercel specialist-agent model, e.g. deployment/performance/ai-arch)

### 2. Local Athena default declaration
- Seed a default agent on server start: alias=`Athena`, owner=`system`, logo=`/athena-logo-ai.png` (from `web/public/athena-logo-ai.png`, existing owl logo), capabilities={ system: "athena", mcp: ["lightrag","llm_wiki"], tools: ["file_upload","knowledge_graph_qa"] }

### 3. Logo system
- Image-gen model generates a consistent-style set of animal logos (use owl as reference image, different animals + colors)
- Store generated logos as assets; agents can also self-upload logo

### 4. Agent registration (self-declaration + employee confirms)
- `POST /api/agents/self-declare` — agent submits its own capabilities (auto-fill), no alias/logo yet
- **Agent registration UI** — employee reviews self-declared capabilities, picks alias + logo, confirms → creates the agent
- `POST /api/agents` (register), `PUT /api/agents/:alias` (update capabilities/logo), `GET /api/agents` (list), `GET /api/agents/:alias`
- Agent identity consumed by S2 (archive under employee), S3 (conversation participants), S4 (cards)

## Reference

- Spec: `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` (Agent Registry section + logo system)
- StaffDeck (reference UX): positions/IDs/capability profiles

## How to Locate Reference Docs

- `parent: G3` → `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §1

## Notes

- Agent identity is the single source of truth for "who is speaking" in S3/S4
- Use **implement** + tdd + code-review

## Dependencies

- Postgres (existing), image-gen model (OpenRouter)

## Log
