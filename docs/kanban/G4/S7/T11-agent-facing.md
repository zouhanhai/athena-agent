# WS Protocol Changes — Full-Transfer Remote Chat History (G4.S7.T11)

> Status: **shipped on platform side** (commit `2e9598c`, on both remotes).
> This document is for the **remote agent connector** (wts-side) so it can
> emit the new optional fields. All changes are **additive**:
> `protocolVersion` stays `1`, old frames keep working.

## 1. Why

Athena's remote chat previously replayed only the final assistant answer text
(`{role, content}`) back to the remote agent on the next turn. Thinking and
tool progress were rendered in the UI but dropped from history. We aligned
with Hermes' own full-history replay: assistant turns now also carry their
**reasoning/thinking**, and tool runs carry their **actual output content**.

**Division of responsibility:**
- **Athena platform** = deliver the data (thinking + tool output) as part of
  the next task's messages. It does NOT pad/strip `reasoning_content` — that
  is the remote agent runtime's provider policy (exactly like Hermes'
  `message_sanitization.apply_reasoning_content_policy`).
- **Remote agent runtime** = when it forwards the received messages to its LLM
  (e.g. DeepSeek thinking mode), it applies its own reasoning echo-back rules.

## 2. Frame changes (server/src/ws/agent.ts)

### 2.1 `tool.completed` gains an OPTIONAL `output` field

```ts
// BEFORE (still fully supported)
{
  type: "tool.completed",
  task_id: string,
  tool: string,
  detail?: string,
  status?: "ok" | "error",
  error?: string
}

// AFTER (additive — old agents that omit `output` still work)
{
  type: "tool.completed",
  task_id: string,
  tool: string,
  detail?: string,
  status?: "ok" | "error",
  error?: string,
  output?: string   // NEW — the tool's returned content:
                    //   terminal stdout, file excerpt, API response body,
                    //   structured MCP result, etc.
}
```

- `output` is the **actual result content** the tool produced (not a summary).
- Absent `output` ⇒ the platform relays the call with an empty result row;
  the chat request never fails.
- `detail` remains a short human description (e.g. "ran command, 42 lines").

### 2.2 `thinking` frames are relayed (no change, already existed)

```ts
{ type: "thinking", task_id: string, text: string }
```

Remote agents that already emit `thinking` are done. Athena accumulates it
per assistant turn and replays it in history on the next task.

### 2.3 taskReply contract (registered frame)

The self-describing `taskReply` contract (sent on every handshake) now
documents: tool events **may** carry `output`, and thinking is relayed.
`protocolVersion` remains **1** — all additions are optional fields.

## 3. How the platform replays it (what the remote agent should expect)

On every `/api/chat` call, Athena sends history as a messages array. A turn
that had a tool call and thinking is expanded (in `chat-context.ts`):

```ts
// Before (T10):
{ role: "assistant", content: "final answer text" }

// After (T11) — one assistant turn may expand into TWO messages:
{ role: "assistant", content: "final answer text", thinking: "<reasoning text>" }
{ role: "tool",      content: "<tool output>", name: "<tool name>", tool_call_id: "<id>" }
```

Rules:
- `thinking` is delivered as a **separate field on the assistant message**
  (`thinking`), not merged into `content`.
- A tool-carrying assistant turn emits a **second `{role: "tool"}` message**
  with the output as `content`; `name`/`tool_call_id` are included when the
  connector supplied them.
- A tool that ran but produced no output still emits an (empty) `role: "tool"`
  row so the call can be matched.
- Pre-T11 history (plain `{role, content}`) is still accepted unchanged.
- `thinking` and `tool` rows count toward the context budget
  (threshold 200K tokens) — the same heuristic Athena's UI meter uses.

## 4. What the remote agent connector should do (action items)

1. **Emit `output` in `tool.completed`** whenever the tool result content is
   available (terminal stdout, file content, API response, MCP result).
   - If the tool failed, include the error text in `error` (existing) and, if
     useful, a short excerpt in `output`.
   - Keep `detail` as the short label; don't stuff megabytes into it.
2. **Emit `thinking` frames** if not already doing so (Hermes already does).
3. **When forwarding the task messages to the LLM**, the agent runtime applies
   its own provider policy:
   - DeepSeek/Kimi/MiMo thinking mode: `reasoning_content` echo-back is
     **mandatory** (HTTP 400 if omitted) — map received `thinking` onto the
     assistant message's reasoning payload as your runtime requires.
   - Strict providers (Mistral/Cerebras/Groq/…): strip any reasoning field.
   - Athena does not care which — it only guarantees the data arrives.
4. **Backward compatibility**: sending frames without `output` is fine today.
   Sending `output` only improves the next-turn context.

## 5. Test evidence (platform side, all green)

- Server: `npm test` → **970/970 pass** (incl. new ws-agent tests:
  `tool.completed` with/without `output`, SSE relay of output, chat route
  streaming tool output end-to-end, pre-T11 compat).
- Web: vitest chat.spec → **36/36** (historyForRequest includes thinking +
  first tool output; meter budget reflects them).
- `tsc` / `vue-tsc` clean.

## 6. Example

```jsonc
// tool.completed WITH output (new)
{
  "type": "tool.completed",
  "task_id": "task-123",
  "tool": "terminal",
  "detail": "ran: ls -la",
  "status": "ok",
  "output": "total 24\ndrwxr-xr-x 5 hh hh 4096 Aug 19 21:00 .\ndrwxr-xr-x 3 hh hh 4096 Aug 19 21:00 .."
}

// next turn's history as the remote agent receives it
[
  { "role": "assistant", "content": "The directory contains 5 entries.", "thinking": "Let me list the directory first." },
  { "role": "tool", "content": "total 24\n...", "name": "terminal", "tool_call_id": "call-1" },
  { "role": "user", "content": "now show me the biggest file" }
]
```

## 7. Contact

Questions / feedback → reply in this thread. The platform-side changes are
done and verified; the connector-side items (section 4) are the remaining work.