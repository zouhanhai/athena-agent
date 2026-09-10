/**
 * Direct OpenRouter HTTP helper for the Athena refinement calls (G4.S8.T2).
 *
 * Replaces Pi `ModelRuntime.completeSimple` for ALL refinement LLM passes (stage-1
 * header re-level, stage-2 per-section, global merge, wiki-edit diff-refine — G4.S8.T16
 * migrated the last Pi consumer). These are single-shot constrained-output calls with NO
 * agent loop — Pi's silent-hang risk (no timeout, stalled provider leaves the await pending
 * forever) outweighs its cost. A direct `fetch` to OpenRouter returns identical JSON much
 * faster and cheaper, with a hard timeout and retry/backoff so a dead provider can never
 * hang the ingest task queue again.
 *
 * Key separation: the refinement pipeline reads a DEDICATED key chain (G4.S8.T16):
 * env ATHENA_OPENROUTER_KEY → auth.json["athenaingest"] → auth.json["athena"].
 * The model defaults to `deepseek/deepseek-v4.1-flash` (maxTokens 65536, output
 * $0.60/M, 1M context), overridable via env `ATHENA_REFINE_MODEL`; providers to avoid
 * come from env ATHENA_REFINE_PROVIDER_IGNORE (default ["Alibaba"] — kept because it
 * still steers the legacy `~deepseek/...` alias routes; it is a no-op for v4.1, whose
 * endpoints are DeepSeek / Novita / DeepInfra).
 *
 * response_format: schema'd calls request `json_schema` constrained sampling. When the
 * model's available endpoints reject that type (v4.1 currently resolves to the DeepSeek
 * endpoint on the athena account's provider allowlist, which answers HTTP 400 "This
 * response_format type is unavailable now"), the call degrades ONCE per process to
 * `json_object` — the schema contract stays in the system prompt and the extractors
 * validate/normalize the result.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Default refinement model (G4.S8.T2; v4.1 since 2026-09-10): deepseek-v4.1-flash, 65536 maxTokens, 1M context. */
export const ATHENA_REFINE_MODEL = "deepseek/deepseek-v4.1-flash";

export const ATHENA_REFINE_MAX_TOKENS = 65536;
export const OPENROUTER_TIMEOUT_MS = 120_000;
export const OPENROUTER_RETRIES = 3;

export interface OpenRouterCallParams {
  model?: string;
  systemPrompt: string;
  userContent: string;
  /**
   * Optional JSON schema for the call. Requested as `response_format: json_schema`
   * (constrained sampling) with a transparent per-process degrade to json_object on
   * endpoints that reject that type — so the prompt must keep describing the shape.
   */
  schema?: unknown;
  /** Max output tokens. Default 65536 (deepseek ceiling). */
  maxTokens?: number;
  /**
   * G4.S8.T16 unified reasoning strategy: the task-class effort from
   * refineReasoningFor() ("none" | "low" | "medium" | "high"). Default "none"
   * (extraction class) — qwen ignores enable_thinking, so reasoning.effort=none
   * is the ONLY reliable way to suppress thinking tokens.
   */
  reasoningEffort?: "none" | "low" | "medium" | "high";
}

export interface OpenRouterResult {
  /** The assistant message content (a JSON string for json_object responses). */
  text: string;
  usage?: unknown;
}

export interface OpenRouterCallOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

export class OpenRouterError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/**
 * Read the athena OpenRouter key for the refinement pipeline (G4.S8.T16 three-level
 * chain, ingest-dedicated key first):
 *   1. env ATHENA_OPENROUTER_KEY (or legacy ATHENA_OPENAI_API_KEY)
 *   2. ~/.pi/agent/auth.json → "athenaingest" (the dedicated INGEST key)
 *   3. ~/.pi/agent/auth.json → "athena" (chat provider fallback)
 */
export async function readAthenaOpenRouterKey(
  env: NodeJS.ProcessEnv = process.env,
  authPath = join(homedir(), ".pi", "agent", "auth.json"),
): Promise<string> {
  const envKey = env.ATHENA_OPENROUTER_KEY ?? env.ATHENA_OPENAI_API_KEY;
  if (envKey && envKey.trim().length > 0) return envKey.trim();
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(authPath, "utf8");
    const auth = JSON.parse(raw) as Record<string, { type?: string; key?: string }>;
    const ingest = auth["athenaingest"];
    if (ingest?.key && ingest.key.trim().length > 0) return ingest.key.trim();
    const athena = auth["athena"];
    if (athena?.key && athena.key.trim().length > 0) return athena.key.trim();
    throw new OpenRouterError("refine: no athenaingest/athena OpenRouter key in ~/.pi/agent/auth.json");
  } catch (err) {
    if (err instanceof OpenRouterError) throw err;
    throw new OpenRouterError(`refine: cannot read OpenRouter key (env ATHENA_OPENROUTER_KEY or ${authPath}): ${String(err)}`);
  }
}

/** Default model resolution: env ATHENA_REFINE_MODEL, falling back to the deepseek default. */
export function resolveRefineModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ATHENA_REFINE_MODEL?.trim().length ? env.ATHENA_REFINE_MODEL.trim() : ATHENA_REFINE_MODEL;
}

/**
 * G4.S8.T16: OpenRouter provider exclusion for the refinement calls. Returns the
 * parsed ATHENA_REFINE_PROVIDER_IGNORE env value (comma-separated provider names)
 * or the measured default ["Alibaba"] when unset. Originally tuned for the
 * "~deepseek/deepseek-v4-flash-latest" moving alias (with Alibaba ignored it routed
 * stably to Relace). Kept as the default — it is harmless for the pinned
 * deepseek-v4.1-flash id, whose endpoints are DeepSeek / Novita / DeepInfra.
 */
export const REFINE_PROVIDER_IGNORE_DEFAULT = ["Alibaba"];

export function resolveRefineProviderIgnore(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.ATHENA_REFINE_PROVIDER_IGNORE;
  if (raw === undefined || raw.trim().length === 0) return [...REFINE_PROVIDER_IGNORE_DEFAULT];
  const parsed = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return parsed.length > 0 ? parsed : [...REFINE_PROVIDER_IGNORE_DEFAULT];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Models whose live endpoints rejected `response_format: json_schema` — degraded for this process. */
const schemaUnsupportedModels = new Set<string>();

/**
 * OpenRouter `response_format` for a schema'd call (G4.S8.T6): a TypeBox schema always
 * carries `type: "object"`, so it must be wrapped in the json_schema envelope — the bare
 * spread produced `{ type: "object", ... }`, which OpenRouter rejected with HTTP 400 on
 * EVERY call.
 */
function jsonSchemaFormat(schema: unknown): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: { name: "refinement_result", strict: true, schema },
  };
}

/**
 * True when a 400 body reports that the endpoint cannot serve the requested
 * response_format. Live sample (DeepSeek first-party, 2026-09-10):
 * `{"error":{"message":"This response_format type is unavailable now",...}}`.
 */
function isJsonSchemaUnsupported(raw: string): boolean {
  return /response_format/i.test(raw) && /unavailable|unsupported|not supported/i.test(raw);
}

/**
 * Call OpenRouter directly (no agent loop, reasoning OFF) with a hard timeout + retry/backoff.
 * Returns the parsed JSON text + usage. Throws `OpenRouterError` after retries are exhausted.
 */
export async function callOpenRouter(
  params: OpenRouterCallParams,
  options: OpenRouterCallOptions = {},
): Promise<OpenRouterResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? OPENROUTER_TIMEOUT_MS;
  const retries = options.retries ?? OPENROUTER_RETRIES;
  const model = params.model ?? resolveRefineModel();
  const apiKey = options.apiKey ?? (await readAthenaOpenRouterKey());
  const maxTokens = params.maxTokens ?? ATHENA_REFINE_MAX_TOKENS;

  const messages = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: params.userContent },
  ];

  let lastError: unknown;
  let bumpCount = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const attemptMaxTokens = bumpCount === 0 ? maxTokens : Math.min(maxTokens * 2 ** bumpCount, 256_000);
      // G4.S8.T6 (P0): schema'd calls request provider-side constrained sampling through the
      // json_schema envelope (a TypeBox schema always carries `type: "object"`; the bare spread
      // 400s on every call). 2026-09-10: when the model's available endpoints reject json_schema
      // the call degrades to json_object ONCE per process — the schema contract stays in the
      // system prompt and the extractors validate/normalize the payload. After that the probe is
      // skipped for the model, so re-enabling structured outputs later (provider/allowlist
      // change) restores json_schema on the next process start.
      const wantsSchema = params.schema !== undefined;
      const probingSchema = wantsSchema && !schemaUnsupportedModels.has(model);
      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: attemptMaxTokens,
        response_format: probingSchema ? jsonSchemaFormat(params.schema) : { type: "json_object" },
        // G4.S8.T16 unified reasoning strategy: task-class effort from
        // refineReasoningFor() — "none" for extraction calls (default; qwen ignores
        // enable_thinking, so effort=none is the only reliable suppression),
        // thinking allowed for analysis-class calls via REFINE_REASONING_ANALYSIS.
        reasoning: { effort: params.reasoningEffort ?? "none" },
      };
      // G4.S8.T16 provider exclusion: route away from unreliable providers. Value from env
      // ATHENA_REFINE_PROVIDER_IGNORE, default ["Alibaba"] (a no-op for v4.1's endpoints).
      const providerIgnore = resolveRefineProviderIgnore();
      if (providerIgnore.length > 0) {
        body.provider = { ignore: providerIgnore };
      }

      const send = (responseFormat: Record<string, unknown>) => {
        body.response_format = responseFormat;
        return fetchImpl(OPENROUTER_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      };

      let res = await send(body.response_format as Record<string, unknown>);
      let raw = await res.text();
      // Transparent json_schema → json_object degrade (see the body comment above). One extra
      // round trip, once per process per model; retry accounting is untouched.
      if (probingSchema && res.status === 400 && isJsonSchemaUnsupported(raw)) {
        schemaUnsupportedModels.add(model);
        console.warn(
          `[refine] ${model}: endpoint rejects response_format json_schema — degrading to json_object (schema contract stays in the system prompt)`,
        );
        res = await send({ type: "json_object" });
        raw = await res.text();
      }
      const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (!res.ok) {
        const status = res.status;
        if (status >= 500 || status === 429) {
          lastError = new OpenRouterError(`openrouter http ${status}: ${raw.slice(0, 300)}`, status);
          if (attempt < retries) {
            await sleep(300 * 2 ** attempt);
            continue;
          }
          throw lastError;
        }
        throw new OpenRouterError(`openrouter http ${status}: ${raw.slice(0, 300)}`, status);
      }

      const choice = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
      const content = choice?.message?.content;
      const text = typeof content === "string" ? content : "";
      const usage = (payload as { usage?: unknown }).usage;

      // Empty content + reasoning present → the provider spent the budget on thinking and never
      // emitted the answer. Treat as a failure and retry with a higher max_tokens headroom.
      // G4.S8.T6: OpenRouter puts reasoning on `choices[0].message.reasoning`, not a top-level field.
      const messageReasoning = choice?.message && (choice.message as { reasoning?: unknown }).reasoning;
      if (!text.trim() && isPresent(messageReasoning)) {
        lastError = new OpenRouterError("openrouter returned empty content with reasoning present", res.status);
        if (attempt < retries) {
          bumpCount += 1;
          await sleep(300 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      if (!text.trim()) {
        lastError = new OpenRouterError("openrouter returned empty content", res.status);
        if (attempt < retries) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      return { text, usage };
    } catch (err) {
      if (controller.signal.aborted) {
        lastError = new OpenRouterError(`openrouter request timed out after ${timeoutMs}ms`);
      } else if (err instanceof SyntaxError) {
        lastError = new OpenRouterError(`openrouter response was not valid JSON: ${String(err)}`);
      } else {
        lastError = err;
      }
      // G4.S8.T6 (P1): 4xx client errors (400/401/403/404) are NEVER retryable — a bad key or an
      // invalid request will not succeed on a subsequent attempt (it only burns 3 backoffs). Only
      // network/timeout/5xx/429/empty-content are retried. Check here in the outer catch because
      // non-5xx/non-429 non-ok branches throw an OpenRouterError that would otherwise be retried.
      if (lastError instanceof OpenRouterError && lastError.status !== undefined && lastError.status >= 400 && lastError.status < 500) {
        throw lastError;
      }
      if (attempt < retries) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null && (!(typeof v === "object") || Object.keys(v as object).length > 0);
}
