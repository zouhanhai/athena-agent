import { describe, expect, it } from "vitest";
import { formatAgo, updatedAgoText, isStalled } from "@/kanban/progress";

const NOW = new Date("2026-08-13T09:00:00Z").getTime();

describe("formatAgo", () => {
  it("formats sub-minute deltas as Xs ago", () => {
    expect(formatAgo(5_000)).toBe("5s ago");
    expect(formatAgo(59_000)).toBe("59s ago");
  });

  it("formats minute-scale deltas as Xm ago", () => {
    expect(formatAgo(60_000)).toBe("1m ago");
    expect(formatAgo(5 * 60_000 + 20_000)).toBe("5m ago");
  });

  it("formats hour-scale deltas as Xh ago", () => {
    expect(formatAgo(2 * 60 * 60_000)).toBe("2h ago");
  });

  it("formats day-scale deltas as Xd ago", () => {
    expect(formatAgo(3 * 24 * 60 * 60_000)).toBe("3d ago");
  });

  it("never returns negative values for future timestamps", () => {
    expect(formatAgo(-10_000)).toBe("0s ago");
  });
});

describe("updatedAgoText", () => {
  it("renders 'updated Xs ago' from a recent UTC timestamp", () => {
    expect(updatedAgoText("2026-08-13T08:59:55Z", NOW)).toBe("updated 5s ago");
  });

  it("renders minute-scale updates as 'updated Xm ago'", () => {
    expect(updatedAgoText("2026-08-13T08:50:00Z", NOW)).toBe("updated 10m ago");
  });

  it("returns nothing when there is no progress timestamp", () => {
    expect(updatedAgoText(undefined, NOW)).toBe("");
  });

  it("returns nothing for an unparseable timestamp", () => {
    expect(updatedAgoText("not-a-timestamp", NOW)).toBe("");
  });
});

describe("isStalled (G4.S4.T2)", () => {
  it("flags an in_progress ticket whose last Progress Log row is older than ~3 min", () => {
    expect(isStalled("in_progress", "2026-08-13T08:55:00Z", NOW)).toBe(true);
  });

  it("does NOT flag a freshly-updated in_progress ticket", () => {
    expect(isStalled("in_progress", "2026-08-13T08:59:30Z", NOW)).toBe(false);
  });

  it("does NOT flag a ticket that is not in_progress (stalled is observation only)", () => {
    expect(isStalled("done", "2026-08-13T08:00:00Z", NOW)).toBe(false);
    expect(isStalled("backlog", "2026-08-13T08:00:00Z", NOW)).toBe(false);
  });

  it("does NOT flag an in_progress ticket with no progress log row yet", () => {
    expect(isStalled("in_progress", undefined, NOW)).toBe(false);
  });

  it("honors a custom stall window", () => {
    expect(isStalled("in_progress", "2026-08-13T08:58:30Z", NOW, 60_000)).toBe(true);
    expect(isStalled("in_progress", "2026-08-13T08:58:30Z", NOW, 5 * 60_000)).toBe(false);
  });
});
