# G3 (M3) — Multi-Agent Federation & Team Collaboration — Requirements

> Live requirements capture (2026-08-07). This is the **input** to the G3 Goal/Spec
> decomposition — treat it as the source of truth for what G3 must build.
> Reference implementation: **OpenBMB/StaffDeck** (enterprise digital-employee platform:
> positions, employee IDs, capability profiles, work records) — https://github.com/OpenBMB/StaffDeck

## 1. Agent Registry (multi-agent identity)

Every agent that connects to Athena **declares itself**:

| Field | Example |
|-------|---------|
| `alias` (代号) | `Athena`, `zhang.wei::Hermes` |
| owner employee | `zhang.wei` |
| logo | generated animal logo or self-uploaded |
| capabilities | which systems it can reach, which MCPs it is wired to (e.g. SAP), which tools |
| runtime | local laptop / remote WTS / server |

**Default local Athena agent declaration (knowledge assistant):**
- Connects directly to **llm_wiki** + **LightRAG**
- Can process uploaded files
- Answers user questions about the knowledge graph / knowledge base
- Logo: the generated **owl** logo

**Logo system:**
- Generate a set of animal logos (different animals, different colors, but **consistent style**)
  as ready-made options for other agents
- Each agent can also upload its own logo

**Storage:** dedicated registry, e.g. in **PostgreSQL**.

## 2. Agent-aware Conversation UI

- Above the chat message area, add a region where the user can **pick agents to add
  into the conversation**.
- Each added agent shows as a **card** (display style inspired by StaffDeck):
  one card per agent.
- Joining the conversation = that agent **sees the conversation context**.
- Each card has a **toggle / slider** controlling whether that agent is allowed to **speak**.
- In the message stream, each chat bubble shows the **speaker's logo** so you can tell
  which agent (or employee) said it.

**Multi-agent collaboration mechanics (who @-mentions whom, whether all agents can
chat with each other) is deliberately deferred to a later milestone.**

## 3. Employee login + identity

- Each Caleo employee logs in (email) and states **who they are** + picks a **logo**.
- Enables **RBAC** (role-based access control) per employee.
- Agents are **archived / grouped under each employee**.

## 4. Open design decisions for G3 Goal decomposition (to confirm)

A. Is the Agent Registry its own Spec, or folded into the team-conversation Spec?
B. The 3-column workbench (Chat | Repo tree | Kanban) — new page, or refactor existing pages?
C. Does multi-agent *parallelism* belong in G3 or stay in M4?
D. Where do the "soul" roles (Consultant/PM/EngD/Reviewer/Writer) live — Hermes profiles,
   OpenCode agent config, or Pi capability?

## 5. StaffDeck reference notes (OpenBMB)

- Digital employees with **positions, employee IDs, capability profiles, work records**
- **State-machine-driven procedural skills**: NLP → structured SOPs, executed via state
  machines; real-time flow switching, context preservation, visual editing, versioning
- **Document-structure-aware knowledge retrieval**: navigable indexes (documents/chapters/
  pages/summaries), "estimate where info resides → locate original text"
- **Autonomous execution**: HTTP APIs, MCP, scheduled tasks; long-term memory, traces,
  human takeover, feedback
- License AGPL-3.0. Built by ModelBest + THUNLP + OpenBMB. Open-sourced 2026-07-15.
- Not a dependency — a **UX/architecture reference**.
