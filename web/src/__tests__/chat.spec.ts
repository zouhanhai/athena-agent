import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import ChatView from "@/views/ChatView.vue";

const okReply = {
  ok: true,
  json: async () => ({ reply: "Hello, human." }),
};

type ChatWrapper = VueWrapper<unknown>;

function mountChat(): ChatWrapper {
  return mount(ChatView, {
    global: { plugins: [TDesign] },
  });
}

async function send(wrapper: ChatWrapper, text: string) {
  await wrapper.find(".composer-input input").setValue(text);
  await wrapper.find(".send-button").trigger("click");
  await flushPromises();
}

describe("ChatView personal chat panel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okReply));
  });

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

  it("posts to /api/chat and renders user (right) + assistant (left) bubbles", async () => {
    const wrapper = mountChat();
    await send(wrapper, "Hello there");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  it("sends the userId typed in the header field", async () => {
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

  it("disables the send button and shows loading while a request is pending", async () => {
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const wrapper = mountChat();
    await wrapper.find(".composer-input input").setValue("ping");
    await wrapper.find(".send-button").trigger("click");

    const pendingButton = wrapper.find(".send-button");
    expect((pendingButton.element as HTMLButtonElement).disabled).toBe(true);
    expect(pendingButton.text()).toContain("Sending");

    resolveFetch(okReply);
    await flushPromises();

    expect((wrapper.find(".send-button").element as HTMLButtonElement).disabled).toBe(false);
    wrapper.unmount();
  });

  it("does not send an empty message", async () => {
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
    expect((wrapper.find(".send-button").element as HTMLButtonElement).disabled).toBe(false);
    wrapper.unmount();
  });
});
