import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANIMAL_LOGO_SET,
  FileLogoStore,
  LogoGenerationError,
  OpenRouterLogoClient,
  type LogoGenerationRequest,
  type LogoImageClient,
} from "../src/agents/logos.js";

class FakeLogoClient implements LogoImageClient {
  calls: string[] = [];
  async generate(request: LogoGenerationRequest): Promise<Buffer> {
    this.calls.push(request.prompt);
    return Buffer.from(`fake-png-${this.calls.length}`);
  }
}

test("ANIMAL_LOGO_SET contains a consistent-style set with unique animals and distinct colors", () => {
  assert.ok(ANIMAL_LOGO_SET.length >= 6, "at least 6 animals");
  const animals = new Set(ANIMAL_LOGO_SET.map((spec) => spec.animal));
  const colors = new Set(ANIMAL_LOGO_SET.map((spec) => spec.color));
  assert.equal(animals.size, ANIMAL_LOGO_SET.length, "animal names must be unique");
  assert.equal(colors.size, ANIMAL_LOGO_SET.length, "colors must be distinct per animal");
});

test("FileLogoStore.list() returns [] for a fresh store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-"));
  const store = new FileLogoStore({ dir, client: new FakeLogoClient() });
  try {
    assert.deepEqual(await store.list(), []);
  } finally {
    await store.close();
  }
});

test("ensureGeneratedSet() generates one logo per animal, writes assets, and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-"));
  const client = new FakeLogoClient();
  const store = new FileLogoStore({ dir, client });

  const generated = await store.ensureGeneratedSet();
  assert.equal(generated.length, ANIMAL_LOGO_SET.length);
  for (const record of generated) {
    assert.equal(record.source, "generated");
    assert.equal(record.animal, record.name);
    assert.ok(record.url.startsWith("/logos/"), `url should be web-servable: ${record.url}`);
    const bytes = await readFile(join(dir, record.filename));
    assert.ok(bytes.length > 0, `asset should exist on disk: ${record.filename}`);
  }

  const again = await store.ensureGeneratedSet();
  assert.equal(again.length, ANIMAL_LOGO_SET.length);
  assert.equal(
    client.calls.length,
    ANIMAL_LOGO_SET.length,
    "client should only be called for missing logos (idempotent)",
  );
  await store.close();
});

test("upload() stores a file under the uploads subdir and returns its record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-"));
  const store = new FileLogoStore({ dir, client: new FakeLogoClient() });
  try {
    const record = await store.upload({
      filename: "hermes.png",
      data: Buffer.from("png-bytes"),
      mimetype: "image/png",
    });
    assert.equal(record.source, "upload");
    assert.equal(record.name, "hermes");
    assert.ok(record.url.startsWith("/logos/uploads/"), `upload url: ${record.url}`);
    const bytes = await readFile(join(dir, "uploads", record.filename));
    assert.equal(bytes.toString(), "png-bytes");
  } finally {
    await store.close();
  }
});

test("upload() sanitizes unsafe filenames and records it in the index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-"));
  const store = new FileLogoStore({ dir, client: new FakeLogoClient() });
  try {
    const record = await store.upload({
      filename: "../../../etc/passwd.png",
      data: Buffer.from("x"),
    });
    assert.ok(!record.filename.includes(".."), "no path traversal in stored filename");
    assert.equal((await store.list()).length, 1, "uploaded logo should be listed");
  } finally {
    await store.close();
  }
});

test("OpenRouterLogoClient throws LogoGenerationError when auth is unavailable", async () => {
  const client = new OpenRouterLogoClient({
    authPath: join(tmpdir(), "missing-auth.json"),
  });
  await assert.rejects(
    () => client.generate({ prompt: "test", referenceImage: Buffer.from("x") }),
    (err: unknown) => err instanceof LogoGenerationError,
  );
});

test("FileLogoStore persists generated + uploaded logos across instances via index.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-"));
  const first = new FileLogoStore({ dir, client: new FakeLogoClient() });
  await first.ensureGeneratedSet();
  await first.upload({ filename: "custom.png", data: Buffer.from("c"), mimetype: "image/png" });
  await first.close();

  const second = new FileLogoStore({ dir, client: new FakeLogoClient() });
  try {
    const logos = await second.list();
    assert.equal(logos.length, ANIMAL_LOGO_SET.length + 1);
    const custom = logos.find((l) => l.source === "upload");
    assert.ok(custom, "uploaded logo should survive a restart via index.json");
    assert.ok((await readdir(join(dir, "uploads"))).length >= 1);
  } finally {
    await second.close();
  }
});
