import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import type { WikiReCurator } from "../../src/kb/recurate.js";

const calls: Array<{ path: string; topic: string }> = [];

function stubReCurator(): WikiReCurator {
  return {
    reTopic: async (input) => {
      calls.push(input);
      return {
        oldPath: input.path,
        newPath: `wiki/${input.topic}/sommerseminar.md`,
        topic: input.topic,
        topicHistory: ["internal/events"],
        lastReviewed: "2026-08-11",
      };
    },
  } as unknown as WikiReCurator;
}

async function appWith(): Promise<FastifyInstance> {
  return buildApp({ recurator: stubReCurator() });
}

test("POST /api/kb/wiki/retopic re-curates a page into a deeper topic dir", async () => {
  calls.length = 0;
  const app = await appWith();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/wiki/retopic",
      payload: { path: "wiki/internal/events/sommerseminar.md", topic: "internal/events/sommerseminar" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.oldPath, "wiki/internal/events/sommerseminar.md");
    assert.equal(body.newPath, "wiki/internal/events/sommerseminar/sommerseminar.md");
    assert.equal(body.topic, "internal/events/sommerseminar");
    assert.deepEqual(body.topicHistory, ["internal/events"]);
    assert.deepEqual(calls[0], {
      path: "wiki/internal/events/sommerseminar.md",
      topic: "internal/events/sommerseminar",
    });
  } finally {
    await app.close();
  }
});

test("POST /api/kb/wiki/retopic rejects a missing path or topic", async () => {
  calls.length = 0;
  const app = await appWith();
  try {
    const noPath = await app.inject({
      method: "POST",
      url: "/api/kb/wiki/retopic",
      payload: { topic: "sap/ai" },
    });
    assert.equal(noPath.statusCode, 400);

    const noTopic = await app.inject({
      method: "POST",
      url: "/api/kb/wiki/retopic",
      payload: { path: "wiki/events/foo.md" },
    });
    assert.equal(noTopic.statusCode, 400);
  } finally {
    await app.close();
  }
});
