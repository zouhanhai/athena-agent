/**
 * Default Athena refinement runner for the ingest pipeline (G4.S1.T4).
 *
 * The ingest task queue takes an optional `refiner` (a plain function) so tests
 * can fake the LLM pass. The production default wires the real `refine_document`
 * Pi custom tool against the dedicated `athena` OpenRouter provider — lazily
 * creating a ModelRuntime on first use (like createAgent does), so the server
 * boots without forcing a model runtime up front.
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
  createRefineDocumentTool,
  type RefineDocumentOptions,
} from "../agents/refine-document.js";
import type { RefineOutputRef } from "../agents/refine-output.js";
import type { Refiner } from "./tasks.js";

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
  let runtimePromise: Promise<ModelRuntime> | undefined;

  return async (markdown: string, topicHint?: string) => {
    runtimePromise ??= import("@earendil-works/pi-coding-agent").then((m) =>
      m.ModelRuntime.create(),
    );
    const runtime = await runtimePromise;
    const tool = createRefineDocumentTool(runtime, options);
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
