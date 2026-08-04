# Node/TS + Fastify + AgentSession 内嵌 Pi

门户后端用 Node.js/TypeScript + Fastify，通过 `AgentSession`（`@earendil-works/pi-coding-agent`）进程内嵌 Pi，而非 spawn 子进程走 RPC。

**背景**: Pi 是纯 TS 项目，官方推荐 `AgentSession` 内嵌（`src/core/agent-session.ts`）。Python 只能 spawn 子进程走 RPC JSONL，是二等公民。

**决策**: Node/TS + Fastify 后端，AgentSession 内嵌 Pi。每员工一个常驻实例。

**后果**: 后端必须 Node.js；门户后端与 Pi 引擎同进程；复用 Pi 的 8 个 npm 扩展。
