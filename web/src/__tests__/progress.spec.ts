import { describe, expect, it } from "vitest";
import { chunkProgressText } from "@/kb/progress";

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

  it("estimates an ETA from the per-poll chunk rate while running", () => {
    const samples = [
      { stored: 2, at: NOW - 3000 },
      { stored: 6, at: NOW - 1500 },
    ];
    // rate = (6 - 2) / 3000ms → 1 chunk / 750ms; remaining 14 chunks → 10.5s
    expect(
      chunkProgressText({ status: "running", chunksStored: 6, chunksTotal: 20 }, samples, NOW),
    ).toBe("6 / 20 chunks · ETA 11s");
  });

  it("formats sub-minute ETAs in seconds", () => {
    const samples = [
      { stored: 0, at: NOW - 1000 },
      { stored: 4, at: NOW },
    ];
    expect(
      chunkProgressText({ status: "running", chunksStored: 4, chunksTotal: 100 }, samples, NOW),
    ).toBe("4 / 100 chunks · ETA 24s");
  });

  it("returns nothing when the stage has no chunk totals yet", () => {
    expect(chunkProgressText({ status: "running" }, [], NOW)).toBe("");
    expect(chunkProgressText({ status: "pending" }, [], NOW)).toBe("");
  });

  it("skips the ETA when there is no measured rate (single poll / no forward progress)", () => {
    expect(
      chunkProgressText({ status: "running", chunksStored: 6, chunksTotal: 20 }, [{ stored: 6, at: NOW - 1500 }], NOW),
    ).toBe("6 / 20 chunks");
    expect(
      chunkProgressText(
        { status: "running", chunksStored: 6, chunksTotal: 20 },
        [
          { stored: 6, at: NOW - 3000 },
          { stored: 6, at: NOW - 1500 },
        ],
        NOW,
      ),
    ).toBe("6 / 20 chunks");
  });
});
