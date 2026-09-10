import { describe, expect, it, vi, afterEach } from "vitest";

import {
  getHeaderReviewOutline,
  putHeaderReviewDraft,
  approveHeaderReview,
  skipHeaderReview,
  assistHeaderReview,
  getHeaderReviewSettings,
  putHeaderReviewSettings,
} from "@/api/kb";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const OUTLINE = {
  taskId: "t1",
  state: "pending",
  headingCount: 2,
  cards: [
    { id: "h0", index: 0, text: "Intro", originalLevel: 1, originalOrder: 0, originalParentId: null, bold: false, parentId: null, order: 0, level: 1 },
    { id: "h1", index: 1, text: "Purpose", originalLevel: 2, originalOrder: 0, originalParentId: "h0", bold: false, parentId: "h0", order: 0, level: 2 },
  ],
  draft: null,
  changes: 0,
};

describe("header-review api", () => {
  it("getHeaderReviewOutline GETs the task outline URL", async () => {
    stubFetch(jsonResponse(OUTLINE));
    const view = await getHeaderReviewOutline("t1");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/kb/task/t1/header-review");
    expect(view.headingCount).toBe(2);
  });

  it("putHeaderReviewDraft PUTs the ops payload", async () => {
    stubFetch(jsonResponse({ ops: [{ type: "bold", index: 1 }], cards: OUTLINE.cards, changes: 1, updatedAt: 1 }));
    const result = await putHeaderReviewDraft("t1", [{ type: "bold", index: 1 }]);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: string }];
    expect(url).toBe("/api/kb/task/t1/header-review/draft");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ ops: [{ type: "bold", index: 1 }] });
    expect(result.changes).toBe(1);
  });

  it("approve/skip POST to the task endpoints with the reviewer name", async () => {
    stubFetch(jsonResponse({ ok: true, edits: { ops: 1, bold: 1, moves: 0, levels: 0 }, changes: 1 }));
    await approveHeaderReview("t1", "hartmut");
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: string }];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ who: "hartmut" });

    stubFetch(jsonResponse({ ok: true }));
    const skipMock = fetch as unknown as ReturnType<typeof vi.fn>;
    await skipHeaderReview("t1");
    const calls = skipMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/kb/task/t1/header-review/skip");
  });

  it("assist posts the sampled outline; settings get/put round-trip", async () => {
    stubFetch(jsonResponse({ suggestions: [] }));
    await assistHeaderReview("t1", { rows: [{ index: 0, text: "Intro", level: 1 }], sampleIndexes: [1] });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { body: string }];
    expect(url).toBe("/api/kb/task/t1/header-review/assist");
    expect(JSON.parse(init.body).sampleIndexes).toEqual([1]);

    stubFetch(jsonResponse({ enabled: true, minHeaders: 32, templateWords: ["Purpose"] }));
    const settings = await getHeaderReviewSettings();
    expect(settings.enabled).toBe(true);

    stubFetch(jsonResponse({ enabled: false, minHeaders: 8, templateWords: ["x"] }));
    const updated = await putHeaderReviewSettings({ enabled: false });
    expect(updated.minHeaders).toBe(8);
  });
});