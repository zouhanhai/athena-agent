import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

test("live default store serves committed animal logos via GET /api/logos", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/api/logos" });
  assert.equal(res.statusCode, 200);
  const { logos } = res.json();
  assert.ok(logos.length >= 6, `expected >=6 committed logos, got ${logos.length}`);
  const fox = logos.find((l: { animal: string }) => l.animal === "fox");
  assert.equal(fox?.url, "/logos/fox.jpg");
  const stat = await import("node:fs/promises").then((m) => m.stat("../web/public/logos/fox.jpg"));
  assert.ok(stat.size > 0);
  await app.close();
});
