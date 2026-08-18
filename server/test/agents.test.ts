import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/agents/agent.js";
import { AgenticRetrievalService } from "../src/kb/agentic-rag.js";

test("createAgent creates athena-provider AgentSession (DEFAULT_PROVIDER)", async () => {
  const agent = await createAgent();
  try {
    assert.ok(agent.session, "should return AgentSession");
    assert.equal(agent.model, "athena/~deepseek/deepseek-v4-flash-latest");
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

test("createAgent wires a DEFAULT search_knowledge (agentic RAG) when no agentic service is supplied (G4.S3.T12)", async () => {
  const agent = await createAgent();
  try {
    const names = agent.session.getAllTools().map((t) => t.name);
    assert.ok(names.includes("search_knowledge"), "default wiring registers search_knowledge");
    assert.ok(names.includes("wiki_search"), "llm_wiki tools stay registered (additive)");
    assert.ok(names.includes("wiki_read_page"), "wiki_read_page stays registered (additive)");
    assert.ok(names.includes("wiki_graph"), "wiki_graph stays registered (additive)");
  } finally {
    agent.dispose();
  }
});
