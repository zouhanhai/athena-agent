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
 */
import { readFile } from "node:fs/promises";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createRefineDocumentTool,
  type RefineDocumentOptions,
} from "../agents/refine-document.js";
import type { RefineOutputRef } from "../agents/refine-output.js";
import type { Refiner } from "./tasks.js";

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
    let refined = markdown;
    try {
      refined = await readFile(ref.md_ref, "utf8");
    } catch {
      // keep the input when the stored file is unreadable — never worse than today
    }
    return { ref, markdown: refined };
  };
}
