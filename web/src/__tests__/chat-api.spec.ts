import { describe, expect, it, vi, afterEach } from "vitest";

import { sendChat, streamChat } from "@/api/chat";

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendChat (non-streaming)", () => {
  it("POSTs { userId, message } without a stream Accept header and returns the reply", async () => {
    stubFetch(jsonResponse({ reply: "Hello back" }));
    const reply = await sendChat("hermes", "hi");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.not.objectContaining({ Accept: expect.any(String) }),
        body: JSON.stringify({ userId: "hermes", message: "hi" }),
      }),
    );
    expect(reply).toBe("Hello back");
  });

  it("throws with the status when the response is not ok", async () => {
    stubFetch(jsonResponse({ error: "boom" }, 500));
    await expect(sendChat("hermes", "hi")).rejects.toThrow("500");
  });

  it("includes the current page in the request body when provided", async () => {
    stubFetch(jsonResponse({ reply: "ok" }));
    await sendChat("hermes", "hi", "/workbench");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        body: JSON.stringify({ userId: "hermes", message: "hi", page: "/workbench" }),
      }),
    );
  });

  it("omits the page field when no page is provided", async () => {
    stubFetch(jsonResponse({ reply: "ok" }));
    await sendChat("hermes", "hi");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        body: JSON.stringify({ userId: "hermes", message: "hi" }),
      }),
    );
  });

  it("rejects when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(sendChat("hermes", "hi")).rejects.toThrow("network down");
  });

  it("includes the accumulated history in the request body when provided (G4.S7.T10)", async () => {
    stubFetch(jsonResponse({ reply: "ok" }));
    const history = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
    ];
    await sendChat("hermes", "next", "/workbench", undefined, history);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        body: JSON.stringify({
          userId: "hermes",
          message: "next",
          page: "/workbench",
          history,
        }),
      }),
    );
  });

  it("omits the history field when none is provided", async () => {
    stubFetch(jsonResponse({ reply: "ok" }));
    await sendChat("hermes", "hi");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const body = (fetchMock.mock.calls[0]![1] as { body: string }).body;
    expect(JSON.parse(body)).toEqual({ userId: "hermes", message: "hi" });
  });
});

describe("streamChat (streaming)", () => {
  it("POSTs with Accept: text/event-stream and feeds deltas to onDelta", async () => {
    stubFetch(sseResponse(['data: {"delta":"Hel"}\n\n', 'data: {"delta":"lo"}\n\n', 'data: {"done":true}\n\n']));

    const deltas: string[] = [];
    let doneCalled = false;
    await streamChat("hermes", "hi", {
      onDelta: (delta) => deltas.push(delta),
      onDone: () => {
        doneCalled = true;
      },
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Accept: "text/event-stream" }),
        body: JSON.stringify({ userId: "hermes", message: "hi" }),
      }),
    );
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(doneCalled).toBe(true);
  });

  it("forwards SSE error events to onError", async () => {
    stubFetch(sseResponse(['data: {"error":"agent exploded"}\n\n']));
    const errors: string[] = [];
    await streamChat("hermes", "hi", {
      onDelta: () => {},
      onError: (message) => errors.push(message),
    });
    expect(errors).toEqual(["agent exploded"]);
  });

  it("forwards a clarify event to onClarify", async () => {
    stubFetch(sseResponse(['data: {"clarify":{"question":"Which do you mean?","options":["company","person"],"query":"what is caleo"}}\n\n']));
    const clarifies: Array<{ question: string; options: string[]; query?: string }> = [];
    await streamChat("hermes", "hi", {
      onDelta: () => {},
      onClarify: (clarify) => clarifies.push(clarify),
    });
    expect(clarifies).toEqual([
      { question: "Which do you mean?", options: ["company", "person"], query: "what is caleo" },
    ]);
  });

  it("includes a clarify answer (query + chosen option) in the request body to re-run the query", async () => {
    stubFetch(sseResponse(['data: {"done":true}\n\n']));
    await streamChat("hermes", "company", { onDelta: () => {} }, "/knowledge", {
      query: "what is caleo",
      answer: "company",
    });

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        body: JSON.stringify({
          userId: "hermes",
          message: "company",
          page: "/knowledge",
          clarify: { query: "what is caleo", answer: "company" },
        }),
      }),
    );
  });

  it("omits the clarify field when no clarification answer is provided", async () => {
    stubFetch(sseResponse(['data: {"done":true}\n\n']));
    await streamChat("hermes", "hi", { onDelta: () => {} }, "/knowledge");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const body = (fetchMock.mock.calls[0]![1] as { body: string }).body;
    expect(JSON.parse(body)).toEqual({ userId: "hermes", message: "hi", page: "/knowledge" });
  });

  it("throws with the status when the response is not ok", async () => {
    stubFetch(jsonResponse({ error: "bad" }, 400));
    await expect(
      streamChat("hermes", "hi", { onDelta: () => {} }),
    ).rejects.toThrow("400");
  });

  it("streams with the current page included in the request body", async () => {
    stubFetch(sseResponse(['data: {"done":true}\n\n']));
    await streamChat("hermes", "hi", { onDelta: () => {} }, "/knowledge");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        body: JSON.stringify({ userId: "hermes", message: "hi", page: "/knowledge" }),
      }),
    );
  });

  it("includes the accumulated history in the streaming request body (G4.S7.T10)", async () => {
    stubFetch(sseResponse(['data: {"done":true}\n\n']));
    const history = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    await streamChat("hermes", "deploy", { onDelta: () => {} }, "/workbench", undefined, "agent-1", history);

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        body: JSON.stringify({
          userId: "hermes",
          message: "deploy",
          page: "/workbench",
          agent_id: "agent-1",
          history,
        }),
      }),
    );
  });

  it("omits the history field when no history is provided", async () => {
    stubFetch(sseResponse(['data: {"done":true}\n\n']));
    await streamChat("hermes", "hi", { onDelta: () => {} }, "/knowledge");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const body = (fetchMock.mock.calls[0]![1] as { body: string }).body;
    expect(JSON.parse(body)).toEqual({ userId: "hermes", message: "hi", page: "/knowledge" });
  });
});
