import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/agents/agent.js";

test("createAgent creates DeepSeek AgentSession", async () => {
  const agent = await createAgent();
  try {
    assert.ok(agent.session, "should return AgentSession");
    assert.equal(agent.model, "deepseek/deepseek-v4-flash");
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
