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

describe("sendChat (非流式)", () => {
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

  it("rejects when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(sendChat("hermes", "hi")).rejects.toThrow("network down");
  });
});

describe("streamChat (流式)", () => {
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

  it("throws with the status when the response is not ok", async () => {
    stubFetch(jsonResponse({ error: "bad" }, 400));
    await expect(
      streamChat("hermes", "hi", { onDelta: () => {} }),
    ).rejects.toThrow("400");
  });
});
