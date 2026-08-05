import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import ChatView from "@/views/ChatView.vue";
import { useChatStore } from "@/stores/chat";
import { streamChat } from "@/api/chat";

vi.mock("@/api/chat", () => ({
  streamChat: vi.fn(),
  sendChat: vi.fn(),
}));

const streamChatMock = streamChat as unknown as ReturnType<typeof vi.fn>;

type ChatWrapper = VueWrapper<unknown>;

interface StreamArgs {
  onDelta: (delta: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

function mountChat(): ChatWrapper {
  return mount(ChatView, {
    global: { plugins: [createPinia(), TDesign] },
  });
}

function stubStream() {
  streamChatMock.mockImplementation(
    async (_userId: string, _message: string, args: StreamArgs) => {
      const deltas = ["Hello, ", "human."];
      for (const delta of deltas) args.onDelta(delta);
      args.onDone?.();
    },
  );
}

function controllableStream(): {
  push: (d: string) => void;
  fail: (m: string) => void;
  end: () => void;
} {
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

async function send(wrapper: ChatWrapper, text: string) {
  await wrapper.find(".composer-input textarea").setValue(text);
  await wrapper.find(".send-button").trigger("click");
  await flushPromises();
}

function composerTextarea(wrapper: ChatWrapper) {
  return wrapper.find(".composer-input textarea");
}

async function pressEnter(wrapper: ChatWrapper, shift = false) {
  await composerTextarea(wrapper).trigger("keydown", {
    key: "Enter",
    shiftKey: shift,
  });
  await flushPromises();
}

function sendButton(wrapper: ChatWrapper) {
  return wrapper.find(".send-button").element as HTMLButtonElement;
}

afterEach(() => {
  streamChatMock.mockReset();
});

describe("ChatView personal chat panel (store-backed)", () => {
  it("renders userId field, message list, composer and send button from the store", () => {
    const wrapper = mountChat();
    const store = useChatStore();

    expect(wrapper.text()).toContain("Personal Chat");
    expect((wrapper.find(".user-id-input input").element as HTMLInputElement).value).toBe(
      store.userId,
    );
    expect(wrapper.find(".message-list").exists()).toBe(true);
    expect(wrapper.find(".composer-input textarea").exists()).toBe(true);
    expect(wrapper.find(".send-button").exists()).toBe(true);
    wrapper.unmount();
  });

  it("sends through the store and renders user (right) + streamed assistant (left) bubbles", async () => {
    stubStream();
    const wrapper = mountChat();
    await send(wrapper, "Hello there");

    expect(streamChatMock).toHaveBeenCalledWith(
      "hermes",
      "Hello there",
      expect.objectContaining({ onDelta: expect.any(Function) }),
    );

    const rows = wrapper.findAll(".message-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.classes()).toContain("user");
    expect(rows[0]!.text()).toBe("Hello there");
    expect(rows[1]!.classes()).toContain("assistant");
    expect(rows[1]!.text()).toBe("Hello, human.");
    wrapper.unmount();
  });

  it("typewriter: renders partial assistant content as deltas arrive through the store", async () => {
    streamChatMock.mockResolvedValue(undefined);
    const wrapper = mountChat();
    await wrapper.find(".composer-input textarea").setValue("ping");
    await wrapper.find(".send-button").trigger("click");

    const stream = controllableStream();
    stream.push("Hel");
    await flushPromises();
    expect(wrapper.find(".message-row.assistant .bubble").text()).toBe("Hel");

    stream.push("lo");
    await flushPromises();
    expect(wrapper.find(".message-row.assistant .bubble").text()).toBe("Hello");

    stream.end();
    await flushPromises();
    wrapper.unmount();
  });

  it("sends the userId typed in the header field", async () => {
    stubStream();
    const wrapper = mountChat();
    await wrapper.find(".user-id-input input").setValue("alice");
    await send(wrapper, "hi");

    expect(streamChatMock).toHaveBeenCalledWith(
      "alice",
      "hi",
      expect.any(Object),
    );
    wrapper.unmount();
  });

  it("disables the send button and shows loading while streaming", async () => {
    streamChatMock.mockImplementation(() => new Promise(() => {}));
    const wrapper = mountChat();
    await wrapper.find(".composer-input textarea").setValue("ping");
    await wrapper.find(".send-button").trigger("click");
    await flushPromises();

    expect(sendButton(wrapper).disabled).toBe(true);
    expect(wrapper.find(".send-button").text()).toContain("Sending");
    wrapper.unmount();
  });

  it("shows an SSE error event via the store and clears loading", async () => {
    streamChatMock.mockImplementation(
      async (_userId: string, _message: string, args: StreamArgs) => {
        args.onError?.("agent exploded");
      },
    );
    const wrapper = mountChat();
    await send(wrapper, "ping");

    expect(wrapper.find(".chat-error").text()).toContain("agent exploded");
    expect(sendButton(wrapper).disabled).toBe(false);
    expect(wrapper.findAll(".message-row")).toHaveLength(1);
    wrapper.unmount();
  });

  it("does not send an empty message through the store", async () => {
    const wrapper = mountChat();
    await wrapper.find(".send-button").trigger("click");

    expect(streamChatMock).not.toHaveBeenCalled();
    expect(wrapper.findAll(".message-row")).toHaveLength(0);
    wrapper.unmount();
  });

  it("uses a multiline textarea as the composer input", async () => {
    const wrapper = mountChat();
    expect(composerTextarea(wrapper).element.tagName).toBe("TEXTAREA");
    wrapper.unmount();
  });

  it("sends the message and clears the composer on Enter", async () => {
    stubStream();
    const wrapper = mountChat();
    await composerTextarea(wrapper).setValue("Hello there");
    await pressEnter(wrapper);

    expect(streamChatMock).toHaveBeenCalledWith(
      "hermes",
      "Hello there",
      expect.any(Object),
    );
    expect((composerTextarea(wrapper).element as HTMLTextAreaElement).value).toBe("");
    wrapper.unmount();
  });

  it("does not send on Shift+Enter so the user can insert a newline", async () => {
    streamChatMock.mockResolvedValue(undefined);
    const wrapper = mountChat();
    await composerTextarea(wrapper).setValue("line one");
    await pressEnter(wrapper, true);

    expect(streamChatMock).not.toHaveBeenCalled();
    expect((composerTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(
      "line one",
    );
    wrapper.unmount();
  });

  it("shows an error and clears loading when streaming rejects", async () => {
    streamChatMock.mockRejectedValue(new Error("network down"));
    const wrapper = mountChat();
    await send(wrapper, "ping");

    expect(wrapper.find(".chat-error").text()).toContain("network down");
    expect(sendButton(wrapper).disabled).toBe(false);
    wrapper.unmount();
  });
});
