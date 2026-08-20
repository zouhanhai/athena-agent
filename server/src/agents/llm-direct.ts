/**
 * Direct OpenRouter HTTP helper for the Athena refinement calls (G4.S8.T2).
 *
 * Replaces Pi `ModelRuntime.completeSimple` for the three single-shot constrained-output refinement
 * passes (stage-1 header re-level, stage-2 per-section, global merge). These are deterministic
 * classification/extraction calls with NO agent loop — Pi's silent-hang risk (no timeout, stalled
 * provider leaves the await pending forever) outweighs its cost. A direct `fetch` to OpenRouter with
 * `reasoning.effort = none` returns identical JSON ~22x faster and ~40x cheaper, with a hard timeout
 * and retry/backoff so a dead provider can never hang the ingest task queue again.
 *
 * Key separation is preserved: the refinement pipeline reads the DEDICATED `athena` OpenRouter key
 * (independent from chat), from `~/.pi/agent/auth.json` → `athena.key` (or env `ATHENA_OPENROUTER_KEY`
 * / `ATHENA_OPENAI_API_KEY`). The model defaults to `~deepseek/deepseek-v4-flash-latest` (maxTokens
 * 65536, output $0.28/M) with `qwen/qwen3.7-flash` available as a config fallback (maxTokens 8192).
 *
 * qwen's `enable_thinking: false` extra_body is silently IGNORED by OpenRouter — reasoning MUST be
 * disabled via `reasoning: { effort: "none" }`, which works on BOTH deepseek and qwen.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Default refinement model (G4.S8.T2): deepseek-v4-flash-latest, 65536 maxTokens, 1.31M context. */
export const ATHENA_REFINE_MODEL = "~deepseek/deepseek-v4-flash-latest";
/** Fallback model when configured: qwen/qwen3.7-flash — 8192 maxTokens (8x lower ceiling). */
export const ATHENA_REFINE_MODEL_FALLBACK = "qwen/qwen3.7-flash";

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

/** Read the athena OpenRouter key: env ATHENA_OPENROUTER_KEY/ATHENA_OPENAI_API_KEY, else auth.json. */
export async function readAthenaOpenRouterKey(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const envKey = env.ATHENA_OPENROUTER_KEY ?? env.ATHENA_OPENAI_API_KEY;
  if (envKey && envKey.trim().length > 0) return envKey.trim();
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  try {
    const raw = await readFile(join(homedir(), ".pi", "agent", "auth.json"), "utf8");
    const auth = JSON.parse(raw) as Record<string, { type?: string; key?: string }>;
    const athena = auth["athena"];
    if (athena?.key && athena.key.trim().length > 0) return athena.key.trim();
    throw new OpenRouterError("refine: no athena OpenRouter key in ~/.pi/agent/auth.json");
  } catch (err) {
    if (err instanceof OpenRouterError) throw err;
    throw new OpenRouterError(`refine: cannot read OpenRouter key (env ATHENA_OPENROUTER_KEY or ~/.pi/agent/auth.json): ${String(err)}`);
  }
}

/** Default model resolution: env ATHENA_REFINE_MODEL, falling back to the deepseek default. */
export function resolveRefineModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ATHENA_REFINE_MODEL?.trim().length ? env.ATHENA_REFINE_MODEL.trim() : ATHENA_REFINE_MODEL;
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
        // ALWAYS off — these three tasks need no reasoning; qwen ignores enable_thinking,
        // so reasoning.effort=none is the ONLY reliable way to suppress thinking tokens.
        reasoning: { effort: "none" },
      };
      if (params.schema !== undefined) body.response_format = { type: "json_object", ...(params.schema as object) };

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
      if (!text.trim() && isPresent(payload.reasoning)) {
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
