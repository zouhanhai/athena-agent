import { describe, expect, it, vi, afterEach } from "vitest";

import { sendFeedback, listQaPairs } from "@/api/feedback";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendFeedback (G4.S3.T5)", () => {
  it("POSTs { question, answer, sources, feedback } to /api/kb/feedback", async () => {
    const pair = {
      id: "pair-1",
      question: "What is C-Day?",
      answer: "C-Day is the CALEO Day.",
      sources: [{ path: "wiki/events/c-day.md" }],
      feedback: "up",
      created_at: "2026-08-12T00:00:00.000Z",
      updated_at: "2026-08-12T00:00:00.000Z",
    };
    stubFetch(jsonResponse({ pair, deduped: false, confidenceUpdates: [] }));

    const result = await sendFeedback({
      question: "What is C-Day?",
      answer: "C-Day is the CALEO Day.",
      sources: [{ path: "wiki/events/c-day.md" }],
      feedback: "up",
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/kb/feedback",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "What is C-Day?",
          answer: "C-Day is the CALEO Day.",
          sources: [{ path: "wiki/events/c-day.md" }],
          feedback: "up",
        }),
      }),
    );
    expect(result.pair.question).toBe("What is C-Day?");
    expect(result.deduped).toBe(false);
  });

  it("throws with the status when the response is not ok", async () => {
    stubFetch(jsonResponse({ error: "boom" }, 500));
    await expect(
      sendFeedback({ question: "q", answer: "a", feedback: "down" }),
    ).rejects.toThrow("500");
  });

  it("throws when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(
      sendFeedback({ question: "q", answer: "a", feedback: "up" }),
    ).rejects.toThrow("network down");
  });
});

describe("listQaPairs", () => {
  it("GETs /api/kb/qa and returns the pairs", async () => {
    const pairs = [
      {
        id: "pair-1",
        question: "What is C-Day?",
        answer: "the CALEO Day",
        sources: [],
        feedback: "up",
        created_at: "2026-08-12T00:00:00.000Z",
        updated_at: "2026-08-12T00:00:00.000Z",
      },
    ];
    stubFetch(jsonResponse({ pairs }));

    const result = await listQaPairs();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith("/api/kb/qa");
    expect(result).toHaveLength(1);
    expect(result[0]!.question).toBe("What is C-Day?");
  });

  it("throws with the status when the response is not ok", async () => {
    stubFetch(jsonResponse({ error: "boom" }, 500));
    await expect(listQaPairs()).rejects.toThrow("500");
  });
});
