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
import {
  createRefineDocumentTool,
  defaultRefinementOutputDir,
  runWikiEditRefine,
  type RefineDocumentOptions,
} from "../agents/refine-document.js";
import { deriveStemWithFileName, mergeObjectiveDefectsIntoQuality, storeRefinementOutput } from "../agents/refine-output.js";
import { mechanicalWikiEditChunks } from "../agents/refine-document.js";
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
  return async (markdown: string, topicHint?: string, fileName?: string) => {
    const tool = createRefineDocumentTool({} as never, options);
    const result = await tool.execute(
      "refine_document",
      { markdown, ...(topicHint ? { topic_hint: topicHint } : {}), ...(fileName ? { file_name: fileName } : {}) },
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
 *
 * G4.S8.T16: this runner previously lazily created a Pi `ModelRuntime` for
 * `completeSimple` (accidental reasoning:max, no timeout). The pass now goes
 * through `runWikiEditRefine`'s DIRECT OpenRouter transport — same as the
 * upload path — gaining the unified reasoning strategy, timeout/retry and
 * provider.ignore; NO Pi runtime is created at all.
 */
export function createAthenaWikiEditRefiner(
  options: { storageDir?: string; retries?: number } = {},
): WikiEditRefiner {
  return async (input: {
    markdown: string;
    before: string;
    diff: string;
    structural: boolean;
    type?: string;
    topic?: string;
    /** Upload/page file name for stem derivation when the body has no h1 (G4.S8.T18). */
    fileName?: string;
  }) => {
    const existing = {
      ...(input.type ? { type: input.type } : {}),
      ...(input.topic ? { topic: input.topic } : {}),
    };
    const { document } = await runWikiEditRefine(
      { markdown: input.markdown, before: input.before, diff: input.diff, structural: input.structural },
      existing,
      { retries: options.retries },
    );
    // G4.S8.T18: the wiki-edit path runs the SAME deterministic placeholder scan
    // over its rebuilt markdown — objective defects force review_required here too.
    // G4.8 delta contract: the CORRECTED markdown lives in input.markdown (the
    // user's edit is the source of truth). The LLM does not re-emit it; force
    // the document to carry it so downstream store/output use the real text.
    const correctedMarkdown = document.markdown && document.markdown.trim().length > 0
      ? document.markdown
      : input.markdown;
    // G4.8 delta contract: the model emits extraction fields only — its
    // `chunks` may be empty. A wiki-edit overwrite MUST NOT run with zero
    // chunks: overwrite() deletes every old chunk not in the new id set, so an
    // empty list would WIPE the document's chunks from the graph (observed:
    // edit after delta rollout dropped Lüsen's 6 chunks, log said
    // "0 chunks re-embedded"). Rebuild mechanically from the corrected
    // markdown when the model supplied none.
    const chunks = (document.chunks?.length ?? 0) > 0 ? document.chunks : mechanicalWikiEditChunks(correctedMarkdown);
    const documentWithChunks = { ...document, chunks };
    const merged = mergeObjectiveDefectsIntoQuality(document.quality, correctedMarkdown);
    const finalDocument = merged.quality === document.quality ? documentWithChunks : { ...documentWithChunks, quality: merged.quality };
    const ref = await storeRefinementOutput(
      finalDocument,
      options.storageDir ?? defaultRefinementOutputDir(),
      {
        stem: `wiki-edit-${deriveStemWithFileName(input.markdown, input.fileName)}`,
      },
    );
    return {
      ref,
      markdown: finalDocument.markdown,
      newEntities: finalDocument.new_entities,
      newRelations: finalDocument.new_relations,
      rechunked: finalDocument.rechunked,
    };
  };
}
