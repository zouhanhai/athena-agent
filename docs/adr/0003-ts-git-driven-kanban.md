# Kanban Rewritten in TS, Pi-Driven (git-driven)

Do not use the existing Python Kanban. Reimplement in TypeScript within the portal, with Pi driving task state transitions.

**Context**: The existing Kanban is written in Python (hermes-opencode-template), single-machine SQLite. But athena requires 3 employees + 3 Pis collaborating across machines, coordinated via GitHub markdown state.

**Decision**: Completely rewrite as a git-driven kanban (`docs/kanban/*.md` is the source of truth), implemented in TS. Combine pi-task / pi-goal-list-loop-audit / pi-dynamic-workflows to let Pi auto-decompose / audit / execute in parallel.

**Consequences**: The Kanban must be reimplemented (significant effort), but in return this yields Pi-driven automation + natural cross-machine multi-user collaboration.
