/**
 * Neo4j chunk ingest progress text for the Uploads page (G4.S3.T8/T9).
 *
 * The Neo4j (RAG) stage streams `chunksStored`/`chunksTotal` from the task API.
 * The UI renders "X / Y chunks" in the stage label while it runs and "Y chunks"
 * once done. The live ETA — "~ Nm Ns left" — is derived from the rolling
 * average ms per chunk (elapsed vs processed across poll samples) and is
 * recomputed on every `now` tick so it decreases between polls.
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

/** Estimated remaining time (ms) until all chunks embed, or undefined when no
 *  rate can be measured (single sample / no forward progress).
 *
 *  G4.S3.T9: `avgMsPerChunk` is the rolling average of elapsed vs processed
 *  across the poll samples (first → last sample); the estimate is remaining
 *  chunks × avgMsPerChunk, minus the time already spent since the last sample,
 *  so the ETA ticks down as `now` advances between polls.
 */
export function estimateChunkEta(
  stored: number,
  total: number,
  samples: ChunkProgressSample[],
  now: number,
): number | undefined {
  if (total <= stored) return 0;
  if (samples.length < 2) return undefined;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const gained = last.stored - first.stored;
  const elapsed = last.at - first.at;
  if (elapsed <= 0 || gained <= 0) return undefined;
  const avgMsPerChunk = elapsed / gained;
  return Math.max(0, (total - stored) * avgMsPerChunk - Math.max(0, now - last.at));
}

/** "5s", "2m 30s", … — human-readable ETA. */
export function formatEta(ms: number): string {
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** Uploads-page stage-label text for a Neo4j stage: "X / Y chunks" while it
 *  runs, "Y chunks" once done. Empty when the stage has no chunk totals yet.
 *  The live ETA lives in `chunkEtaText` (G4.S3.T9). */
export function chunkProgressText(
  stage: ChunkStageProgress,
  _samples: ChunkProgressSample[],
  _now = Date.now(),
): string {
  if (typeof stage.chunksTotal !== "number") return "";
  if (stage.status === "done") return `${stage.chunksTotal} chunks`;
  const stored = stage.chunksStored ?? 0;
  return `${stored} / ${stage.chunksTotal} chunks`;
}

/** Live ETA text for a running Neo4j stage: "~ Nm Ns left", or "" when there is
 *  no per-chunk baseline yet (before RAG / no measured rate) or the stage is
 *  done. Recompute on every `now` tick so it stays live between polls (G4.S3.T9). */
export function chunkEtaText(
  stage: ChunkStageProgress,
  samples: ChunkProgressSample[],
  now = Date.now(),
): string {
  if (stage.status !== "running") return "";
  if (typeof stage.chunksTotal !== "number") return "";
  const stored = stage.chunksStored ?? 0;
  const eta = estimateChunkEta(stored, stage.chunksTotal, samples, now);
  return eta === undefined ? "" : `~ ${formatEta(eta)} left`;
}
