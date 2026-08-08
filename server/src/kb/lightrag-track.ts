/**
 * LightRAG track-status model (G3.S5.T3): map the REAL LightRAG backend state
 * (/documents/track_status) onto a task stage and surface chunk progress.
 *
 * The ingest POST returns as soon as LightRAG has *queued* the document — the
 * 202 must NOT be treated as "done". This module turns the per-submission
 * document status into an outcome (pending/running/done/failed) and polls it
 * until LightRAG actually processed (or failed) the document.
 */
import type { LightRagPipelineStatus, LightRagTrackDocument, LightRagTrackStatus } from "./lightrag.js";

export type LightRagTrackState = "pending" | "running" | "done" | "failed";

/** Live progress derived from the LightRAG backend for one submission. */
export interface LightRagTrackProgress {
  /** Raw LightRAG backend status, lowercased (e.g. "processing", "processed", "failed"). */
  backendStatus?: string;
  /** Number of chunks fully processed. */
  chunksProcessed?: number;
  /** Total chunks the document was split into (once chunking has run). */
  chunksCount?: number;
}

export interface LightRagTrackOutcome extends LightRagTrackProgress {
  state: LightRagTrackState;
  error?: string;
}

const PROCESSED = "processed";
const FAILED = "failed";

function normStatus(doc: LightRagTrackDocument): string | undefined {
  return typeof doc.status === "string" ? doc.status.trim().toLowerCase() : undefined;
}

/**
 * Aggregate a track's documents into a single outcome for the task stage.
 * Any FAILED document fails the whole submission; all documents must be
 * PROCESSED before the stage is done — anything else is still running.
 */
export function evaluateTrack(track: LightRagTrackStatus): LightRagTrackOutcome {
  const docs = track.documents ?? [];
  if (docs.length === 0) return { state: "pending" };

  let anyFailed = false;
  let allProcessed = true;
  let firstStatus: string | undefined;
  let firstError: string | undefined;
  let maxChunks: number | undefined;

  for (const doc of docs) {
    const status = normStatus(doc);
    if (!status) continue;
    firstStatus ??= status;
    if (status === FAILED) {
      anyFailed = true;
      firstError ??= doc.error_msg;
    } else if (status !== PROCESSED) {
      allProcessed = false;
    }
    if (typeof doc.chunks_count === "number") {
      maxChunks = maxChunks === undefined ? doc.chunks_count : Math.max(maxChunks, doc.chunks_count);
    }
  }

  if (anyFailed) {
    return { state: "failed", backendStatus: FAILED, chunksCount: maxChunks, error: firstError ?? "LightRAG processing failed" };
  }
  if (allProcessed) {
    const total = maxChunks ?? 0;
    return { state: "done", backendStatus: PROCESSED, chunksProcessed: total, chunksCount: total };
  }
  return { state: "running", backendStatus: firstStatus, chunksProcessed: 0, chunksCount: maxChunks };
}

export interface ChunkProgress {
  processed: number;
  total: number;
}

const CHUNK_RE = /[Cc]hunk\s+(\d+)\s+of\s+(\d+)/;

/** Parse the most recent "Chunk N of M" progress line from pipeline messages. */
export function parseChunkProgress(messages: readonly string[]): ChunkProgress | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const match = messages[i].match(CHUNK_RE);
    if (!match) continue;
    const processed = Number(match[1]);
    const total = Number(match[2]);
    if (Number.isFinite(processed) && Number.isFinite(total) && total > 0 && processed <= total) {
      return { processed, total };
    }
  }
  return undefined;
}

export interface LightRagTrackPollerOptions {
  getTrackStatus: (trackId: string) => Promise<LightRagTrackStatus>;
  /** May be absent when the pipeline-status endpoint is unavailable. */
  getPipelineStatus?: () => Promise<LightRagPipelineStatus | undefined>;
  /** Poll interval between track-status checks. Default: 1500ms. */
  pollIntervalMs?: number;
  /** Stop polling and fail after this long. Default: 10 minutes. */
  timeoutMs?: number;
  /** Injectable sleep for tests. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls a LightRAG submission until it reaches a terminal state (processed /
 * failed), feeding each intermediate outcome to `onProgress` so the task
 * reflects the real backend state instead of a false "done" at submit time.
 */
export class LightRagTrackPoller {
  private readonly getTrackStatus: (trackId: string) => Promise<LightRagTrackStatus>;
  private readonly getPipelineStatus?: () => Promise<LightRagPipelineStatus | undefined>;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: LightRagTrackPollerOptions) {
    this.getTrackStatus = options.getTrackStatus;
    this.getPipelineStatus = options.getPipelineStatus;
    this.pollIntervalMs = options.pollIntervalMs ?? 1500;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    this.sleep = options.sleep ?? realSleep;
  }

  /** One status check, merging pipeline-log chunk progress into the outcome. */
  async pollOnce(trackId: string): Promise<LightRagTrackOutcome> {
    const track = await this.getTrackStatus(trackId);
    const outcome = evaluateTrack(track);
    if (outcome.state === "running" && this.getPipelineStatus) {
      try {
        const pipeline = await this.getPipelineStatus();
        if (!pipeline) return outcome;
        const messages = [
          ...(pipeline.history_messages ?? []),
          ...(pipeline.latest_message ? [pipeline.latest_message] : []),
        ];
        const parsed = parseChunkProgress(messages);
        if (
          parsed &&
          typeof outcome.chunksCount === "number" &&
          outcome.chunksCount > 0 &&
          parsed.total === outcome.chunksCount
        ) {
          outcome.chunksProcessed = Math.min(parsed.processed, outcome.chunksCount);
        }
      } catch {
        // pipeline status is best-effort; a failure must not fail the poll
      }
    }
    return outcome;
  }

  /**
   * Poll until terminal. `onProgress` is invoked after every check (including
   * the terminal one) so callers can update the task live. Throws nothing; a
   * timeout is reported as a failed outcome.
   */
  async wait(
    trackId: string,
    onProgress?: (outcome: LightRagTrackOutcome) => void,
  ): Promise<LightRagTrackOutcome> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const outcome = await this.pollOnce(trackId);
      onProgress?.(outcome);
      if (outcome.state === "done" || outcome.state === "failed") return outcome;
      if (Date.now() >= deadline) {
        return {
          state: "failed",
          backendStatus: outcome.backendStatus,
          chunksProcessed: outcome.chunksProcessed,
          chunksCount: outcome.chunksCount,
          error: "LightRAG processing timed out",
        };
      }
      await this.sleep(this.pollIntervalMs);
    }
  }
}
