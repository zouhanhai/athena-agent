/**
 * Tests for the LightRAG track-status model: mapping the real LightRAG
 * backend status (/documents/track_status) onto the task stage, parsing
 * chunk progress from the pipeline log, and the poller loop that keeps the
 * task honest — no "done" until LightRAG reports the document processed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTrack,
  LightRagTrackPoller,
  parseChunkProgress,
} from "../../src/kb/lightrag-track.js";
import type { LightRagTrackStatus } from "../../src/kb/lightrag.js";

function track(documents: LightRagTrackStatus["documents"]): LightRagTrackStatus {
  return { track_id: "t1", documents, total_count: documents.length };
}

/** Fake getTrackStatus that walks a fixed status sequence (last repeats). */
function sequencedTrack(
  statuses: string[],
  opts: { chunksCount?: number; errorMsg?: string } = {},
): () => Promise<LightRagTrackStatus> {
  let index = 0;
  return async () => {
    const status = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    return track([
      {
        id: "d1",
        status,
        ...(opts.chunksCount !== undefined ? { chunks_count: opts.chunksCount } : {}),
        ...(opts.errorMsg !== undefined ? { error_msg: opts.errorMsg } : {}),
      },
    ]);
  };
}

test("evaluateTrack: no documents yet → pending", () => {
  assert.deepEqual(evaluateTrack(track([])), { state: "pending" });
});

test("evaluateTrack: processing → running with the real backend status", () => {
  const outcome = evaluateTrack(track([{ id: "d1", status: "processing" }]));
  assert.equal(outcome.state, "running");
  assert.equal(outcome.backendStatus, "processing");
});

test("evaluateTrack: processed → done with full chunk counts", () => {
  const outcome = evaluateTrack(
    track([{ id: "d1", status: "processed", chunks_count: 182 }]),
  );
  assert.equal(outcome.state, "done");
  assert.equal(outcome.backendStatus, "processed");
  assert.equal(outcome.chunksCount, 182);
  assert.equal(outcome.chunksProcessed, 182);
});

test("evaluateTrack: failed → failed with the backend error message", () => {
  const outcome = evaluateTrack(
    track([{ id: "d1", status: "failed", error_msg: "chunking exploded" }]),
  );
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.error, "chunking exploded");
});

test("evaluateTrack: any failed doc fails the whole track", () => {
  const outcome = evaluateTrack(
    track([
      { id: "d1", status: "processed", chunks_count: 10 },
      { id: "d2", status: "failed", error_msg: "bad chunk" },
    ]),
  );
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.error, "bad chunk");
});

test("evaluateTrack: backend statuses are matched case-insensitively", () => {
  const outcome = evaluateTrack(track([{ id: "d1", status: "PROCESSED" }]));
  assert.equal(outcome.state, "done");
  assert.equal(outcome.backendStatus, "processed");
});

test("evaluateTrack: max chunks_count is surfaced while running", () => {
  const outcome = evaluateTrack(track([{ id: "d1", status: "processing", chunks_count: 182 }]));
  assert.equal(outcome.state, "running");
  assert.equal(outcome.chunksCount, 182);
  assert.equal(outcome.chunksProcessed, 0);
});

test("parseChunkProgress: reads 'Chunk N of M' from pipeline messages", () => {
  const parsed = parseChunkProgress(["Indexing files", "Chunk 12 of 182 extracted 3 Ent + 2 Rel key"]);
  assert.deepEqual(parsed, { processed: 12, total: 182 });
});

test("parseChunkProgress: case-insensitive and picks the latest line", () => {
  const parsed = parseChunkProgress(["chunk 5 of 10 ...", "Chunk 8 of 10 ...", "done"]);
  assert.deepEqual(parsed, { processed: 8, total: 10 });
});

test("parseChunkProgress: undefined when no chunk progress line exists", () => {
  assert.equal(parseChunkProgress(["Indexing files", "Completed processing file 1/3"]), undefined);
});

test("poller: returns done when the track is processed on the first poll", async () => {
  const getTrackStatus = sequencedTrack(["processed"], { chunksCount: 182 });
  const poller = new LightRagTrackPoller({ getTrackStatus, sleep: async () => {} });
  const outcome = await poller.wait("t1");
  assert.equal(outcome.state, "done");
  assert.equal(outcome.chunksCount, 182);
});

test("poller: keeps polling while processing and reports each state via onProgress", async () => {
  const getTrackStatus = sequencedTrack(["processing", "processing", "processed"], { chunksCount: 182 });
  const seen: string[] = [];
  const poller = new LightRagTrackPoller({
    getTrackStatus,
    pollIntervalMs: 1,
    sleep: async () => {},
  });
  const outcome = await poller.wait("t1", (o) => seen.push(`${o.state}:${o.backendStatus}`));
  assert.equal(outcome.state, "done");
  assert.deepEqual(seen, ["running:processing", "running:processing", "done:processed"]);
});

test("poller: surfaces a failed track with the backend error", async () => {
  const getTrackStatus = async () =>
    track([{ id: "d1", status: "failed", error_msg: "bad chunk" }]);
  const poller = new LightRagTrackPoller({ getTrackStatus, sleep: async () => {} });
  const outcome = await poller.wait("t1");
  assert.equal(outcome.state, "failed");
  assert.match(outcome.error ?? "", /bad chunk/);
});

test("poller: merges 'Chunk N of M' pipeline log into running progress", async () => {
  const getTrackStatus = sequencedTrack(["processing", "processed"], { chunksCount: 182 });
  const getPipelineStatus = async () => ({
    history_messages: ["Indexing files", "Chunk 12 of 182 extracted 3 Ent + 2 Rel chunk-abc"],
  });
  const seen: Array<{ chunksProcessed?: number; chunksCount?: number }> = [];
  const poller = new LightRagTrackPoller({
    getTrackStatus,
    getPipelineStatus,
    pollIntervalMs: 1,
    sleep: async () => {},
  });
  await poller.wait("t1", (o) => seen.push(o));
  assert.equal(seen[0].state, "running");
  assert.equal(seen[0].chunksProcessed, 12);
  assert.equal(seen[0].chunksCount, 182);
});

test("poller: ignores pipeline progress whose total does not match the doc's chunks", async () => {
  const getTrackStatus = sequencedTrack(["processing", "processed"], { chunksCount: 182 });
  const getPipelineStatus = async () => ({
    history_messages: ["Chunk 3 of 999 extracted 0 Ent + 0 Rel other-doc"],
  });
  const seen: Array<{ chunksProcessed?: number }> = [];
  const poller = new LightRagTrackPoller({
    getTrackStatus,
    getPipelineStatus,
    pollIntervalMs: 1,
    sleep: async () => {},
  });
  await poller.wait("t1", (o) => seen.push(o));
  assert.equal(seen[0].chunksProcessed, 0);
});

test("poller: times out and fails when the backend never finishes", async () => {
  const getTrackStatus = sequencedTrack(["processing"], {});
  const poller = new LightRagTrackPoller({
    getTrackStatus,
    pollIntervalMs: 1,
    timeoutMs: 50,
    sleep: async () => {},
  });
  const outcome = await poller.wait("t1");
  assert.equal(outcome.state, "failed");
  assert.match(outcome.error ?? "", /timed out/);
});

test("poller: a pipeline-status failure must not fail the poll", async () => {
  const getTrackStatus = sequencedTrack(["processing", "processed"], { chunksCount: 182 });
  const getPipelineStatus = async () => {
    throw new Error("pipeline down");
  };
  const poller = new LightRagTrackPoller({
    getTrackStatus,
    getPipelineStatus,
    pollIntervalMs: 1,
    sleep: async () => {},
  });
  const outcome = await poller.wait("t1");
  assert.equal(outcome.state, "done");
});
