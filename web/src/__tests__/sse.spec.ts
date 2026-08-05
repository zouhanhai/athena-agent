import { describe, expect, it } from "vitest";
import { consumeSSEStream } from "@/api/sse";

function response(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

async function collect(chunks: string[]) {
  const deltas: string[] = [];
  let done = 0;
  const errors: string[] = [];
  await consumeSSEStream(response(chunks), {
    onDelta: (d) => deltas.push(d),
    onDone: () => done++,
    onError: (e) => errors.push(e),
  });
  return { deltas, done, errors };
}

describe("consumeSSEStream", () => {
  it("dispatches delta events in order", async () => {
    const result = await collect(['data: {"delta":"a"}\n\n', 'data: {"delta":"b"}\n\n']);
    expect(result.deltas).toEqual(["a", "b"]);
  });

  it("calls onDone when a done event arrives", async () => {
    const result = await collect(['data: {"done":true}\n\n']);
    expect(result.done).toBe(1);
  });

  it("calls onError with the error message", async () => {
    const result = await collect(['data: {"error":"boom"}\n\n']);
    expect(result.errors).toEqual(["boom"]);
  });

  it("reassembles deltas split across chunk boundaries", async () => {
    const result = await collect([
      'data: {"de',
      'lta":"hello"}\n\ndata: {"',
      'delta":" world"}\n\n',
    ]);
    expect(result.deltas).toEqual(["hello", " world"]);
  });

  it("handles multiple events within a single chunk", async () => {
    const result = await collect([
      'data: {"delta":"a"}\n\ndata: {"delta":"b"}\n\ndata: {"done":true}\n\n',
    ]);
    expect(result.deltas).toEqual(["a", "b"]);
    expect(result.done).toBe(1);
  });

  it("throws when the response body is missing", async () => {
    const res = new Response(null);
    await expect(consumeSSEStream(res, {})).rejects.toThrow();
  });
});
