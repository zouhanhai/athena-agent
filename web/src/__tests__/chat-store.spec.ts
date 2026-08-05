import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useChatStore } from "@/stores/chat";
import { streamChat } from "@/api/chat";

vi.mock("@/api/chat", () => ({
  streamChat: vi.fn(),
  sendChat: vi.fn(),
}));

const streamChatMock = streamChat as unknown as ReturnType<typeof vi.fn>;

interface StreamArgs {
  onDelta: (delta: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

function resolveStream() {
  streamChatMock.mockResolvedValue(undefined);
}

function controllableStream(): { push: (d: string) => void; fail: (msg: string) => void; end: () => void } {
  return {
    push: (d) => {
      const [, , args] = streamChatMock.mock.calls.at(-1)! as [string, string, StreamArgs];
      args.onDelta(d);
    },
    fail: (m) => {
      const [, , args] = streamChatMock.mock.calls.at(-1)! as [string, string, StreamArgs];
      args.onError?.(m);
    },
    end: () => {
      const [, , args] = streamChatMock.mock.calls.at(-1)! as [string, string, StreamArgs];
      args.onDone?.();
    },
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  streamChatMock.mockReset();
});

describe("chat store", () => {
  it("starts with empty messages, no loading/error, and default userId", () => {
    const store = useChatStore();
    expect(store.messages).toEqual([]);
    expect(store.loading).toBe(false);
    expect(store.error).toBe("");
    expect(store.userId).toBe("hermes");
  });

  it("send pushes a user message and streams deltas into an assistant bubble", async () => {
    const stream = controllableStream();
    resolveStream();
    const store = useChatStore();

    const promise = store.send("hello there");
    expect(store.messages[0]).toEqual({ role: "user", content: "hello there" });
    expect(store.messages[1]).toEqual({ role: "assistant", content: "" });
    expect(store.loading).toBe(true);
    expect(streamChatMock).toHaveBeenCalledWith(
      "hermes",
      "hello there",
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );

    stream.push("Hel");
    stream.push("lo");
    stream.end();
    await promise;

    expect(store.messages[1]!.content).toBe("Hello");
    expect(store.loading).toBe(false);
  });

  it("does not send an empty or whitespace message", async () => {
    resolveStream();
    const store = useChatStore();

    await store.send("   ");
    expect(streamChatMock).not.toHaveBeenCalled();
    expect(store.messages).toEqual([]);
    expect(store.loading).toBe(false);
  });

  it("sets error and drops an empty assistant bubble on an SSE error event", async () => {
    const stream = controllableStream();
    resolveStream();
    const store = useChatStore();

    const promise = store.send("ping");
    stream.fail("agent exploded");
    stream.end();
    await promise;

    expect(store.error).toBe("agent exploded");
    expect(store.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(store.loading).toBe(false);
  });

  it("sets error and keeps the partial answer when streaming rejects", async () => {
    streamChatMock.mockRejectedValue(new Error("network down"));
    const store = useChatStore();

    await store.send("ping");

    expect(store.error).toBe("network down");
    expect(store.loading).toBe(false);
  });

  it("reset clears messages, loading and error", () => {
    const store = useChatStore();
    store.messages = [{ role: "user", content: "hi" }];
    store.loading = true;
    store.error = "boom";

    store.reset();

    expect(store.messages).toEqual([]);
    expect(store.loading).toBe(false);
    expect(store.error).toBe("");
  });
});
