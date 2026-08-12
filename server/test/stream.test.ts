import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "../src/agents/agent.js";
import { streamAgentChat, streamAgentText, extractClarification } from "../src/agents/stream.js";

type EventListener = (event: unknown) => void;

function makeFakeAgent(deltas: string[]): {
  agent: Agent;
  prompts: string[];
  unsubscribed: () => boolean;
} {
  const listeners = new Set<EventListener>();
  const prompts: string[] = [];
  let subscribed = false;

  const session = {
    prompts,
    async prompt(text: string): Promise<void> {
      prompts.push(text);
      for (const delta of deltas) {
        for (const l of listeners) {
          l({
            type: "message_update",
            message: {},
            assistantMessageEvent: { type: "text_delta", delta },
          });
        }
      }
      for (const l of listeners) {
        l({ type: "agent_end", messages: [], willRetry: false });
      }
    },
    subscribe(listener: EventListener): () => void {
      listeners.add(listener);
      subscribed = true;
      return () => {
        listeners.delete(listener);
        subscribed = false;
      };
    },
  };

  const agent = {
    session,
    model: "openrouter/~deepseek/deepseek-v4-flash-latest",
    packages: [],
    extensionErrors: [],
    prompt: async () => "",
    dispose: () => {},
  } as unknown as Agent;

  return {
    agent,
    prompts,
    unsubscribed: () => !subscribed,
  };
}

test("streamAgentText yields all text_delta chunks in order", async () => {
  const { agent } = makeFakeAgent(["He", "llo", ",", " World"]);
  const chunks: string[] = [];
  for await (const chunk of streamAgentText(agent, "hi")) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, ["He", "llo", ",", " World"]);
});

test("streamAgentText passes user message to session.prompt", async () => {
  const { agent, prompts } = makeFakeAgent(["ok"]);
  for await (const _ of streamAgentText(agent, "hello")) {
    // consume entire stream
  }
  assert.deepEqual(prompts, ["hello"]);
});

test("streamAgentText stream is empty when no text_delta", async () => {
  const { agent } = makeFakeAgent([]);
  const chunks: string[] = [];
  for await (const chunk of streamAgentText(agent, "hi")) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks, []);
});

test("streamAgentText unsubscribes after completion", async () => {
  const { agent, unsubscribed } = makeFakeAgent(["x"]);
  for await (const _ of streamAgentText(agent, "hi")) {
    // consume entire stream
  }
  assert.equal(unsubscribed(), true, "should unsubscribe event listener after stream ends");
});

test("streamAgentChat yields text deltas as delta events", async () => {
  const { agent } = makeFakeAgent(["Hel", "lo"]);
  const events = [];
  for await (const event of streamAgentChat(agent, "hi")) {
    events.push(event);
  }
  assert.deepEqual(events, [
    { type: "delta", text: "Hel" },
    { type: "delta", text: "lo" },
  ]);
});

test("streamAgentChat emits a clarify event from a search_knowledge tool result and stops", async () => {
  const listeners = new Set<EventListener>();
  const session = {
    prompts: [] as string[],
    aborted: false,
    async prompt(text: string): Promise<void> {
      session.prompts.push(text);
      for (const l of listeners) {
        l({
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "search_knowledge",
          result: {
            content: [{ type: "text", text: "CLARIFICATION_REQUESTED\nquestion: Which do you mean?" }],
            details: {
              clarification: { question: "Which do you mean?", options: ["company", "person"], query: "what is caleo" },
            },
          },
          isError: false,
        });
      }
      // Dead-end text the agent would produce AFTER the clarify result — must be dropped.
      for (const l of listeners) {
        l({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "Are you referring to a company?" } });
      }
      for (const l of listeners) {
        l({ type: "agent_end", messages: [], willRetry: false });
      }
    },
    subscribe(listener: EventListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    abort: () => {
      session.aborted = true;
      return Promise.resolve();
    },
  };
  const agent = {
    session,
    model: "openrouter/~deepseek/deepseek-v4-flash-latest",
    packages: [],
    extensionErrors: [],
    prompt: async () => "",
    dispose: () => {},
  } as unknown as Agent;

  const events = [];
  for await (const event of streamAgentChat(agent, "what is caleo")) {
    events.push(event);
  }
  assert.deepEqual(events, [
    {
      type: "clarify",
      clarification: { question: "Which do you mean?", options: ["company", "person"], query: "what is caleo" },
    },
  ]);
  assert.equal(session.aborted, true, "agent run should be aborted after a clarify so no dead-end text is produced");
  assert.equal(session.prompts[0], "what is caleo");
});

test("extractClarification reads the details block of a search_knowledge result", () => {
  assert.deepEqual(
    extractClarification({
      details: { clarification: { question: "Which?", options: ["a", "b"], query: "q" } },
    }),
    { question: "Which?", options: ["a", "b"], query: "q" },
  );
  assert.equal(
    extractClarification({ details: {} }),
    undefined,
  );
  assert.equal(
    extractClarification({ details: { clarification: { question: "x" } } }),
    undefined,
    "missing options is not a clarification",
  );
});
