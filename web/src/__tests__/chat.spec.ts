import { describe, expect, it, vi, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import ChatView from "@/views/ChatView.vue";

type ChatWrapper = VueWrapper<unknown>;

function mountChat(): ChatWrapper {
  return mount(ChatView, {
    global: { plugins: [TDesign] },
  });
}

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

function deltaSSE(...deltas: string[]): Response {
  return sseResponse(deltas.map((d) => `data: ${JSON.stringify({ delta: d })}\n\n`));
}

interface ControllableSSE {
  response: Response;
  push: (chunk: string) => void;
  end: () => void;
}

function controllableSSE(): ControllableSSE {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream),
    push: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
    end: () => controller.close(),
  };
}

function stubFetch(response: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

async function send(wrapper: ChatWrapper, text: string) {
  await wrapper.find(".composer-input input").setValue(text);
  await wrapper.find(".send-button").trigger("click");
  await flushPromises();
}

function sendButton(wrapper: ChatWrapper) {
  return wrapper.find(".send-button").element as HTMLButtonElement;
}

describe("ChatView personal chat panel (SSE streaming)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders userId field, message list, composer and send button", () => {
    const wrapper = mountChat();
    expect(wrapper.text()).toContain("Personal Chat");
    expect((wrapper.find(".user-id-input input").element as HTMLInputElement).value).toBe(
      "hermes",
    );
    expect(wrapper.find(".message-list").exists()).toBe(true);
    expect(wrapper.find(".composer-input input").exists()).toBe(true);
    expect(wrapper.find(".send-button").exists()).toBe(true);
    wrapper.unmount();
  });

  it("posts Accept: text/event-stream and renders user (right) + streamed assistant (left) bubbles", async () => {
    stubFetch(deltaSSE("Hello, ", "human."));
    const wrapper = mountChat();
    await send(wrapper, "Hello there");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Accept: "text/event-stream" }),
        body: JSON.stringify({ userId: "hermes", message: "Hello there" }),
      }),
    );

    const rows = wrapper.findAll(".message-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.classes()).toContain("user");
    expect(rows[0]!.text()).toBe("Hello there");
    expect(rows[1]!.classes()).toContain("assistant");
    expect(rows[1]!.text()).toBe("Hello, human.");
    wrapper.unmount();
  });

  it("typewriter: renders partial assistant content as deltas arrive", async () => {
    const sse = controllableSSE();
    stubFetch(sse.response);
    const wrapper = mountChat();
    await wrapper.find(".composer-input input").setValue("ping");
    await wrapper.find(".send-button").trigger("click");

    sse.push('data: {"delta":"Hel"}\n\n');
    await flushPromises();
    expect(wrapper.find(".message-row.assistant .bubble").text()).toBe("Hel");

    sse.push('data: {"delta":"lo"}\n\n');
    await flushPromises();
    expect(wrapper.find(".message-row.assistant .bubble").text()).toBe("Hello");

    sse.end();
    await flushPromises();
    wrapper.unmount();
  });

  it("sends the userId typed in the header field", async () => {
    stubFetch(deltaSSE("ok"));
    const wrapper = mountChat();
    await wrapper.find(".user-id-input input").setValue("alice");
    await send(wrapper, "hi");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        body: JSON.stringify({ userId: "alice", message: "hi" }),
      }),
    );
    wrapper.unmount();
  });

  it("disables the send button and shows loading while streaming", async () => {
    const sse = controllableSSE();
    stubFetch(sse.response);
    const wrapper = mountChat();
    await wrapper.find(".composer-input input").setValue("ping");
    await wrapper.find(".send-button").trigger("click");
    await flushPromises();

    expect(sendButton(wrapper).disabled).toBe(true);
    expect(wrapper.find(".send-button").text()).toContain("Sending");

    sse.push('data: {"delta":"hi"}\n\n');
    sse.push('data: {"done":true}\n\n');
    sse.end();
    await flushPromises();
    expect(sendButton(wrapper).disabled).toBe(false);
    wrapper.unmount();
  });

  it("ends the stream on the done event and keeps the full answer", async () => {
    const sse = controllableSSE();
    stubFetch(sse.response);
    const wrapper = mountChat();
    await wrapper.find(".composer-input input").setValue("ping");
    await wrapper.find(".send-button").trigger("click");

    sse.push('data: {"delta":"done!"}\n\n');
    sse.push('data: {"done":true}\n\n');
    sse.end();
    await flushPromises();

    expect(wrapper.find(".message-row.assistant .bubble").text()).toBe("done!");
    expect(sendButton(wrapper).disabled).toBe(false);
    expect(wrapper.find(".send-button").text()).toContain("Send");
    wrapper.unmount();
  });

  it("shows an SSE error event and clears loading", async () => {
    const sse = controllableSSE();
    stubFetch(sse.response);
    const wrapper = mountChat();
    await wrapper.find(".composer-input input").setValue("ping");
    await wrapper.find(".send-button").trigger("click");

    sse.push('data: {"error":"agent exploded"}\n\n');
    sse.end();
    await flushPromises();

    expect(wrapper.find(".chat-error").text()).toContain("agent exploded");
    expect(sendButton(wrapper).disabled).toBe(false);
    wrapper.unmount();
  });

  it("does not send an empty message", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const wrapper = mountChat();
    await wrapper.find(".send-button").trigger("click");

    expect(fetch).not.toHaveBeenCalled();
    expect(wrapper.findAll(".message-row")).toHaveLength(0);
    wrapper.unmount();
  });

  it("shows an error and clears loading when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const wrapper = mountChat();
    await send(wrapper, "ping");

    expect(wrapper.find(".chat-error").exists()).toBe(true);
    expect(wrapper.find(".chat-error").text()).toContain("network down");
    expect(sendButton(wrapper).disabled).toBe(false);
    wrapper.unmount();
  });

  it("shows an error when the response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, body: null }),
    );
    const wrapper = mountChat();
    await send(wrapper, "ping");

    expect(wrapper.find(".chat-error").text()).toContain("503");
    expect(sendButton(wrapper).disabled).toBe(false);
    wrapper.unmount();
  });
});
