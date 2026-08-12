import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useChatStore } from "@/stores/chat";
import { streamChat } from "@/api/chat";
import { sendFeedback } from "@/api/feedback";

vi.mock("@/api/chat", () => ({
  streamChat: vi.fn(),
  sendChat: vi.fn(),
}));

vi.mock("@/api/feedback", () => ({
  sendFeedback: vi.fn(),
  listQaPairs: vi.fn(),
}));

const streamChatMock = streamChat as unknown as ReturnType<typeof vi.fn>;
const sendFeedbackMock = sendFeedback as unknown as ReturnType<typeof vi.fn>;

interface StreamArgs {
  onDelta: (delta: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
  onClarify?: (clarify: { question: string; options: string[]; query?: string }) => void;
}

function resolveStream() {
  streamChatMock.mockResolvedValue(undefined);
}

function controllableStream(): {
  push: (d: string) => void;
  fail: (msg: string) => void;
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

beforeEach(() => {
  setActivePinia(createPinia());
  streamChatMock.mockReset();
  sendFeedbackMock.mockReset();
});

describe("chat store", () => {
  it("starts with empty messages, no loading/error, default userId and no page", () => {
    const store = useChatStore();
    expect(store.messages).toEqual([]);
    expect(store.loading).toBe(false);
    expect(store.error).toBe("");
    expect(store.userId).toBe("hermes");
    expect(store.page).toBe("");
    expect(store.participants).toHaveLength(1);
    expect(store.participants[0]).toMatchObject({ id: "athena", kind: "agent", name: "Athena", speak: true });
  });

  it("send pushes a user message and streams deltas into an assistant bubble", async () => {
    const stream = controllableStream();
    resolveStream();
    const store = useChatStore();

    const promise = store.send("hello there");
    expect(store.messages[0]).toMatchObject({
      role: "user",
      content: "hello there",
      speaker: { id: "hermes", kind: "employee", name: "Hermes" },
    });
    expect(store.messages[1]).toMatchObject({
      role: "assistant",
      content: "",
      speaker: { id: "athena", kind: "agent", name: "Athena", logoUrl: "/athena-logo-ai.png" },
    });
    expect(store.loading).toBe(true);
    expect(streamChatMock).toHaveBeenCalledWith(
      "hermes",
      "hello there",
      expect.objectContaining({ onDelta: expect.any(Function) }),
      "",
    );

    stream.push("Hel");
    stream.push("lo");
    stream.end();
    await promise;

    expect(store.messages[1]!.content).toBe("Hello");
    expect(store.loading).toBe(false);
  });

  it("sends the current page so the server can inject page-aware capabilities", async () => {
    resolveStream();
    const store = useChatStore();
    store.setPage("/workbench");

    await store.send("list my repos");

    expect(streamChatMock).toHaveBeenCalledWith(
      "hermes",
      "list my repos",
      expect.objectContaining({ onDelta: expect.any(Function) }),
      "/workbench",
    );
  });

  it("setPage updates the tracked page", () => {
    const store = useChatStore();
    store.setPage("/wiki");
    expect(store.page).toBe("/wiki");
    store.setPage("/knowledge");
    expect(store.page).toBe("/knowledge");
  });

  it("keeps the conversation context when switching pages (tab switch does not reset)", async () => {
    resolveStream();
    const store = useChatStore();
    store.setPage("/knowledge");

    await store.send("first on knowledge");
    expect(store.messages).toHaveLength(2);

    store.setPage("/workbench");
    expect(store.page).toBe("/workbench");
    expect(store.messages).toHaveLength(2);

    await store.send("second on workbench");
    expect(store.messages).toHaveLength(4);
    expect(store.messages[0]).toMatchObject({ role: "user", content: "first on knowledge" });
    expect(store.messages[2]).toMatchObject({ role: "user", content: "second on workbench" });

    const pages = streamChatMock.mock.calls.map((call) => call[3]);
    expect(pages).toEqual(["/knowledge", "/workbench"]);
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
    expect(store.messages).toEqual([
      { role: "user", content: "ping", speaker: { id: "hermes", kind: "employee", name: "Hermes", logoUrl: "" } },
    ]);
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

describe("chat store clarification follow-up (G4.S3.T13)", () => {
  it("send surfaces a clarification (question + options) on the assistant bubble instead of a dead-end answer", async () => {
    const stream = controllableStream();
    resolveStream();
    const store = useChatStore();

    const promise = store.send("help me with something");
    stream.clarify({ question: "Which do you mean?", options: ["company", "person"], query: "what is caleo" });
    stream.end();
    await promise;

    const assistant = store.messages[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("Which do you mean?");
    expect(assistant.clarification).toEqual({
      question: "Which do you mean?",
      options: ["company", "person"],
      query: "what is caleo",
    });
    expect(store.loading).toBe(false);
  });

  it("answerClarification feeds the user's choice back and re-runs the query with the chosen context", async () => {
    const stream = controllableStream();
    resolveStream();
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

    const promise = store.answerClarification(1, "company");
    stream.push("CALEO is the SAP & finance consultancy.");
    stream.end();
    await promise;

    expect(store.messages).toHaveLength(4);
    expect(store.messages[2]).toMatchObject({ role: "user", content: "company" });
    expect(store.messages[3]).toMatchObject({ role: "assistant", content: "CALEO is the SAP & finance consultancy." });

    const lastCall = streamChatMock.mock.calls.at(-1)! as [string, string, StreamArgs, string, { query: string; answer: string }];
    expect(lastCall[0]).toBe("hermes");
    expect(lastCall[4]).toEqual({ query: "what is caleo", answer: "company" });
    expect(store.loading).toBe(false);
  });

  it("answerClarification is a no-op when the message has no clarification", async () => {
    resolveStream();
    const store = useChatStore();
    store.messages = [
      { role: "user", content: "hi", speaker: { id: "hermes", kind: "employee", name: "Hermes", logoUrl: "" } },
      { role: "assistant", content: "plain answer", speaker: { id: "athena", kind: "agent", name: "Athena", logoUrl: "" } },
    ];

    await store.answerClarification(1, "x");

    expect(streamChatMock).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(2);
  });
});

describe("chat store feedback loop (G4.S3.T5)", () => {
  function qaPair(overrides: Record<string, unknown> = {}) {
    return {
      id: "pair-1",
      question: "what is C-Day?",
      answer: "the CALEO Day",
      sources: [],
      feedback: "up",
      created_at: "2026-08-12T00:00:00.000Z",
      updated_at: "2026-08-12T00:00:00.000Z",
      ...overrides,
    };
  }

  it("rateMessage posts the Q&A pair + feedback and stores the direction on the message", async () => {
    sendFeedbackMock.mockResolvedValue({ pair: qaPair(), deduped: false, confidenceUpdates: [] });
    const store = useChatStore();
    store.messages = [
      { role: "user", content: "What is C-Day?", speaker: { id: "hermes", kind: "employee", name: "Hermes", logoUrl: "" } },
      { role: "assistant", content: "C-Day is the CALEO Day.", speaker: { id: "athena", kind: "agent", name: "Athena", logoUrl: "" } },
    ];

    await store.rateMessage(1, "up");

    expect(sendFeedbackMock).toHaveBeenCalledWith({
      question: "What is C-Day?",
      answer: "C-Day is the CALEO Day.",
      sources: [],
      feedback: "up",
    });
    expect(store.messages[1]!.feedback).toBe("up");
    expect(store.error).toBe("");
  });

  it("rateMessage ignores non-assistant messages and repeated same-direction clicks", async () => {
    sendFeedbackMock.mockResolvedValue({ pair: qaPair(), deduped: false, confidenceUpdates: [] });
    const store = useChatStore();
    store.messages = [
      { role: "user", content: "What is C-Day?" },
      { role: "assistant", content: "C-Day is the CALEO Day.", feedback: "up" },
    ];

    await store.rateMessage(0, "up"); // user row → no-op
    await store.rateMessage(1, "up"); // already rated up → no-op
    await store.rateMessage(99, "down"); // out of range → no-op

    expect(sendFeedbackMock).not.toHaveBeenCalled();
    expect(store.messages[1]!.feedback).toBe("up");
  });

  it("rateMessage records an error when the feedback API fails", async () => {
    sendFeedbackMock.mockRejectedValue(new Error("network down"));
    const store = useChatStore();
    store.messages = [
      { role: "user", content: "What is C-Day?" },
      { role: "assistant", content: "C-Day is the CALEO Day." },
    ];

    await store.rateMessage(1, "down");

    expect(store.error).toBe("network down");
    expect(store.messages[1]!.feedback).toBeUndefined();
  });
});

describe("chat store participant hooks", () => {
  it("onAgentJoined adds a participant card with speak on", () => {
    const store = useChatStore();
    const participant = store.onAgentJoined({
      id: "hermes::Hermes",
      kind: "agent",
      name: "Hermes",
      logoUrl: "/logos/fox-clean.png",
      capabilities: ["github"],
    });

    expect(store.participants).toHaveLength(2);
    expect(store.participants[1]).toMatchObject({
      id: "hermes::Hermes",
      name: "Hermes",
      speak: true,
    });
    expect(participant.speak).toBe(true);
  });

  it("onAgentJoined injects the current page context into the joined agent and notifies", () => {
    const store = useChatStore();
    store.setPage("/workbench");

    store.onAgentJoined({
      id: "hermes::Hermes",
      kind: "agent",
      name: "Hermes",
      logoUrl: "/logos/fox-clean.png",
      capabilities: ["github"],
    });

    expect(store.participants[1]!.joinedPage).toBe("Workbench");
    const notice = store.messages[store.messages.length - 1]!;
    expect(notice.role).toBe("system");
    expect(notice.content).toContain("Hermes");
    expect(notice.content).toContain("joined");
  });

  it("onAgentJoined does not add the same participant twice", () => {
    const store = useChatStore();
    const input = {
      id: "hermes::Hermes",
      kind: "agent" as const,
      name: "Hermes",
      logoUrl: "/logos/fox-clean.png",
      capabilities: ["github"],
    };
    store.onAgentJoined(input);
    store.onAgentJoined(input);

    expect(store.participants).toHaveLength(2);
  });

  it("onSpeakToggleChanged updates the participant's speak permission", () => {
    const store = useChatStore();
    store.onAgentJoined({
      id: "hermes::Hermes",
      kind: "agent",
      name: "Hermes",
      logoUrl: "/logos/fox-clean.png",
      capabilities: [],
    });

    store.onSpeakToggleChanged("hermes::Hermes", false);
    expect(store.participants[1]!.speak).toBe(false);

    store.onSpeakToggleChanged("hermes::Hermes", true);
    expect(store.participants[1]!.speak).toBe(true);
  });

  it("onAgentLeft removes the agent card, cleans up its context and notifies", () => {
    const store = useChatStore();
    store.onAgentJoined({
      id: "hermes::Hermes",
      kind: "agent",
      name: "Hermes",
      logoUrl: "/logos/fox-clean.png",
      capabilities: [],
    });

    store.onAgentLeft("hermes::Hermes");

    expect(store.participants).toHaveLength(1);
    expect(store.participants[0]!.id).toBe("athena");
    const notice = store.messages[store.messages.length - 1]!;
    expect(notice.role).toBe("system");
    expect(notice.content).toContain("Hermes");
    expect(notice.content).toContain("left");
  });

  it("onAgentLeft is a no-op for an unknown id", () => {
    const store = useChatStore();
    store.onAgentLeft("missing");
    expect(store.participants).toHaveLength(1);
    expect(store.messages).toEqual([]);
  });
});

describe("chat store message speakers", () => {
  it("attributes the assistant bubble to the default Athena agent", async () => {
    resolveStream();
    const store = useChatStore();

    await store.send("hi");

    expect(store.messages[1]!.speaker).toMatchObject({
      id: "athena",
      kind: "agent",
      name: "Athena",
      logoUrl: "/athena-logo-ai.png",
    });
  });

  it("attributes the assistant bubble to a joined agent whose speak is on", async () => {
    resolveStream();
    const store = useChatStore();
    store.onAgentJoined({
      id: "hermes::Hermes",
      kind: "agent",
      name: "Hermes",
      logoUrl: "/logos/fox-clean.png",
      capabilities: [],
    });

    await store.send("hi");

    expect(store.messages[1]!.speaker).toMatchObject({ name: "Hermes" });
  });

  it("keeps the user bubble attributed to the default user speaker", async () => {
    resolveStream();
    const store = useChatStore();

    await store.send("hi");

    expect(store.messages[0]!.speaker).toMatchObject({
      id: "hermes",
      kind: "employee",
      name: "Hermes",
    });
  });

  it("setUserSpeaker attributes user bubbles to the signed-in employee", async () => {
    resolveStream();
    const store = useChatStore();
    store.setUserSpeaker({ id: "e1", kind: "employee", name: "Carol", logoUrl: "/logos/raven-clean.png" });

    await store.send("hi");

    expect(store.messages[0]!.speaker).toMatchObject({
      id: "e1",
      name: "Carol",
      logoUrl: "/logos/raven-clean.png",
    });
  });
});
