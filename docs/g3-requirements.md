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

   → **SUPERSEDED (2026-08-07) — Global single-context Chat panel.** The whole
     layout was redesigned. Key decisions:
   - **Sidebar = pure navigation only** (Knowledge / Wiki / Workbench / Upload /
     Output[future]). Chat is NOT a sidebar item / page.
   - **Chat is a GLOBAL fixed panel on the RIGHT** (content area center, close to
     the sidebar on the left). Switching tabs changes only the center content;
     the chat context NEVER changes — one shared context across all pages.
     Rationale: deepseek LLM cache hit-rate is high and cheap, so a single long
     context is practical and efficient.
   - **Agent cards above the chat** (Athena + other agents/employees can be added).
     Any agent/employee can join the shared conversation.
   - **Uploads is its own tab** (knowledge-base platform: ingest is core). Detail
     of per-system processing stages (docling / LightRAG / llm_wiki) + chunk
     progress, with an Athena-chat integration.
   - **Workbench content area = 3 GitHub-style tabs**, per-user credential:
     [Code] (GitHub-style file tree + code view w/ line numbers + syntax
     highlighting + branch selector) | [Issues] (GitHub-style list) | [Kanban].
   - The global Chat panel also appears on Wiki / Knowledge / Uploads pages, so
     users can ask Athena (server-side knowledge agent) about anything while
     working.
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

**Scope: FULL operation, not just read-only.** The platform can open PRs, edit
files, and merge — the GitHub feature set is integrated (employee watches the
process; it is not purely agent-driven). So the GitHub integration covers browse
(repo tree / PR / Issue) AND mutate (create PR / edit file / merge), scoped to
each user's credential.

## 4.2 Git-Driven Development — platform protocol view (worker-agnostic)

The platform does **not** care whether a worker is a Pi, OpenCode, or any other
code-capable agent. It defines a **protocol** in three layers:

1. **G.S.T board structure (protocol)**
   - The platform fixes the `docs/kanban/Gx/Sx/Tx.md` three-layer markdown
     structure (dir naming, frontmatter, state machine). Already defined in
     `gdd/docs/design.md` and used by G1/G2.

2. **Planning-agent onboarding protocol (how to plan)**
   - Tells a planning agent how to produce the three layers:
     `grill → to-spec → to-ticket` (matt pocock skills / soul roles:
     Consultant → PM → Eng Director).
   - Output = the md files under `docs/kanban/`.
   - The platform can then **construct the kanban view by scanning the repo's
     `docs/` folder** (parse the md → board).

3. **Code-agent claiming/reporting protocol (how to take & finish a ticket)**
   - **The worker claims the ticket ITSELF via git (claim lock / git push)** —
     the existing `gdd/docs/design.md` mechanism is unchanged. The planning
     agent does NOT claim on the worker's behalf.
   - The planning agent's role is **notification / dispatch**: it tells a worker
     which ticket to take. The worker then does its own git claim-lock push.
     ```
     Planning agent (creates G.S.T md)
        │  notify "take G1.S1.T2"      (dispatch / scheduling)
        ▼
     Worker agent → git claim lock    (worker pushes its own claim; git = mutex)
        │  report done / in_review
        ▼
     Planning agent (receives report, updates kanban md if needed)
     ```
   - How a code agent **reports completion** (state → done/in_review, PR number, log).
   - How it **talks to the planning agent** (handoff / interface).

4. **Full 6-role lifecycle + state machine** (S6 covers the whole git-driven flow,
   not just claim/report):
   - Roles (each has a **soul**):
     | Role | Duty | Stage |
     |------|------|-------|
     | Consultant | grill requirements | pre-plan |
     | PM | to-spec (Goal → Spec) | planning |
     | Eng Director | to-ticket (Spec → tickets); re-decompose on reject | planning + rework |
     | Worker (any code agent) | implement, claim, report | execution |
     | Reviewer | review done tickets → approve/reject | review |
     | Writer | docs / PR description / deliverables | wrap-up |
   - Full state machine:
     ```
     backlog → in_progress → done → in_review → approved (merged)
                           ↘ rejected → Eng Director re-decomposes
                                        → new ticket (T1.1, parent_id) → backlog
     ```
   - Reject flow: Reviewer rejects → Eng Director re-decomposes → new ticket
     (original preserved, `parent_id` + `qa_feedback` + `reopen_reason`).

**Key principle:** worker abstraction — any code-capable agent can join; the
platform only standardizes the md files + git coordination, not the agent runtime.

## 4.3 Vercel Plugin reference (2026-08-07) — agent capability standardization

Vercel's AI-coding-agent plugin (`npx plugins add vercel/vercel-plugin`) is the
industry direction for standardizing agent capabilities across tools (Claude
Code / Codex / Grok / Cursor / Copilot / Kimi). Concepts adopted into our Agent
Registry (G3.S1):

- **Capability declaration standardization**: each agent declares a set of
  **skills** (deep-dive guides it can run) + a **specialty** (like Vercel's
  3 specialist agents: deployment-expert / performance-optimizer / ai-architect).
  Our `capabilities` field extends from `{system, mcp[], tools[]}` to also carry
  `skills[]` + `specialty`.
- **Session-start context injection**: Vercel only injects context when relevant
  (empty dir / detected project). Our global Chat (G3.S3) should **dynamically
  inject the current page's relevant agent capabilities** (Uploads page → ingest
  capabilities; Workbench page → GitHub capabilities; Wiki → knowledge tools)
  rather than always injecting everything.
- **Hooks / lifecycle**: session-start / agent-joined / agent-left hooks so the
  platform can react (e.g. a `knowledge-update` hook refreshes an agent's context
  when knowledge changes).
- **Ecosystem graph**: Vercel's relational knowledge graph maps to our **LightRAG
  knowledge graph** — agents query it for domain context.
- **Standardized registry schema**: a shared agent-registration schema (like a
  plugin manifest) so any agent can register in a uniform way.


## 4.4 Registration model (agent-era, self-declaration + invite) — 2026-08-07

**Agent registration (G3.S1):** when an agent connects, it **auto-fills its
capabilities** by self-declaring against our schema (`POST /api/agents/self-declare`).
But **alias + logo are chosen by the owning employee** (not the agent), so there is a
small **Agent registration UI** where the employee reviews the agent's self-declared
capabilities and assigns alias + logo + confirms. No manual capability entry.

**Employee registration (G3.S2):** **invitation-based** — the platform sends an
invitation email (Resend); the employee clicks through, **associates their own email**
(magic-link verify), fills profile + GitHub key/token (encrypted). Employees are people,
so they get a registration page; agents self-declare.

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
