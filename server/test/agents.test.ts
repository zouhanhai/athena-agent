import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../src/agents/agent.js";

test("createAgent 创建 DeepSeek AgentSession", async () => {
  const agent = await createAgent();
  try {
    assert.ok(agent.session, "应返回 AgentSession");
    assert.equal(agent.model, "deepseek/deepseek-v4-flash");
  } finally {
    agent.dispose();
  }
});

test("agent.prompt() 发送消息并收到非空回答", async () => {
  const agent = await createAgent();
  try {
    const reply = await agent.prompt("hi");
    assert.equal(typeof reply, "string");
    assert.ok(reply.trim().length > 0, "回答不应为空");
  } finally {
    agent.dispose();
  }
});

test("createAgent 加载已安装 Pi packages 无报错", async () => {
  const agent = await createAgent();
  try {
    assert.deepEqual(agent.extensionErrors, []);
    assert.equal(agent.packages.length, 10);
  } finally {
    agent.dispose();
  }
});
