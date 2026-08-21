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
 * The model defaults to `~deepseek/deepseek-v4-flash-latest` (maxTokens 65536, output
 * $0.28/M), overridable via env `ATHENA_REFINE_MODEL`; unreliable providers are excluded
 * via env ATHENA_REFINE_PROVIDER_IGNORE (default ["Alibaba"], routes ~deepseek stably
 * to Relace).
 */

import { homedir } from "node:os";
import { join } from "node:path";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Default refinement model (G4.S8.T2): deepseek-v4-flash-latest, 65536 maxTokens, 1.31M context. */
export const ATHENA_REFINE_MODEL = "~deepseek/deepseek-v4-flash-latest";

export const ATHENA_REFINE_MAX_TOKENS = 65536;
export const OPENROUTER_TIMEOUT_MS = 120_000;
export const OPENROUTER_RETRIES = 3;

export interface OpenRouterCallParams {
  model?: string;
  systemPrompt: string;
  userContent: string;
  /** Optional JSON schema hints folded into the prompt (the helper requests json_object format). */
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
 * or the measured default ["Alibaba"] when unset. Verified in production: model
 * "~deepseek/deepseek-v4-flash-latest" (the "~" prefix is REQUIRED — the bare id
 * is not a valid OpenRouter model) with Alibaba ignored routes stably to Relace.
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
      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: attemptMaxTokens,
        response_format: { type: "json_object" },
        // G4.S8.T16 unified reasoning strategy: task-class effort from
        // refineReasoningFor() — "none" for extraction calls (default; qwen ignores
        // enable_thinking, so effort=none is the only reliable suppression),
        // thinking allowed for analysis-class calls via REFINE_REASONING_ANALYSIS.
        reasoning: { effort: params.reasoningEffort ?? "none" },
      };
      // G4.S8.T16 provider exclusion: route away from unreliable providers
      // (~deepseek + ignore Alibaba → stably Relace). Value from env
      // ATHENA_REFINE_PROVIDER_IGNORE, default ["Alibaba"].
      const providerIgnore = resolveRefineProviderIgnore();
      if (providerIgnore.length > 0) {
        body.provider = { ignore: providerIgnore };
      }
      if (params.schema !== undefined) {
        // G4.S8.T6 (P0): a TypeBox schema carries `type: "object"` — spreading it onto response_format
        // produced `{ type: "object", required, properties }` which OpenRouter rejected with HTTP 400
        // on EVERY call. Wrap it correctly so OpenRouter's json_schema constrained sampling applies.
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: "refinement_result",
            strict: true,
            schema: params.schema,
          },
        };
      }

      const res = await fetchImpl(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await res.text();
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
