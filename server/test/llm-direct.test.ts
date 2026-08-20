import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATHENA_REFINE_MAX_TOKENS,
  ATHENA_REFINE_MODEL,
  OpenRouterError,
  callOpenRouter,
} from "../src/agents/llm-direct.js";

/**
 * G4.S8.T2 — direct OpenRouter HTTP helper.
 *
 * Unit tests STUB the HTTP layer (fake fetch) — NO live LLM calls in CI. They verify the request
 * body (model, reasoning effort none, max_tokens, json_object), the hard timeout, retry-with-backoff
 * on network/5xx/timeout, and the json-error/empty-content fallback paths.
 */

function jsonResponse(overrides: Partial<Record<string, unknown>> = {}, body = '{"levels":[]}'): Response {
  const clone = Object.fromEntries(
    Object.entries({
      id: "chatcmpl-test",
      choices: [{ index: 0, message: { role: "assistant", content: body }, finish_reason: "stop" }],
      usage: { input: 10, output: 5, total_tokens: 15 },
      ...overrides,
    }).filter(([, v]) => v !== undefined),
  );
  return new Response(JSON.stringify(clone), { status: overrides.status ?? 200, headers: { "Content-Type": "application/json" } });
}

function jsonFromString(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

function makeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("callOpenRouter sends reasoning.effort none + json_object and returns parsed text+usage", async () => {
  const { calls, fetchImpl } = makeFetch(() =>
    jsonResponse({}, JSON.stringify({ levels: [{ index: 0, level: 1 }] })),
  );
  const result = await callOpenRouter(
    { systemPrompt: "sys", userContent: "user" },
    { apiKey: "sk-test", fetchImpl, retries: 0 },
  );

  assert.equal(calls.length, 1);
  const init = calls[0]!.init;
  const body = JSON.parse(init.body as string) as Record<string, unknown>;
  assert.deepEqual(body.model, ATHENA_REFINE_MODEL, "no explicit model → the deepseek default");
  assert.deepEqual(body.reasoning, { effort: "none" }, "reasoning effort has to be NONE (qwen ignores enable_thinking)");
  assert.equal(body.max_tokens, ATHENA_REFINE_MAX_TOKENS, "deepseek maxTokens ceiling");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal((body.messages as Array<{ role: string; content: string }>)[0].content, "sys");
  assert.equal((body.messages as Array<{ role: string; content: string }>)[1].content, "user");

  const auth = (init.headers as Record<string, string>).Authorization;
  assert.equal(auth, "Bearer sk-test");
  assert.equal(result.text, JSON.stringify({ levels: [{ index: 0, level: 1 }] }));
  assert.deepEqual(result.usage, { input: 10, output: 5, total_tokens: 15 });
});

test("callOpenRouter honours an explicit model override", async () => {
  const { calls, fetchImpl } = makeFetch(() => jsonResponse({}, "{}"));
  await callOpenRouter(
    { model: "qwen/qwen3.7-flash", systemPrompt: "s", userContent: "u" },
    { apiKey: "k", fetchImpl, retries: 0 },
  );
  const body = JSON.parse(calls[0]!.init.body as string) as { model: string };
  assert.equal(body.model, "qwen/qwen3.7-flash");
});

test("callOpenRouter retries 5xx with backoff, then throws after retries exhausted", async () => {
  const { calls, fetchImpl } = makeFetch(() => jsonFromString("server error", 500));
  await assert.rejects(() => callOpenRouter({ systemPrompt: "s", userContent: "u" }, { apiKey: "k", fetchImpl, retries: 2 }), OpenRouterError);
  assert.equal(calls.length, 3, "initial + 2 retries");
});

test("callOpenRouter recovers after a transient 5xx", async () => {
  let n = 0;
  const { calls, fetchImpl } = makeFetch(() => {
    n += 1;
    if (n === 1) return jsonFromString("boom", 503);
    return jsonResponse({}, "{\"ok\":true}");
  });
  const result = await callOpenRouter({ systemPrompt: "s", userContent: "u" }, { apiKey: "k", fetchImpl, retries: 2 });
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(result.text).ok, true);
});

test("callOpenRouter aborts after the hard timeout and retries", async () => {
  const calls2: string[] = [];
  const abortableFetch = (url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      calls2.push("call");
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }) as Promise<Response>;
  await assert.rejects(
    () => callOpenRouter({ systemPrompt: "s", userContent: "u" }, { apiKey: "k", fetchImpl: abortableFetch as unknown as typeof fetch, timeoutMs: 20, retries: 1 }),
    OpenRouterError,
  );
  assert.equal(calls2.length, 2, "each timed-out attempt is retried (initial + 1 retry)");
});

test("callOpenRouter handles an unparseable (non-JSON) response body", async () => {
  const { calls, fetchImpl } = makeFetch(() => jsonFromString("<html>not json</html>", 200));
  await assert.rejects(
    () => callOpenRouter({ systemPrompt: "s", userContent: "u" }, { apiKey: "k", fetchImpl, retries: 1 }),
    /not valid JSON/,
  );
  assert.equal(calls.length, 2);
});

test("callOpenRouter returns the fallback on a large near-empty body without reasoning", async () => {
  const { fetchImpl } = makeFetch(() => jsonResponse({}, ""));
  await assert.rejects(
    () => callOpenRouter({ systemPrompt: "s", userContent: "u" }, { apiKey: "k", fetchImpl, retries: 0 }),
    /empty content/,
  );
});

// --- G4.S8.T6 regression tests ---

test("G4.S8.T6: response_format with a TypeBox schema is wrapped as json_schema (NOT the bare spread that 400s)", async () => {
  const { calls, fetchImpl } = makeFetch(() =>
    jsonResponse({}, JSON.stringify({ levels: [{ index: 0, level: 1 }] })),
  );
  // TypeBox schema always carries `type: "object"` — the old spread produced
  // `response_format: { type: "object", ... }` which OpenRouter rejects with 400.
  const schema = { type: "object", properties: { levels: { type: "array" } }, required: ["levels"] };
  await callOpenRouter(
    { systemPrompt: "sys", userContent: "user", schema },
    { apiKey: "sk-test", fetchImpl, retries: 0 },
  );

  const body = JSON.parse(calls[0]!.init.body as string) as { response_format: Record<string, unknown> };
  const rf = body.response_format;
  assert.equal(rf.type, "json_schema", "schema'd calls must use json_schema, never bare 'object'");
  assert.notEqual(rf.type, "object", "the TypeBox 'object' type must NOT leak into response_format");
  const inner = rf.json_schema as { name?: string; strict?: boolean; schema?: unknown };
  assert.ok(inner, "json_schema payload carries name/strict/schema");
  assert.equal(inner.strict, true);
  assert.deepEqual(inner.schema, schema, "the raw TypeBox schema is placed under json_schema.schema");
  assert.ok(typeof inner.name === "string" && inner.name.length > 0, "json_schema needs a name");
});

test("G4.S8.T6: WITHOUT a schema the response_format stays json_object", async () => {
  const { calls, fetchImpl } = makeFetch(() => jsonResponse({}, "{}"));
  await callOpenRouter({ systemPrompt: "s", userContent: "u" }, { apiKey: "k", fetchImpl, retries: 0 });
  const body = JSON.parse(calls[0]!.init.body as string) as { response_format: Record<string, unknown> };
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("G4.S8.T6: a 401 (bad key) is NOT retried — exactly one attempt, then throws", async () => {
  const { calls, fetchImpl } = makeFetch(() => jsonFromString('{"error":{"message":"bad key"}}', 401));
  await assert.rejects(
    () => callOpenRouter({ systemPrompt: "s", userContent: "u" }, { apiKey: "k", fetchImpl, retries: 3 }),
    OpenRouterError,
  );
  assert.equal(calls.length, 1, "4xx errors must not be retried");
});

test("G4.S8.T6: a 400 (invalid request) is NOT retried — exactly one attempt, then throws", async () => {
  const { calls, fetchImpl } = makeFetch(() => jsonFromString('{"error":{}}', 400));
  await assert.rejects(
    () => callOpenRouter({ systemPrompt: "s", userContent: "u" }, { apiKey: "k", fetchImpl, retries: 3 }),
    OpenRouterError,
  );
  assert.equal(calls.length, 1, "4xx errors must not be retried");
});

test("G4.S8.T6: a 429 (rate-limited) IS retried", async () => {
  let n = 0;
  const { calls, fetchImpl } = makeFetch(() => {
    n += 1;
    if (n <= 2) return jsonFromString("rate limited", 429);
    return jsonResponse({}, "{\"ok\":1}");
  });
  const result = await callOpenRouter({ systemPrompt: "s", userContent: "u" }, { apiKey: "k", fetchImpl, retries: 3 });
  assert.equal(calls.length, 3, "429 retries until success (initial + 2 retries)");
  assert.equal(JSON.parse(result.text).ok, 1);
});

test("G4.S8.T6: empty-content + reasoning is detected at choices[0].message.reasoning (OpenRouter shape), not top-level", async () => {
  let n = 0;
  const { calls, fetchImpl } = makeFetch(() => {
    n += 1;
    if (n === 1) {
      // OpenRouter puts reasoning on the choice message, NOT a top-level field.
      return jsonResponse(
        {
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "", reasoning: { summary: ["thinking..."] } },
              finish_reason: "length",
            },
          ],
          usage: { total_tokens: 100 },
        },
        "",
      );
    }
    return jsonResponse({}, "{\"ok\":1}");
  });
  const result = await callOpenRouter({ systemPrompt: "s", userContent: "u" }, { apiKey: "k", fetchImpl, retries: 1 });
  assert.equal(calls.length, 2, "empty content + reasoning present → retried with larger budget");
  assert.equal(JSON.parse(result.text).ok, 1);
});

test("callOpenRouter retries when content is empty but reasoning is present, bumping max_tokens", async () => {
  let n = 0;
  const { calls, fetchImpl } = makeFetch(() => {
    n += 1;
    if (n === 1) {
      return jsonResponse({ reasoning: { summary: ["thinking"] } }, "");
    }
    return jsonResponse({}, "{\"ok\":1}");
  });
  const result = await callOpenRouter({ systemPrompt: "s", userContent: "u" }, { apiKey: "k", fetchImpl, retries: 1 });
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(result.text).ok, 1);
});
