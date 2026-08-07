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

A. **Agent Registry = independent Spec.** ✓ confirmed
B. **Workbench 3-panel page**: Chat | Repo tree | Kanban. Kanban is NOT a separate
   panel — fold it into the Workbench page achieving the 3-panel effect. **Open UX
   question: multiple conversations.** A user does not have only one conversation:
   - private chat with their own agent
   - participate in multi-user conversations
   - Workbench conversation
   How to present this dynamically (modern pattern for many live conversations)?
   → **RESOLVED: unified conversation list + type labels (Teams-style).** Use the
     long sidebar as a conversation list (like Teams/Slack channels). Each
     conversation is a first-class entity with a **type**: private (own agent) /
     multi-user / Workbench. Click any → opens its message stream. A **Workbench**
     conversation additionally renders the 3-panel layout (Chat | Repo tree | Kanban).
     Modern niceties: dynamic create/delete, unread markers, search.
C. **Employee login + RBAC in G3** (since it shares the agent registry), but as a
   **separate Spec**.
D. **soul roles (Consultant/PM/EngD/Reviewer/Writer)** belong to **git-driven
   development** — kept separate from the agent-channel work in G3. (soul-driven
   dev is a distinct concern, not part of the multi-agent federation channel.)

## 4.1 GitHub integration (per-user credentials)

GitHub visibility is driven by **the signed-in user's own GitHub credential**
(SSH key or token) provided at platform registration. The Workbench repo tree /
PR / Issue views render only the repos **that user can see** (their permission
scope). This keeps GitHub auth per-user rather than a shared service account.

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
