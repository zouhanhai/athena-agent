import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import TDesign from "tdesign-vue-next";
import "tdesign-vue-next/es/style/index.css";

import GlobalChatPanel from "@/components/GlobalChatPanel.vue";
import { useChatStore } from "@/stores/chat";
import { streamChat, fetchChatSessions, fetchChatHistory } from "@/api/chat";
import { listAgents } from "@/api/agents";
import { listEmployees } from "@/api/invitations";
import { sendFeedback } from "@/api/feedback";

vi.mock("@/api/chat", () => ({
  streamChat: vi.fn(),
  sendChat: vi.fn(),
  fetchChatSessions: vi.fn(),
  fetchChatHistory: vi.fn(),
}));

vi.mock("@/api/feedback", () => ({
  sendFeedback: vi.fn(),
  listQaPairs: vi.fn(),
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
const sendFeedbackMock = sendFeedback as unknown as ReturnType<typeof vi.fn>;
const fetchChatSessionsMock = fetchChatSessions as unknown as ReturnType<typeof vi.fn>;
const fetchChatHistoryMock = fetchChatHistory as unknown as ReturnType<typeof vi.fn>;

const HERMES_AGENT = {
  id: "a2",
  alias: "Hermes",
  owner_employee_id: "e1",
  logo_url: "/logos/fox-clean.png",
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
  onClarify?: (clarify: { question: string; options: string[]; query?: string }) => void;
  onThinking?: (text: string) => void;
  onTool?: (tool: { state: string; name: string; detail?: string; output?: string }) => void;
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
  clarify: (c: { question: string; options: string[]; query?: string }) => void;
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
    clarify: (c) => {
      const [, , args] = streamChatMock.mock.calls.at(-1)! as [string, string, StreamArgs];
      args.onClarify?.(c);
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
  sendFeedbackMock.mockReset();
  fetchChatSessionsMock.mockReset();
  fetchChatHistoryMock.mockReset();
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
      undefined,
      undefined,
      [],
      undefined,
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
      undefined,
      undefined,
      [],
      undefined,
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
      undefined,
      undefined,
      [],
      undefined,
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

  it("renders a speak-toggle and an X remove button on each agent card", async () => {
    const wrapper = mountChat();
    const card = wrapper.find(".agent-card");
    // collapsed card shows logo + name; click to expand for the controls
    await card.trigger("click");
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
      logoUrl: "/logos/fox-clean.png",
      capabilities: ["github"],
    });
    await wrapper.vm.$nextTick();

    const hermesCard = wrapper
      .findAll(".agent-card")
      .find((c) => c.text().includes("Hermes"));
    expect(hermesCard).toBeDefined();
    await hermesCard!.trigger("click"); // expand to reveal capabilities
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
      logoUrl: "/logos/fox-clean.png",
      capabilities: [],
    });
    await wrapper.vm.$nextTick();

    const hermesCard = wrapper
      .findAll(".agent-card")
      .find((c) => c.text().includes("Hermes"))!;
    await hermesCard.trigger("click"); // expand to reveal the X remove button
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
        logo_url: "/logos/raven-clean.png",
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
      logoUrl: "/logos/fox-clean.png",
      capabilities: [],
    });
    await wrapper.vm.$nextTick();

    const hermesCard = wrapper
      .findAll(".agent-card")
      .find((c) => c.text().includes("Hermes"))!;
    await hermesCard.trigger("click"); // expand to reveal the speak-toggle
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

describe("GlobalChatPanel feedback loop (G4.S3.T5)", () => {
  it("shows thumbs up/down controls on assistant answers (not on user rows)", async () => {
    stubStream();
    const wrapper = mountChat();
    await send(wrapper, "What is C-Day?");

    const assistant = wrapper.find(".message-row.assistant");
    expect(assistant.find(".feedback-up").exists()).toBe(true);
    expect(assistant.find(".feedback-down").exists()).toBe(true);
    expect(wrapper.find(".message-row.user .feedback-controls").exists()).toBe(false);
    wrapper.unmount();
  });

  it("clicking thumbs up rates the answer through the feedback API", async () => {
    stubStream();
    sendFeedbackMock.mockResolvedValue({ pair: {}, deduped: false, confidenceUpdates: [] });
    const wrapper = mountChat();
    await send(wrapper, "What is C-Day?");

    await wrapper.find(".message-row.assistant .feedback-up").trigger("click");
    await flushPromises();

    expect(sendFeedbackMock).toHaveBeenCalledWith({
      question: "What is C-Day?",
      answer: "Hello, human.",
      sources: [],
      feedback: "up",
    });
    wrapper.unmount();
  });

  it("highlights the active thumbs down after rating", async () => {
    stubStream();
    sendFeedbackMock.mockResolvedValue({ pair: {}, deduped: false, confidenceUpdates: [] });
    const wrapper = mountChat();
    await send(wrapper, "What is C-Day?");

    await wrapper.find(".message-row.assistant .feedback-down").trigger("click");
    await flushPromises();

    expect(wrapper.find(".message-row.assistant .feedback-down.active").exists()).toBe(true);
    expect(wrapper.find(".message-row.assistant .feedback-up.active").exists()).toBe(false);
    wrapper.unmount();
  });
});

describe("GlobalChatPanel context meter + history (G4.S7.T10)", () => {
  it("renders the context meter with a normal state and estimate label once messages exist", async () => {
    const wrapper = mountChat();
    const store = useChatStore();
    store.messages = [
      { role: "user", content: "What is C-Day?" },
      { role: "assistant", content: "The CALEO Day.", speaker: { id: "athena", kind: "agent", name: "Athena", logoUrl: "" } },
    ];
    await wrapper.vm.$nextTick();

    const meter = wrapper.find(".context-meter");
    expect(meter.exists()).toBe(true);
    expect(meter.classes()).toContain("context-normal");
    expect(meter.find(".context-meter-text").text()).toMatch(/~0k \/ 200k tokens/);
    wrapper.unmount();
  });

  it("does not render the meter for an empty conversation", () => {
    const wrapper = mountChat();
    expect(wrapper.find(".context-meter").exists()).toBe(false);
    wrapper.unmount();
  });

  it("enters the warning state at 80–100% of the threshold", async () => {
    const wrapper = mountChat();
    const store = useChatStore();
    // 165k estimated tokens ≈ 660k ASCII chars → ~82.5% of 200k.
    store.messages = [{ role: "user", content: "x".repeat(660_000) }];
    await wrapper.vm.$nextTick();

    const meter = wrapper.find(".context-meter");
    expect(meter.classes()).toContain("context-warning");
    expect(meter.find(".context-meter-text").text()).toMatch(/~165k \/ 200k tokens/);
    wrapper.unmount();
  });

  it("enters the summarizing state at or above the threshold", async () => {
    const wrapper = mountChat();
    const store = useChatStore();
    // 206k estimated tokens ≈ 824k ASCII chars → above the 200k threshold.
    store.messages = [{ role: "user", content: "x".repeat(824_000) }];
    await wrapper.vm.$nextTick();

    const meter = wrapper.find(".context-meter");
    expect(meter.classes()).toContain("context-summarizing");
    wrapper.unmount();
  });

  it("sends the accumulated user/assistant history with each request (empty placeholders filtered)", async () => {
    stubStream();
    const wrapper = mountChat();
    await send(wrapper, "What is C-Day?");
    await send(wrapper, "And who is Hermes?");

    const first = streamChatMock.mock.calls[0]! as unknown[];
    const second = streamChatMock.mock.calls[1]! as unknown[];
    // 7th arg = history; the first send has no prior turns.
    expect(first[6]).toEqual([]);
    expect(second[6]).toEqual([
      { role: "user", content: "What is C-Day?" },
      { role: "assistant", content: "Hello, human." },
    ]);
    wrapper.unmount();
  });

  it("filters out system notices from the sent history (user/assistant only)", async () => {
    stubStream();
    const wrapper = mountChat();
    const store = useChatStore();
    store.onAgentJoined({
      id: "hermes::Hermes",
      kind: "agent",
      name: "Hermes",
      logoUrl: "",
      capabilities: [],
    });
    await send(wrapper, "first question");
    await send(wrapper, "second question");

    // The second request's history = first exchange; the Hermes-joined system
    // notice must be filtered out.
    const call = streamChatMock.mock.calls.at(-1)! as unknown[];
    const history = call[6] as Array<{ role: string; content: string }>;
    expect(history.some((h) => h.role === "system")).toBe(false);
    expect(history).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "Hello, human." },
    ]);
    wrapper.unmount();
  });

  it("historyForRequest includes thinking + tool output on the assistant turn", async () => {
    const wrapper = mountChat();
    const store = useChatStore();
    store.messages = [
      { role: "user", content: "find the bug" },
      {
        role: "assistant",
        content: "looks like a race",
        thinking: "let me reason",
        progress: [
          { name: "shell", state: "completed", detail: "build", output: "build ok" },
        ],
        speaker: { id: "athena", kind: "agent", name: "Athena", logoUrl: "" },
      },
    ];

    expect(historyForRequestOf(store)).toContainEqual({
      role: "assistant",
      content: "looks like a race",
      thinking: "let me reason",
      toolOutput: "build ok",
      toolName: "shell",
    });
    // The user turn stays plain.
    expect(historyForRequestOf(store)).toContainEqual({
      role: "user",
      content: "find the bug",
    });
    wrapper.unmount();
  });

  it("historyForRequest keeps user turns plain and pre-T11 assistant turns (no extras) intact", async () => {
    const wrapper = mountChat();
    const store = useChatStore();
    store.messages = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];
    expect(historyForRequestOf(store)).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
    wrapper.unmount();
  });

  it("context meter reflects thinking + tool output (extras count toward the budget)", async () => {
    const wrapper = mountChat();
    const store = useChatStore();
    // user: 200k chars ≈ 50k tokens; assistant content 200k ≈ 50k; thinking
    // 200k ≈ 50k; tool output (in a progress row) 200k ≈ 50k → ~200k total
    // → summarizing (>= 100% of the 200k threshold).
    store.messages = [
      { role: "user", content: "x".repeat(200_000) },
      {
        role: "assistant",
        content: "x".repeat(200_000),
        thinking: "y".repeat(200_000),
        progress: [
          { name: "shell", state: "completed", output: "z".repeat(200_000) },
        ],
        speaker: { id: "athena", kind: "agent", name: "Athena", logoUrl: "" },
      },
    ];
    await wrapper.vm.$nextTick();

    const meter = wrapper.find(".context-meter");
    expect(meter.classes()).toContain("context-summarizing");
    expect(meter.find(".context-meter-text").text()).toMatch(/~200k \/ 200k tokens/);
    wrapper.unmount();
  });
});

function historyForRequestOf(store: ReturnType<typeof useChatStore>) {
  return (store.historyForRequest() as unknown as Array<{
    role: string;
    content: string;
    thinking?: string;
    toolOutput?: string;
    toolName?: string;
  }>);
}

describe("GlobalChatPanel clarification follow-up (G4.S3.T13)", () => {
  it("renders a clarification question + options on the assistant bubble", async () => {
    streamChatMock.mockResolvedValue(undefined);
    const wrapper = mountChat();
    const store = useChatStore();
    await wrapper.find(".composer-input textarea").setValue("help me with something");
    await wrapper.find(".send-button").trigger("click");

    const stream = controllableStream();
    stream.clarify({ question: "Which do you mean?", options: ["company", "person"], query: "what is caleo" });
    stream.end();
    await flushPromises();

    const assistant = wrapper.find(".message-row.assistant");
    expect(assistant.find(".clarification-question").text()).toBe("Which do you mean?");
    const buttons = assistant.findAll(".clarification-option");
    expect(buttons.map((b) => b.text())).toEqual(["company", "person"]);
    expect(store.messages[1]!.clarification).toMatchObject({
      question: "Which do you mean?",
      options: ["company", "person"],
    });
    wrapper.unmount();
  });

  it("clicking an option feeds the answer back to re-run the query with the chosen context", async () => {
    streamChatMock.mockResolvedValue(undefined);
    const wrapper = mountChat();
    const store = useChatStore();
    store.messages = [
      { role: "user", content: "what is caleo", speaker: { id: "hermes", kind: "employee", name: "Hermes", logoUrl: "" } },
      {
        role: "assistant",
        content: "Which do you mean?",
        speaker: { id: "athena", kind: "agent", name: "Athena", logoUrl: "" },
        clarification: { question: "Which do you mean?", options: ["company", "person"], query: "what is caleo" },
      },
    ];
    await wrapper.vm.$nextTick();

    const firstOption = wrapper.find(".clarification-option");
    await firstOption.trigger("click");
    await flushPromises();

    expect(store.messages[1]!.clarificationAnswered).toBe(true);
    const lastCall = streamChatMock.mock.calls.at(-1)! as [string, string, StreamArgs, string, { query: string; answer: string }];
    expect(lastCall[0]).toBe("hermes");
    expect(lastCall[1]).toBe("company");
    expect(lastCall[4]).toEqual({ query: "what is caleo", answer: "company" });
    wrapper.unmount();
  });
});

describe("GlobalChatPanel session switcher (G4.S7.T12)", () => {
  const sessions = [
    { session_id: "s1", title: "First chat", created_at: "2026-08-20T00:00:00.000Z", updated_at: "2026-08-20T01:00:00.000Z", message_count: 2 },
    { session_id: "", title: "Previous chat", created_at: "2026-08-19T00:00:00.000Z", updated_at: "2026-08-19T05:00:00.000Z", message_count: 5 },
  ];

  it("renders the session switcher trigger in the agent-card area", () => {
    const wrapper = mountChat();
    expect(wrapper.find(".session-trigger").exists()).toBe(true);
    expect(wrapper.find(".session-trigger").text()).toContain("New chat");
    wrapper.unmount();
  });

  it("opens the picker with recent sessions (title + count + time) and a New chat item", async () => {
    fetchChatSessionsMock.mockResolvedValue(sessions);
    const wrapper = mountChat();
    const store = useChatStore();
    store.sessions = sessions;

    await wrapper.find(".session-trigger").trigger("click");
    await flushPromises();

    const menu = wrapper.find(".session-menu");
    expect(menu.exists()).toBe(true);
    expect(menu.find(".session-new").text()).toContain("New chat");
    const options = wrapper.findAll(".session-option");
    expect(options.length).toBe(3); // New chat + 2 sessions
    expect(menu.text()).toContain("First chat");
    expect(menu.text()).toContain("2 msg");
    expect(menu.text()).toContain("Previous chat");
    wrapper.unmount();
  });

  it("picking a session restores ONLY that session's messages through the store", async () => {
    fetchChatHistoryMock.mockResolvedValue([
      { message_id: "m1", employee_id: "u1", role: "user", content: "resumed q", speaker_id: "u1", speaker_name: "", page: "", thinking: "", progress: [], created_at: "" },
    ]);
    const wrapper = mountChat();
    const store = useChatStore();
    store.sessions = sessions;

    await wrapper.find(".session-trigger").trigger("click");
    await flushPromises();
    await wrapper.findAll(".session-option").find((o) => o.text().includes("First chat"))!.trigger("click");
    await flushPromises();

    expect(fetchChatHistoryMock).toHaveBeenCalledWith("hermes", 200, "s1");
    expect(store.activeSessionId).toBe("s1");
    expect(store.messages.map((m) => m.content)).toEqual(["resumed q"]);
    wrapper.unmount();
  });

  it("New chat clears the current view and starts fresh", async () => {
    fetchChatSessionsMock.mockResolvedValue(sessions);
    const wrapper = mountChat();
    const store = useChatStore();
    store.messages = [{ role: "user", content: "old view" }];
    store.activeSessionId = "s1";

    await wrapper.find(".session-trigger").trigger("click");
    await flushPromises();
    await wrapper.find(".session-new").trigger("click");
    await flushPromises();

    expect(store.messages).toEqual([]);
    expect(store.activeSessionId).toBeNull();
    wrapper.unmount();
  });
});
