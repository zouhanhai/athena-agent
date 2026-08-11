import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.js";
import type { FastifyInstance } from "fastify";
import type { KbReviewService } from "../../src/kb/review.js";

function stubReview(
  report: Parameters<KbReviewService["reviewAll"]>[0] extends never
    ? never
    : Awaited<ReturnType<KbReviewService["reviewAll"]>>,
): KbReviewService {
  return {
    reviewAll: async (options) => {
      calls.push(options ?? {});
      return report;
    },
  } as unknown as KbReviewService;
}

const calls: Array<Record<string, unknown> | undefined> = [];

function makeReport() {
  return {
    runAt: "2026-08-11",
    scanned: 2,
    changed: 1,
    archive: ["wiki/old.md"],
    results: [
      {
        path: "wiki/old.md",
        action: "deprecate" as const,
        confidence: 0.1,
        confidenceDelta: -0.1,
        lastReviewed: "2026-08-11",
        archive: true,
        reason: "stale, flagged for archive",
      },
    ],
  };
}

async function appWith(review: KbReviewService): Promise<FastifyInstance> {
  return buildApp({ review });
}

test("POST /api/kb/review runs the review pass and returns the report", async () => {
  calls.length = 0;
  const app = await appWith(stubReview(makeReport()));
  try {
    const res = await app.inject({ method: "POST", url: "/api/kb/review", payload: {} });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.scanned, 2);
    assert.equal(body.changed, 1);
    assert.deepEqual(body.archive, ["wiki/old.md"]);
    assert.equal(body.results[0].action, "deprecate");
  } finally {
    await app.close();
  }
});

test("POST /api/kb/review passes dryRun / retopics / reclassify / reinforce to the service", async () => {
  calls.length = 0;
  const app = await appWith(stubReview(makeReport()));
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/kb/review",
      payload: {
        dryRun: true,
        retopics: { "wiki/a.md": "sap/ai" },
        reclassify: { "wiki/b.md": "event" },
        reinforce: ["wiki/c.md"],
      },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0], {
      dryRun: true,
      retopics: { "wiki/a.md": "sap/ai" },
      reclassify: { "wiki/b.md": "event" },
      reinforce: ["wiki/c.md"],
    });
  } finally {
    await app.close();
  }
});

test("POST /api/kb/review tolerates an empty/absent body", async () => {
  calls.length = 0;
  const app = await appWith(stubReview(makeReport()));
  try {
    const res = await app.inject({ method: "POST", url: "/api/kb/review" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0], {});
  } finally {
    await app.close();
  }
});
