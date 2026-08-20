/**
 * Default Athena refinement runner for the ingest pipeline (G4.S1.T4).
 *
 * The ingest task queue takes an optional `refiner` (a plain function) so tests
 * can fake the LLM pass. The production default wires the real `refine_document`
 * Pi custom tool, which (G4.S8.T2) calls OpenRouter DIRECTLY for the three
 * refinement LLM passes — no Pi `ModelRuntime` is created at all: reasoning is
 * OFF (effort none), with a hard timeout + retry so a stalled provider can never
 * hang the ingest queue.
 *
 * The tool returns the SMALL big-output ref (frontmatter/entities/keywords/
 * quality/md_ref/chunks_ref); this runner also reads the full re-leveled
 * markdown back from md_ref so downstream consumes by reference (pi-docparser
 * pattern). Falls back to the input markdown when the read fails.
 *
 * G4.S1.T6 two-file design: `md_ref` is File A′ (refined headers + image refs —
 * durable, for llm_wiki); `rag_md_ref` is File B (refined text-only — the RAG
 * working copy). Both are returned so the ingest task queue can feed llm_wiki
 * File A′ and RAG File B, then delete File B once RAG ingestion is done.
 */
import { readFile } from "node:fs/promises";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ATHENA_PROVIDER,
  createRefineDocumentTool,
  defaultRefinementOutputDir,
  runWikiEditRefine,
  type RefineDocumentOptions,
} from "../agents/refine-document.js";
import { deriveStem, storeRefinementOutput } from "../agents/refine-output.js";
import type { RefineOutputRef } from "../agents/refine-output.js";
import type { Refiner, WikiEditRefiner } from "./tasks.js";

/** Best-effort read of a stored markdown file; falls back to the input markdown. */
async function readStored(path: string | undefined, fallback: string): Promise<string> {
  if (!path) return fallback;
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

/** Build the default Athena refiner for the ingest pipeline. */
export function createAthenaRefiner(options: RefineDocumentOptions = {}): Refiner {
  return async (markdown: string, topicHint?: string) => {
    const tool = createRefineDocumentTool({} as never, options);
    const result = await tool.execute(
      "refine_document",
      { markdown, ...(topicHint ? { topic_hint: topicHint } : {}) },
      undefined,
      undefined,
      {} as never,
    );
    const text = (result.content as { type: string; text?: string }[]).find(
      (part) => part.type === "text",
    )?.text;
    if (!text) throw new Error("refine_document returned no content");
    const ref = JSON.parse(text) as RefineOutputRef;
    // File A′ (durable, llm_wiki) + File B (RAG working copy, text-only)
    const fileAPrime = await readStored(ref.md_ref, markdown);
    const ragMarkdown = await readStored(ref.rag_md_ref, fileAPrime);
    return { ref, markdown: fileAPrime, ragMarkdown };
  };
}

/**
 * Build the default Athena wiki-edit diff-refine runner (G4.S3.T10). Input is
 * the corrected wiki markdown (ragMarkdown form — image refs stripped, VLM
 * alt-text kept) + the minimal diff; Athena PRESERVES the corrected text
 * verbatim and re-derives structure. The full corrected markdown + chunks are
 * stored (pi-docparser big-output pattern) and the SMALL ref returned, exactly
 * like `createAthenaRefiner` for the normal ingest path.
 */
export function createAthenaWikiEditRefiner(
  options: { storageDir?: string; thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; retries?: number } = {},
): WikiEditRefiner {
  let runtimePromise: Promise<ModelRuntime> | undefined;

  return async (input: {
    markdown: string;
    before: string;
    diff: string;
    structural: boolean;
    type?: string;
    topic?: string;
  }) => {
    runtimePromise ??= import("@earendil-works/pi-coding-agent").then((m) =>
      m.ModelRuntime.create(),
    );
    const runtime = await runtimePromise;
    const model = runtime.getModel(ATHENA_PROVIDER, "~deepseek/deepseek-v4-flash-latest");
    if (!model) {
      throw new Error("wiki edit refine: athena model not found");
    }
    const existing = {
      ...(input.type ? { type: input.type } : {}),
      ...(input.topic ? { topic: input.topic } : {}),
    };
    const { document } = await runWikiEditRefine(
      runtime,
      model,
      { markdown: input.markdown, before: input.before, diff: input.diff, structural: input.structural },
      existing,
      { thinkingLevel: options.thinkingLevel, retries: options.retries },
    );
    const ref = await storeRefinementOutput(
      document,
      options.storageDir ?? defaultRefinementOutputDir(),
      {
        stem: `wiki-edit-${deriveStem(input.markdown)}`,
      },
    );
    return {
      ref,
      markdown: document.markdown,
      newEntities: document.new_entities,
      newRelations: document.new_relations,
      rechunked: document.rechunked,
    };
  };
}
