# Dialogue Structure: Multi-Agent Federation (3 tiers, fixed agent names)

Supersedes the single-Pi dialogue model (ADR-0005) for multi-tier deployments.
Each employee can talk to **3 agents**: local / server (Athena) / remote (SAP).

**Context**: Athena evolved from a single-Pi portal to a Multi-Agent Federation
(see docs/distributed-pi-collaboration.md). Dialogue must route among the server
knowledge steward and each employee's local + remote agents.

**Decision**:

1. **Agent identity (fixed names)**: every agent has a fixed namespaced name.
   - Server knowledge steward = `Athena`.
   - Employee's agent = `{employee}::{agent}` (e.g. `zhang.wei::Hermes`, `zhang.wei::PiB`).
2. **Routing** (per employee, 3 agents):
   - Knowledge / team / general → server `Athena`.
   - Local development / own code → local agent (`{e}::<local>`).
   - External codebase (SAP) → remote Pi (`{e}::PiB`).
3. **Conversation presentation**:
   - Private chat default = local agent; knowledge → `Athena`; SAP → `@PiB` / SAP session.
   - UI labels each agent by fixed name; agent↔agent sub-replies rendered source-labeled.
4. **Agent abstraction**: local agent is NOT required to be Pi (Hermes / Claude Code /
   Codex / any) as long as it implements the unified server interface.

**Consequences**:
- Conversation routing needs an intent/agent resolver in the portal backend.
- Agent names must be validated/unique in the server (naming convention).
- The server knowledge steward is consistently `Athena` across the federation.
- Local/remote agents must implement the unified HTTP/MCP interface to be routable.

**Status**: Accepted (design). Implemented in M6.
