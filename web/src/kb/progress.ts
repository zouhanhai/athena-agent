/**
 * Neo4j chunk ingest progress text for the Uploads page (G4.S3.T8).
 *
 * The Neo4j (RAG) stage streams `chunksStored`/`chunksTotal` from the task API.
 * The UI renders "X / Y chunks" while it runs and "Y chunks" once done, plus an
 * ETA estimated from the chunk rate between polls (`samples`).
 */

/** One observed (chunksStored, time) point from a task poll. */
export interface ChunkProgressSample {
  stored: number;
  at: number;
}

/** Chunk-progress subset of the Neo4j stage carried by the task API. */
export interface ChunkStageProgress {
  status: string;
  chunksStored?: number;
  chunksTotal?: number;
}

/** Estimated remaining time (ms) from the chunk rate across poll samples, or
 *  undefined when no rate can be measured (single sample / no forward progress). */
export function estimateChunkEta(
  stored: number,
  total: number,
  samples: ChunkProgressSample[],
  now: number,
): number | undefined {
  if (total <= stored) return 0;
  if (samples.length < 2) return undefined;
  const first = samples[0]!;
  const elapsed = now - first.at;
  const gained = stored - first.stored;
  if (elapsed <= 0 || gained <= 0) return undefined;
  const rate = gained / elapsed;
  return Math.max(0, (total - stored) / rate);
}

/** "5s", "2m 30s", … — human-readable ETA. */
export function formatEta(ms: number): string {
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Uploads-page text for a Neo4j stage: "X / Y chunks", "Y chunks" on done, and
 *  " · ETA …" while running once a rate can be estimated. Empty when the stage
 *  has no chunk totals yet. */
export function chunkProgressText(
  stage: ChunkStageProgress,
  samples: ChunkProgressSample[],
  now = Date.now(),
): string {
  if (typeof stage.chunksTotal !== "number") return "";
  if (stage.status === "done") return `${stage.chunksTotal} chunks`;
  const stored = stage.chunksStored ?? 0;
  const base = `${stored} / ${stage.chunksTotal} chunks`;
  if (stage.status !== "running") return base;
  const eta = estimateChunkEta(stored, stage.chunksTotal, samples, now);
  return eta === undefined ? base : `${base} · ETA ${formatEta(eta)}`;
}
