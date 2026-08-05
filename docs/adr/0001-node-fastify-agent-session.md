# Node/TS + Fastify + AgentSession Embedded Pi

The portal backend uses Node.js/TypeScript + Fastify, embedding Pi in-process via `AgentSession` (`@earendil-works/pi-coding-agent`), rather than spawning a child process over RPC.

**Context**: Pi is a pure TS project, with the officially recommended approach being `AgentSession` embedding (`src/core/agent-session.ts`). Python can only spawn a child process over RPC JSONL and is a second-class citizen.

**Decision**: Node/TS + Fastify backend, AgentSession embeds Pi. One long-lived instance per employee.

**Consequences**: The backend must be Node.js; the portal backend and Pi engine run in the same process; all 8 of Pi's npm extensions are reused.
