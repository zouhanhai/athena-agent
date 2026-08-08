import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import GlobalChatPanel from "@/components/GlobalChatPanel.vue";
import { useChatStore } from "@/stores/chat";
import { streamChat } from "@/api/chat";
import { listAgents } from "@/api/agents";
import { listEmployees } from "@/api/invitations";

vi.mock("@/api/chat", () => ({
  streamChat: vi.fn(),
  sendChat: vi.fn(),
}));

vi.mock("@/api/agents", () => ({
  listAgents: vi.fn(),
}));

vi.mock("@/api/invitations", () => ({
  listEmployees: vi.fn(),
}));

const streamChatMock = streamChat as unknown as ReturnType<typeof vi.fn>;
const listAgentsMock = listAgents as unknown as ReturnType<typeof vi.fn>;
const listEmployeesMock = listEmployees as unknown as ReturnType<typeof vi.fn>;

const HERMES_AGENT = {
  id: "a2",
  alias: "Hermes",
  owner_employee_id: "e1",
  logo_url: "/logos/fox.png",
  runtime: "local",
  created_at: "",
  updated_at: "",
  capabilities: {
    system: "opencode",
    mcp: ["github"],
    tools: [],
    skills: [],
    specialty: "software-engineering",
    description: "",
  },
};

type ChatWrapper = VueWrapper<unknown>;

interface StreamArgs {
  onDelta: (delta: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

function mountChat(): ChatWrapper {
  return mount(GlobalChatPanel, {
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
  listAgentsMock.mockReset();
  listEmployeesMock.mockReset();
});

describe("GlobalChatPanel personal chat panel (store-backed)", () => {
  it("renders message list, composer and send button from the store", () => {
    const wrapper = mountChat();

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
      "",
    );

    const rows = wrapper.findAll(".message-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.classes()).toContain("user");
    expect(rows[0]!.find(".bubble").text()).toBe("Hello there");
    expect(rows[1]!.classes()).toContain("assistant");
    expect(rows[1]!.find(".bubble").text()).toBe("Hello, human.");
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

  it("sends using the store userId when no identity is set", async () => {
    stubStream();
    const wrapper = mountChat();
    const store = useChatStore();
    await send(wrapper, "hi");

    expect(streamChatMock).toHaveBeenCalledWith(
      store.userId,
      "hi",
      expect.any(Object),
      "",
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
      "",
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

  it("tracks the page context in the store without a header badge", async () => {
    const wrapper = mountChat();
    const store = useChatStore();
    store.setPage("/workbench");
    await flushPromises();

    expect(store.page).toBe("/workbench");
    expect(wrapper.find(".page-context").exists()).toBe(false);
    wrapper.unmount();
  });

  it("hides the page-context badge on unknown pages", async () => {
    const wrapper = mountChat();
    const store = useChatStore();
    store.setPage("/kanban");
    await flushPromises();

    expect(wrapper.find(".page-context").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("GlobalChatPanel agent cards", () => {
  it("renders the default Athena agent card above the chat", () => {
    const wrapper = mountChat();
    const card = wrapper.find(".agent-card");
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain("Athena");
    expect(card.find(".agent-card-logo").attributes("src")).toBe("/athena-logo-ai.png");
    wrapper.unmount();
  });

  it("renders a speak-toggle and an X remove button on each agent card", () => {
    const wrapper = mountChat();
    const card = wrapper.find(".agent-card");
    expect(card.find(".speak-toggle").exists()).toBe(true);
    expect(card.find(".card-remove").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows a joined agent's capabilities on its card", async () => {
    const wrapper = mountChat();
    const store = useChatStore();
    store.onAgentJoined({
      id: "hermes::Hermes",
      kind: "agent",
      name: "Hermes",
      logoUrl: "/logos/fox.png",
      capabilities: ["github"],
    });
    await wrapper.vm.$nextTick();

    const hermesCard = wrapper
      .findAll(".agent-card")
      .find((c) => c.text().includes("Hermes"));
    expect(hermesCard).toBeDefined();
    expect(hermesCard!.findAll(".cap-chip")).toHaveLength(1);
    expect(hermesCard!.text()).toContain("github");
    wrapper.unmount();
  });

  it("renders add-agent and add-employee entries above the chat", () => {
    const wrapper = mountChat();
    expect(wrapper.find(".add-agent-entry").exists()).toBe(true);
    expect(wrapper.find(".add-employee-entry").exists()).toBe(true);
    wrapper.unmount();
  });

  it("adds an agent via the add-agent entry and fires onAgentJoined (card + notice)", async () => {
    listAgentsMock.mockResolvedValue([HERMES_AGENT]);
    const wrapper = mountChat();
    const store = useChatStore();

    await wrapper.find(".add-agent-entry").trigger("click");
    await flushPromises();
    expect(wrapper.find(".add-agent-picker").exists()).toBe(true);

    const picker = wrapper.find(".add-agent-picker .picker-option");
    expect(picker.exists()).toBe(true);
    expect(picker.text()).toContain("Hermes");
    await picker.trigger("click");
    await flushPromises();

    expect(store.participants.some((p) => p.name === "Hermes")).toBe(true);
    expect(store.messages.some((m) => m.role === "system" && m.content.includes("Hermes"))).toBe(true);
    const hermesCard = wrapper
      .findAll(".agent-card")
      .find((c) => c.text().includes("Hermes"));
    expect(hermesCard).toBeDefined();
    wrapper.unmount();
  });

  it("removes an agent via the X button and fires onAgentLeft (cleanup + notice)", async () => {
    const wrapper = mountChat();
    const store = useChatStore();
    store.onAgentJoined({
      id: "hermes::Hermes",
      kind: "agent",
      name: "Hermes",
      logoUrl: "/logos/fox.png",
      capabilities: [],
    });
    await wrapper.vm.$nextTick();

    const hermesCard = wrapper
      .findAll(".agent-card")
      .find((c) => c.text().includes("Hermes"))!;
    await hermesCard.find(".card-remove").trigger("click");

    expect(store.participants.some((p) => p.name === "Hermes")).toBe(false);
    expect(store.messages.some((m) => m.role === "system" && m.content.includes("left"))).toBe(true);
    wrapper.unmount();
  });

  it("adds an employee via the add-employee entry and fires onAgentJoined", async () => {
    listEmployeesMock.mockResolvedValue([
      {
        id: "e2",
        email: "carol@caleo.com",
        display_name: "Carol",
        logo_url: "/logos/raven.png",
        role: "member",
        created_at: "",
        updated_at: "",
      },
    ]);
    const wrapper = mountChat();
    const store = useChatStore();

    await wrapper.find(".add-employee-entry").trigger("click");
    await flushPromises();
    expect(wrapper.find(".add-employee-picker").exists()).toBe(true);

    const picker = wrapper.find(".add-employee-picker .picker-option");
    expect(picker.exists()).toBe(true);
    expect(picker.text()).toContain("Carol");
    await picker.trigger("click");
    await flushPromises();

    expect(store.participants.some((p) => p.name === "Carol")).toBe(true);
    expect(store.participants.some((p) => p.kind === "employee")).toBe(true);
    const carolCard = wrapper
      .findAll(".agent-card")
      .find((c) => c.text().includes("Carol"));
    expect(carolCard).toBeDefined();
    wrapper.unmount();
  });

  it("flipping the speak-toggle fires onSpeakToggleChanged and updates speak permission", async () => {
    const wrapper = mountChat();
    const store = useChatStore();
    store.onAgentJoined({
      id: "hermes::Hermes",
      kind: "agent",
      name: "Hermes",
      logoUrl: "/logos/fox.png",
      capabilities: [],
    });
    await wrapper.vm.$nextTick();

    const hermesCard = wrapper
      .findAll(".agent-card")
      .find((c) => c.text().includes("Hermes"))!;
    await hermesCard.find(".speak-toggle").setValue(false);
    await wrapper.vm.$nextTick();

    expect(store.participants.find((p) => p.name === "Hermes")!.speak).toBe(false);
    wrapper.unmount();
  });

  it("shows a speaker logo on each message bubble", async () => {
    stubStream();
    const wrapper = mountChat();
    await send(wrapper, "Hello there");

    const rows = wrapper.findAll(".message-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.find(".speaker-logo").exists()).toBe(true);
    expect(rows[1]!.find(".speaker-logo").exists()).toBe(true);
    expect(rows[1]!.find(".speaker-logo img").attributes("src")).toBe("/athena-logo-ai.png");
    wrapper.unmount();
  });
});
