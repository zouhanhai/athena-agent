import { describe, expect, it } from "vitest";
import { chunkProgressText, chunkEtaText } from "@/kb/progress";

const NOW = 5_000_000;

describe("chunkProgressText (G4.S3.T8)", () => {
  it("shows X / Y chunks while the Neo4j stage runs", () => {
    expect(
      chunkProgressText({ status: "running", chunksStored: 12, chunksTotal: 20 }, [], NOW),
    ).toBe("12 / 20 chunks");
  });

  it("shows the total count once the stage completes", () => {
    expect(
      chunkProgressText({ status: "done", chunksStored: 20, chunksTotal: 20 }, [], NOW),
    ).toBe("20 chunks");
  });

  it("returns nothing when the stage has no chunk totals yet", () => {
    expect(chunkProgressText({ status: "running" }, [], NOW)).toBe("");
    expect(chunkProgressText({ status: "pending" }, [], NOW)).toBe("");
  });
});

describe("chunkEtaText (G4.S3.T9)", () => {
  it("shows a live '~ Nm Ns left' ETA from the rolling avg ms per chunk", () => {
    const samples = [
      { stored: 2, at: NOW - 3000 },
      { stored: 6, at: NOW - 1500 },
    ];
    // avg 375ms/chunk (1500ms / 4 chunks); remaining 14 chunks → 5250ms, minus
    // the 1500ms already elapsed since the last poll → ~3750ms.
    expect(
      chunkEtaText({ status: "running", chunksStored: 6, chunksTotal: 20 }, samples, NOW),
    ).toBe("~ 4s left");
  });

  it("ticks down as `now` advances between polls (live, not frozen)", () => {
    const samples = [
      { stored: 2, at: NOW - 3000 },
      { stored: 6, at: NOW - 1500 },
    ];
    const stage = { status: "running" as const, chunksStored: 6, chunksTotal: 20 };
    expect(chunkEtaText(stage, samples, NOW)).toBe("~ 4s left");
    expect(chunkEtaText(stage, samples, NOW + 2000)).toBe("~ 2s left");
  });

  it("formats minute-scale ETAs as '~ Nm Ns left'", () => {
    const samples = [
      { stored: 0, at: NOW - 1000 },
      { stored: 4, at: NOW },
    ];
    // avg 250ms/chunk; 96 remaining → 24000ms.
    expect(
      chunkEtaText({ status: "running", chunksStored: 4, chunksTotal: 100 }, samples, NOW),
    ).toBe("~ 24s left");
    // 400 chunks remaining at 250ms each → 100s → "~ 1m 40s left"
    expect(
      chunkEtaText({ status: "running", chunksStored: 100, chunksTotal: 500 }, samples, NOW),
    ).toBe("~ 1m 40s left");
  });

  it("returns nothing when there is no measured rate (single poll / no forward progress)", () => {
    expect(
      chunkEtaText({ status: "running", chunksStored: 6, chunksTotal: 20 }, [{ stored: 6, at: NOW - 1500 }], NOW),
    ).toBe("");
    expect(
      chunkEtaText(
        { status: "running", chunksStored: 6, chunksTotal: 20 },
        [
          { stored: 6, at: NOW - 3000 },
          { stored: 6, at: NOW - 1500 },
        ],
        NOW,
      ),
    ).toBe("");
  });

  it("returns nothing before RAG (no totals) or once the stage is done", () => {
    expect(chunkEtaText({ status: "running" }, [], NOW)).toBe("");
    expect(
      chunkEtaText({ status: "done", chunksStored: 20, chunksTotal: 20 }, [{ stored: 20, at: NOW - 1000 }], NOW),
    ).toBe("");
    expect(
      chunkEtaText({ status: "pending", chunksTotal: 20 }, [], NOW),
    ).toBe("");
  });
});
