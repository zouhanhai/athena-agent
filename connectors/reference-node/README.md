# Athena remote-agent connector — reference implementation (Node)

A generic, credential-free reference client for **Athena's reverse-WebSocket agent
protocol**. It is the executable form of the agent-facing protocol summary that
the platform maintains (thinking + tool output replay, `taskReply` contract).

Use it as a starting point for connecting **any** remote agent (Hermes instance,
WTS agent, future sandbox agent) to Athena — not tied to this environment.

## Two layers

This reference node implements the **protocol layer** (Layer 1) — the part that is
reusable by any agent. The **answer-provider** (Layer 2: how the agent actually
*generates* answers) is deliberately pluggable via `generateAnswer()` in
`index.js`.

Currently `generateAnswer()` talks to a local **OpenAI-compatible `/v1/runs`
endpoint** (e.g. a local [Hermes API server](https://hermes-agent.nousresearch.com)
or any Responses-API-compatible brain) and relays its events as the Athena frames.
Replace that one function to use any other model/provider.

## Protocol implemented

Connects OUT to `wss://athenakb.com/ws/agent`, sends a `register` frame, then
implements the self-describing `taskReply` contract the platform returns in the
`registered` frame:

| Athena frame | When emitted |
|---|---|
| `task.start` | task received |
| `delta` | streamed answer text |
| `thinking` | reasoning available |
| `tool.started` / `tool.completed` | tool call progress (completed carries `output` + `status`) |
| `task.complete` / `task.error` | mandatory terminator (echoes `task_id`) |

`task_id` is echoed on every reply (`mustEchoTaskId`). Auto-reconnect with backoff
and ping/pong are handled. The connector also advertises an optional
`maxContextTokens` budget in the register frame so the platform can size the
conversation history it replays.

## Requirements

- Node >= 22 (global `WebSocket` + `fetch`, no npm deps, single file)
- Node 22 has a bundled global WebSocket; on older versions use `--experimental-websocket`.

## Setup

```bash
# 1. Obtain agent credentials from your Athena invite:
#    GET https://athenakb.com/api/agents/onboard?token=<inviteToken>
cp .env.example .env
# edit .env: set ATHENA_AGENT_ID, ATHENA_TOKEN (+ ATHENA_API_URL / ATHENA_API_KEY to point at your answer-provider)

# 2. Run the connector
ATHENA_AGENT_ID=$(grep ATHENA_AGENT_ID .env | cut -d= -f2) \
ATHENA_TOKEN=$(grep ATHENA_TOKEN .env | cut -d= -f2) \
node index.js
```

## Keep it alive (optional, no admin)

`watchdog.sh` restarts `index.js` if it dies, never spawns duplicates, and is
single-instance via a lockfile. Works in WTS / Windows sessions without admin.

```bash
CHECK_SEC=30 ATHENA_AGENT_ID=... ATHENA_TOKEN=... bash watchdog.sh
```

## Wire protocol reference (build-your-own contract)

You do not need this Node file to connect. The protocol is a plain text
WebSocket JSON channel — here is the exact contract so you can implement it in
any language/runtime.

### Endpoint & auth

- **Connect (outbound, reverse WS):** `wss://athenakb.com/ws/agent`
- On open, send one frame:
  ```json
  { "type": "register", "agent_id": "<id>", "token": "<invite token>",
    "maxContextTokens": 200000 }
  ```
- The server replies with `welcome`, then `registered` — which **self-describes**
  the reply contract (`taskReply`) and liveness/reconnect semantics:
  ```json
  { "type": "registered", "agent_id": "<id>", "connectedAt": "<iso>",
    "taskReply": {
      "mustEchoTaskId": true,
      "frames": ["task.start","delta","thinking","tool.started","tool.completed","task.complete","task.error"],
      "terminateWith": ["task.complete","task.error"],
      "idleTimeoutMs": 60000,
      "reconnect": { "inFlightTasks": "server marks task.error; no re-delivery" }
    } }
  ```
  → Trust `taskReply` from the wire; it is the authoritative contract.

### Incoming task (you receive this)

```json
{ "type": "task", "task_id": "<uuid>",
  "payload": { "type": "chat.completions", "messages": [{ "role":"user","content":"hi" }], "task_id":"<uuid>" } }
```

### Reply frames (you send these)

Every reply **must echo** `task_id` (`mustEchoTaskId`); platform silently drops
mismatched/missing ids. A task is finished only by `task.complete` **or**
`task.error` (one is mandatory), else it stays in-flight:

```json
{ "type": "task.start",           "task_id": "<uuid>" }
{ "type": "delta",                "task_id": "<uuid>", "delta": "Hello..." }
{ "type": "thinking",             "task_id": "<uuid>", "thinking": "reasoning text" }
{ "type": "tool.started",         "task_id": "<uuid>", "tool": "terminal", "tool_call_id": "c1" }
{ "type": "tool.completed",       "task_id": "<uuid>", "tool": "terminal", "tool_call_id": "c1",
                                  "status": "ok", "output": "<tool stdout / api body>" }
{ "type": "task.complete",        "task_id": "<uuid>", "content": "final answer" }
{ "type": "task.error",           "task_id": "<uuid>", "error": { "message": "..." } }
```

### Liveness

- Server may send `{ "type":"ping" }` → reply `{ "type":"pong", "agent_id":"<id>" }`.
- If no reply activity within `idleTimeoutMs` (default 60000), the server considers
  the agent idle.
- On any socket drop, reconnect (outbound) and re-register. In-flight tasks are
  marked `task.error` server-side (no re-delivery).

### History/context (what the platform replays on your next task)

Athena owns conversation context. On every `/api/chat`, it resends the full
`messages[]` — including `thinking` on assistant turns and a `{role:"tool"}`
row per tool call carrying the `output`:

```json
[ { "role":"assistant", "content":"The dir has 5 entries.", "thinking":"Let me list it." },
  { "role":"tool",      "content":"total 24\n...", "name":"terminal", "tool_call_id":"c1" },
  { "role":"user",      "content":"now show the biggest file" } ]
```

Below a token budget the history passes through verbatim; beyond it, old turns
are summarized into a system message and the newest ~40 kept verbatim. The agent
is stateless per task — it just relays the `messages[]` it receives into its LLM.

## Layout

```
connectors/reference-node/
├── index.js          # protocol + answer-provider (edit generateAnswer to plug a brain)
├── watchdog.sh       # optional auto-restart, single-instance, no admin
├── .env.example      # env template (no real secrets)
└── README.md
```

## Note on context / long conversations

The platform is the single authority on conversation context: it replays the full
`messages[]` (including `thinking` and tool `output`) on every task, up to a token
budget, summarized beyond it. The connector simply relays what it receives. It
declares its preferred `maxContextTokens` in the register frame so the platform
can size history against the agent's budget.