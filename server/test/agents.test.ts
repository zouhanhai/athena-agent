import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/agents/agent.js";
import { AgenticRetrievalService } from "../src/kb/agentic-rag.js";

test("createAgent creates OpenRouter AgentSession", async () => {
  const agent = await createAgent();
  try {
    assert.ok(agent.session, "should return AgentSession");
    assert.equal(agent.model, "openrouter/~deepseek/deepseek-v4-flash-latest");
  } finally {
    agent.dispose();
  }
});

test("agent.prompt() sends message and receives non-empty reply", async () => {
  const agent = await createAgent();
  try {
    const reply = await agent.prompt("hi");
    assert.equal(typeof reply, "string");
    assert.ok(reply.trim().length > 0, "reply should not be empty");
  } finally {
    agent.dispose();
  }
});

test("createAgent loads installed Pi packages without errors", async () => {
  const agent = await createAgent();
  try {
    assert.deepEqual(agent.extensionErrors, []);
    assert.equal(agent.packages.length, 10);
  } finally {
    agent.dispose();
  }
});

test("createAgent registers search_knowledge (agentic RAG) and the SDK's web_search (G4.S3.T7)", async () => {
  const service = new AgenticRetrievalService({
    search: async (query: string) => ({ query, results: [] }),
    judge: {
      transformQuery: async () => ({ action: "direct" }),
      judgeRelevance: async () => ({ relevant: false }),
      compress: async () => "",
      multiHop: async () => ({ followUps: [], trace: "" }),
      suggestKbUpdate: async () => "",
    },
  });
  const agent = await createAgent({ agenticRetrieval: service });
  try {
    const names = agent.session.getAllTools().map((t) => t.name);
    assert.ok(names.includes("web_search"), "Pi SDK exposes a web_search tool (verified)");
    assert.ok(names.includes("search_knowledge"), "search_knowledge tool should be registered");
  } finally {
    agent.dispose();
  }
});

test("createAgent omits search_knowledge when no agentic service is wired", async () => {
  const agent = await createAgent({ agenticRetrieval: undefined });
  try {
    const names = agent.session.getAllTools().map((t) => t.name);
    assert.ok(!names.includes("search_knowledge"), "search_knowledge tool should be omitted by default");
  } finally {
    agent.dispose();
  }
});
