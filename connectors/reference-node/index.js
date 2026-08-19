// Athena reverse-WebSocket remote-agent connector (reference implementation)
//
// Generic, credential-free client for the Athena agent WebSocket protocol.
// It connects OUT to the platform, registers, and implements the server's
// self-describing taskReply contract (sent in the `registered` frame):
//
//   frames: task.start, delta, thinking, tool.started, tool.completed,
//           task.complete, task.error
//   mustEchoTaskId: true        (every reply echoes the incoming task_id)
//   terminateWith: task.complete | task.error   (one is mandatory per task)
//
// It also declares an optional context budget (maxContextTokens) the platform
// can use to size/truncate conversation history it replays to this agent.
//
// This file is the *protocol* layer ("Layer 1"). To actually produce answers it
// is wired (below) to a local OpenAI-compatible /v1/runs endpoint (e.g. a local
// Hermes API server or any Responses-API-compatible brain). Subclass / replace
// `generateAnswer` to plug in any other answer provider.
//
// Usage:  node index.js                (reads env, see README)
// Env:    ATHENA_AGENT_ID, ATHENA_TOKEN, ATHENA_WS_URL, ATHENA_API_URL, ATHENA_API_KEY
//
// No secrets are hardcoded. Everything comes from the environment.
// Requires Node >= 22 (global WebSocket + fetch). Single file, no dependencies.

const os = require("os");
const fs = require("fs");

const AGENT_ID = process.env.ATHENA_AGENT_ID || "";
const TOKEN    = process.env.ATHENA_TOKEN || "";
const WS_URL   = process.env.ATHENA_WS_URL || "wss://athenakb.com/ws/agent";
const API_URL  = process.env.ATHENA_API_URL || "http://127.0.0.1:8642/v1";
const API_KEY  = process.env.ATHENA_API_KEY || "";
const PIDFILE  = process.env.ATHENA_PIDFILE ||
  (process.platform === "win32"
    ? "C:\\athena-connector\\athena_ws.pid"
    : "/tmp/athena_ws.pid");
// Optional context budget the platform advertises/replays against (soft ceiling).
const MAX_CONTEXT_TOKENS = parseInt(process.env.ATHENA_MAX_CONTEXT_TOKENS || "200000", 10);

if (PIDFILE) { try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch (e) { console.error("[warn] pidfile:", e.message); } }

let reconnectDelay = 2000;

function send(ws, obj) {
  const raw = JSON.stringify(obj);
  ws.send(raw);
  console.log(`[sent] ${new Date().toISOString()} :: ${raw.slice(0, 300)}${raw.length > 300 ? "…" : ""}`);
}

// ---- answer provider (override this) -------------------------------------
// Contract: send 'delta' frames for streamed answer text, 'thinking' for
// reasoning, 'tool.started'/'tool.completed' (with optional 'output') for tool
// calls, and finish with 'task.complete' or 'task.error'.
async function generateAnswer(ws, rpcId, messages) {
  send(ws, { type: "task.start", task_id: rpcId });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  const input = (Array.isArray(messages) && messages.length) ? messages : [{ role: "user", content: "hi" }];
  const runBody = { model: "hermes-agent", input, stream: false };

  try {
    const resp = await fetch(`${API_URL}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(runBody),
      signal: controller.signal,
    });
    const data = await resp.json();
    const runId = data?.id || data?.run_id;
    if (!runId) throw new Error("no run id: " + JSON.stringify(data).slice(0, 200));

    const evt = await fetch(`${API_URL}/runs/${runId}/events`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: controller.signal,
    });
    if (!evt.ok || !evt.body) throw new Error(`events HTTP ${evt.status}`);

    const reader = evt.body.getReader();
    const dec = new TextDecoder();
    let buf = "", lastContent = "", finished = false;

    const parseSSE = (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const dataLine = raw.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n");
        if (!dataLine || dataLine === "[DONE]") continue;
        let ev; try { ev = JSON.parse(dataLine); } catch { continue; }
        const kind = String(ev.event || ev.type || "");
        if (kind === "message.delta" && typeof ev.delta === "string") {
          lastContent += ev.delta; send(ws, { type: "delta", task_id: rpcId, delta: ev.delta });
        } else if (kind === "message.delta" && ev.delta?.content) {
          lastContent += ev.delta.content; send(ws, { type: "delta", task_id: rpcId, delta: ev.delta.content });
        } else if (kind === "reasoning.available" && ev.text) {
          send(ws, { type: "thinking", task_id: rpcId, thinking: ev.text });
        } else if (kind.includes("tool.started") || kind === "tool_started") {
          send(ws, { type: "tool.started", task_id: rpcId, tool: ev.tool || ev.tool_name || "unknown",
                     tool_call_id: ev.tool_call_id || ev.id || undefined });
        } else if (kind.includes("tool.completed") || kind === "tool_completed") {
          let out = ev.output; if (out == null) out = ev.result;
          if (out == null && ev.data) out = ev.data.output ?? ev.data.result ?? ev.data.content ?? ev.data.stdout ?? null;
          const status = (ev.error ? "error" : "ok");
          send(ws, { type: "tool.completed", task_id: rpcId, tool: ev.tool || ev.tool_name || "unknown",
                     tool_call_id: ev.tool_call_id || ev.id || undefined,
                     status, error: status === "error" ? (ev.error?.message || ev.error) : undefined,
                     output: out != null ? String(out).slice(0, 100000) : undefined });
        } else if (kind === "run.completed" || ev.type === "run.completed") {
          lastContent = lastContent || ev.output || ev.output?.content || ev.result || ""; finished = true;
        } else if (kind === "run.error" || ev.status === "failed" || ev.status === "error" || ev.error) {
          finished = true; send(ws, { type: "task.error", task_id: rpcId, error: { message: ev.error?.message || ev.error || "run failed" } });
        }
      }
    };
    for (;;) { const { value, done } = await reader.read(); if (done) break; parseSSE(dec.decode(value, { stream: true })); }
    parseSSE(dec.decode());
    clearTimeout(timeout);
    if (lastContent && !finished) finished = true;
    if (finished || lastContent) send(ws, { type: "task.complete", task_id: rpcId, content: lastContent });
    else send(ws, { type: "task.error", task_id: rpcId, error: { message: "run ended without content" } });
  } catch (err) {
    clearTimeout(timeout);
    console.error("[task error]", err?.message || err);
    try { send(ws, { type: "task.error", task_id: rpcId, error: { message: String(err?.message || err) } }); } catch {}
  }
}
// ---------------------------------------------------------------------------

function connect() {
  console.log(`[${new Date().toISOString()}] (${AGENT_ID.slice(0, 10) || "?"}...) connecting...`);
  if (!AGENT_ID || !TOKEN) { console.error("[fatal] ATHENA_AGENT_ID / ATHENA_TOKEN required"); process.exit(1); }
  const ws = new WebSocket(WS_URL);
  const timer = setTimeout(() => { console.error("[warn] no open within 15s"); try { ws.close(); } catch {} }, 15000);

  ws.onopen = () => {
    clearTimeout(timer); reconnectDelay = 2000;
    send(ws, { type: "register", agent_id: AGENT_ID, token: TOKEN, maxContextTokens: MAX_CONTEXT_TOKENS });
  };
  ws.onmessage = (ev) => {
    let data = ev.data;
    if (typeof data !== "string") { try { data = ev.data.data || String(ev.data); } catch { data = String(ev.data); } }
    console.log(`[recv] ${new Date().toISOString()} :: ${data}`);
    try {
      const obj = JSON.parse(data);
      if (!obj || typeof obj !== "object") return;
      if (obj.type === "ping" || obj.op === "ping") return send(ws, { type: "pong", agent_id: AGENT_ID });
      if (obj.type === "task") generateAnswer(ws, obj.task_id, obj.payload);
    } catch {}
  };
  ws.onerror = (err) => { clearTimeout(timer); console.error("[error]", err?.message || err); };
  ws.onclose = (ev) => {
    clearTimeout(timer);
    console.log(`[closed] code=${ev.code} reason=${ev.reason} reconnect in ${reconnectDelay}ms`);
    setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
}
connect();