import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { MemoryAgentRegistry } from "../src/agents/registry.js";
import { MemoryEmployeeRegistry } from "../src/employees/employees.js";
import {
  FileLogoStore,
  ANIMAL_LOGO_SET,
  type LogoGenerationRequest,
  type LogoImageClient,
} from "../src/agents/logos.js";
import type { FastifyInstance } from "fastify";

class FakeLogoClient implements LogoImageClient {
  async generate(_request: LogoGenerationRequest): Promise<Buffer> {
    return Buffer.from("fake-png");
  }
}

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

interface MultipartField {
  value: string;
  type?: string;
  filename?: string;
}

function multipartBody(
  fields: Record<string, MultipartField>,
  boundary = "----t3boundary",
): Buffer {
  const parts: string[] = [];
  for (const [key, field] of Object.entries(fields)) {
    if (field.type) {
      const disposition = field.filename
        ? `name="${key}"; filename="${field.filename}"`
        : `name="${key}"`;
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; ${disposition}\r\nContent-Type: ${field.type}\r\n\r\n${field.value}\r\n`,
      );
    } else {
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${field.value}\r\n`);
    }
  }
  parts.push(`--${boundary}--\r\n`);
  return Buffer.from(parts.join(""), "latin1");
}

let app: FastifyInstance;
let store: FileLogoStore;
let registry: MemoryAgentRegistry;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "logos-routes-"));
  store = new FileLogoStore({ dir, client: new FakeLogoClient() });
  await store.ensureGeneratedSet();
  registry = new MemoryAgentRegistry();
  app = buildApp({ registry, logos: store });
});

after(async () => {
  if (app) {
    await app.close();
  }
});

test("GET /api/logos lists the generated animal logo set", async () => {
  const res = await app.inject({ method: "GET", url: "/api/logos" });
  assert.equal(res.statusCode, 200);
  const { logos } = res.json();
  assert.ok(Array.isArray(logos));
  assert.equal(logos.length, ANIMAL_LOGO_SET.length);
  assert.ok(logos.every((logo: { source: string }) => logo.source === "generated"));
  const animals = new Set(logos.map((logo: { animal?: string }) => logo.animal));
  assert.equal(animals.size, ANIMAL_LOGO_SET.length, "every animal logo present");
});

test("GET /api/logos?exclude-in-use=1 hides logos already used by an agent or employee", async () => {
  const boundary = "----t3boundary2";
  const upload = async (filename: string): Promise<string> => {
    const payload = multipartBody(
      { file: { value: PNG_BYTES.toString("latin1"), type: "image/png", filename } },
      boundary,
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/logos",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 201);
    return res.json().logo.url as string;
  };
  const agentLogoUrl = await upload("agent-logo.png");
  const employeeLogoUrl = await upload("employee-logo.png");

  const agentRegistry = new MemoryAgentRegistry([
    {
      alias: "Hermes",
      owner_employee_id: "zhang.wei",
      logo_url: agentLogoUrl,
      capabilities: { system: "hermes", mcp: [], tools: [], skills: [], specialty: "integration" },
    },
  ]);
  const employees = new MemoryEmployeeRegistry([
    { email: "carol@caleo.com", display_name: "Carol", logo_url: employeeLogoUrl },
  ]);
  const filteredApp = buildApp({ registry: agentRegistry, logos: store, employees });
  const res = await filteredApp.inject({ method: "GET", url: "/api/logos?exclude-in-use=1" });
  assert.equal(res.statusCode, 200);
  const { logos } = res.json();
  assert.ok(
    !logos.some((logo: { url: string }) => logo.url === agentLogoUrl),
    "agent-used logo should be excluded",
  );
  assert.ok(
    !logos.some((logo: { url: string }) => logo.url === employeeLogoUrl),
    "employee-used logo should be excluded",
  );
  assert.equal(logos.length, ANIMAL_LOGO_SET.length + 0, "only the uploads were filtered out");
  await filteredApp.close();
});

test("GET /api/logos without exclude-in-use still lists every logo", async () => {
  const res = await app.inject({ method: "GET", url: "/api/logos?exclude-in-use=0" });
  assert.equal(res.statusCode, 200);
  const { logos } = res.json();
  assert.equal(logos.length, ANIMAL_LOGO_SET.length);
});

test("POST /api/logos uploads a logo image and returns its record", async () => {
  const boundary = "----t3boundary";
  const payload = multipartBody(
    { file: { value: PNG_BYTES.toString("latin1"), type: "image/png", filename: "hermes.png" } },
    boundary,
  );
  const res = await app.inject({
    method: "POST",
    url: "/api/logos",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(res.statusCode, 201);
  const { logo } = res.json();
  assert.equal(logo.source, "upload");
  assert.ok(logo.url.startsWith("/logos/uploads/"), `upload url: ${logo.url}`);
  const fileStats = await stat(join(dir, "uploads", logo.filename));
  assert.ok(fileStats.size > 0, "file should be stored on disk");
});

test("POST /api/logos wires a self-uploaded logo to an agent via the alias field", async () => {
  await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      alias: "Hermes",
      owner_employee_id: "zhang.wei",
      capabilities: { system: "hermes", mcp: [], tools: [], skills: [], specialty: "integration" },
    },
  });
  const boundary = "----t3boundary";
  const payload = multipartBody(
    {
      file: { value: PNG_BYTES.toString("latin1"), type: "image/png", filename: "hermes.png" },
      alias: { value: "Hermes" },
    },
    boundary,
  );
  const res = await app.inject({
    method: "POST",
    url: "/api/logos",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(res.statusCode, 201);
  const { logo } = res.json();
  const agentRes = await app.inject({ method: "GET", url: "/api/agents/Hermes" });
  assert.equal(agentRes.statusCode, 200);
  assert.equal(agentRes.json().logo_url, logo.url, "agent logo_url should point at the upload");
});

test("POST /api/logos returns 404 when alias does not match a registered agent", async () => {
  const boundary = "----t3boundary";
  const payload = multipartBody(
    {
      file: { value: PNG_BYTES.toString("latin1"), type: "image/png", filename: "hermes.png" },
      alias: { value: "Ghost" },
    },
    boundary,
  );
  const res = await app.inject({
    method: "POST",
    url: "/api/logos",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(res.statusCode, 404);
});

test("POST /api/logos rejects non-image mimetypes", async () => {
  const boundary = "----t3boundary";
  const payload = multipartBody(
    { file: { value: "not-an-image", type: "text/plain", filename: "x.txt" } },
    boundary,
  );
  const res = await app.inject({
    method: "POST",
    url: "/api/logos",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/logos rejects files whose content does not match the declared image type", async () => {
  const boundary = "----t3boundary";
  const payload = multipartBody(
    { file: { value: "definitely-not-a-real-png", type: "image/png", filename: "fake.png" } },
    boundary,
  );
  const res = await app.inject({
    method: "POST",
    url: "/api/logos",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/logos without multipart form-data returns 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/logos",
    payload: { file: "x" },
  });
  assert.equal(res.statusCode, 400);
});
