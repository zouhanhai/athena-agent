import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/app.js";
import { IngestTaskQueue } from "../../src/kb/tasks.js";
import {
  MemoryAgentRegistry,
  type AgentRegistry,
} from "../../src/agents/registry.js";
import {
  MagicLinkAuthService,
  MemoryAuthTokenStore,
  type MagicLinkMailer,
} from "../../src/employees/auth.js";
import { MemoryEmployeeRegistry } from "../../src/employees/employees.js";
import { createSecretCipher } from "../../src/employees/crypto.js";
import type { FastifyInstance } from "fastify";

// G4.S8.T10: the code-intake channels (cds/abap/ui5/ddic) require auth — accept
// an agent invitation token OR an employee session token; missing/invalid → 401.
// MCP (KB-as-MCP) stays retrieval-only; no changes here.

const CDS_FIXTURE = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "cds",
  "gr-cds-scope.cds",
);
const TEST_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const CAPABILITIES = {
  system: "hermes",
  mcp: [],
  tools: ["shell"],
  skills: [],
  specialty: "coding",
};

let cdsContent: string;
before(async () => {
  cdsContent = await readFile(CDS_FIXTURE, "utf8");
});

function makeTaskQueue(): IngestTaskQueue {
  const ingest = {
    async prepareForIngest(input: { title: string; content: string }) {
      return {
        classification: { category: "concept", pagePath: `wiki/concepts/${input.title}.md`, topic: "sommerseminar" },
        frontmatterContent: `---\ntype: concept\ntitle: ${input.title}\ntopic: sommerseminar\n---\n\n${input.content}`,
      };
    },
    async ingestLlmWiki() {
      return { ok: true };
    },
  };
  const refiner = async () => ({
    ref: {
      md_ref: "/storage/uploaded/markdown.md",
      chunks_ref: "/storage/uploaded/chunks.json",
      preview: "preview",
      char_count: 1,
      line_count: 1,
      header_count: 1,
      chunk_count: 1,
      frontmatter: { type: "concept", topic: "sommerseminar" },
      entities: [],
      relations: [],
      keywords: [],
      quality: { complete: true, confidence: 0.9, issues: [], action: "auto_accept" },
      mode: "single",
      sections: [],
    },
    markdown: "# X",
    ragMarkdown: "# X",
  });
  return new IngestTaskQueue({
    parser: {
      async parse() {
        throw new Error("code channels must not parse via docling");
      },
    } as never,
    ingest: ingest as never,
    refiner: refiner as never,
  });
}

interface SentMail {
  to: string;
  magicLinkUrl: string;
}
function tokenFromUrl(url: string): string {
  const match = /[?&]token=([^&]+)/.exec(url);
  assert.ok(match, `magic link should carry a token: ${url}`);
  return decodeURIComponent(match[1] ?? "");
}

interface AuthHarness {
  app: FastifyInstance;
  registry: AgentRegistry;
  agentToken: string;
  employeeToken: string;
}

async function buildAuthHarness(): Promise<AuthHarness> {
  const registry = new MemoryAgentRegistry();
  const invite = await registry.createInvitation({
    alias: "RemoteHermes",
    owner_employee_id: "e1",
    capabilities: CAPABILITIES,
    runtime: "hermes",
  });

  const sent: SentMail[] = [];
  const employees = new MemoryEmployeeRegistry(
    [{ email: "admin@caleo.com", display_name: "Admin", role: "admin" }],
    { cipher: createSecretCipher(TEST_KEY) },
  );
  const mailer: MagicLinkMailer = {
    async sendLoginLink(input) {
      sent.push({ to: input.to, magicLinkUrl: input.magicLinkUrl });
    },
  };
  const auth = new MagicLinkAuthService({
    registry: employees,
    mailer,
    tokens: new MemoryAuthTokenStore(),
    appBaseUrl: "http://localhost:5173",
  });

  const app = buildApp({ taskQueue: makeTaskQueue(), registry, employees, auth });
  await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@caleo.com" } });
  const verifyUrl = sent[sent.length - 1]!.magicLinkUrl;
  const magicToken = tokenFromUrl(verifyUrl);
  const verify = await app.inject({ method: "POST", url: "/api/auth/verify", payload: { token: magicToken } });
  assert.equal(verify.statusCode, 200);
  const employeeToken = (verify.json() as { session_token: string }).session_token;

  return { app, registry, agentToken: invite.invite.token, employeeToken };
}

function cdsPayload(): Record<string, string> {
  return { kind: "cds", filename: "gr-cds-scope.cds", content: cdsContent };
}

test("intake auth: code channels return 401 without any token (G4.S8.T10)", async () => {
  const { app } = await buildAuthHarness();
  try {
    const dir = await mkdtemp(join(tmpdir(), "kb-auth-"));
    const prev = process.env.CODE_OUTPUT_DIR;
    process.env.CODE_OUTPUT_DIR = dir;
    try {
      for (const kind of ["cds", "abap", "ui5", "ddic"]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/kb/ingest",
          payload: kind === "ui5" ? { kind, files: { "webapp/x/x.js": "x" } } : { kind, content: "x" },
        });
        assert.equal(
          res.statusCode,
          401,
          `kind=${kind} must 401 without a token (got ${res.statusCode})`,
        );
      }
    } finally {
      if (prev === undefined) delete process.env.CODE_OUTPUT_DIR;
      else process.env.CODE_OUTPUT_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await app.close();
  }
});

test("intake auth: code channels return 401 with an invalid token (G4.S8.T10)", async () => {
  const { app } = await buildAuthHarness();
  try {
    const dir = await mkdtemp(join(tmpdir(), "kb-auth-"));
    const prev = process.env.CODE_OUTPUT_DIR;
    process.env.CODE_OUTPUT_DIR = dir;
    try {
      for (const kind of ["cds", "abap", "ui5", "ddic"]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/kb/ingest",
          headers: { authorization: "Bearer definitely-not-a-real-token" },
          payload: kind === "ui5" ? { kind, files: { "webapp/x/x.js": "x" } } : { kind, content: "x" },
        });
        assert.equal(
          res.statusCode,
          401,
          `kind=${kind} must 401 with an invalid token (got ${res.statusCode})`,
        );
      }
    } finally {
      if (prev === undefined) delete process.env.CODE_OUTPUT_DIR;
      else process.env.CODE_OUTPUT_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await app.close();
  }
});

test("intake auth: code channels accept a valid AGENT invitation token → 202 (G4.S8.T10)", async () => {
  const { app, agentToken } = await buildAuthHarness();
  try {
    const dir = await mkdtemp(join(tmpdir(), "kb-auth-"));
    const prev = process.env.CODE_OUTPUT_DIR;
    process.env.CODE_OUTPUT_DIR = dir;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/kb/ingest",
        headers: { authorization: `Bearer ${agentToken}` },
        payload: cdsPayload(),
      });
      assert.equal(res.statusCode, 202, "an agent token authenticates the intake route");
      const body = res.json() as { taskId?: string; kind?: string };
      assert.ok(body.taskId);
      assert.equal(body.kind, "cds");
    } finally {
      if (prev === undefined) delete process.env.CODE_OUTPUT_DIR;
      else process.env.CODE_OUTPUT_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await app.close();
  }
});

test("intake auth: code channels accept a valid EMPLOYEE session token → 202 (G4.S8.T10)", async () => {
  const { app, employeeToken } = await buildAuthHarness();
  try {
    const dir = await mkdtemp(join(tmpdir(), "kb-auth-"));
    const prev = process.env.CODE_OUTPUT_DIR;
    process.env.CODE_OUTPUT_DIR = dir;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/kb/ingest",
        headers: { authorization: `Bearer ${employeeToken}` },
        payload: cdsPayload(),
      });
      assert.equal(res.statusCode, 202, "an employee session token authenticates the intake route");
      const body = res.json() as { taskId?: string; kind?: string };
      assert.ok(body.taskId);
      assert.equal(body.kind, "cds");
    } finally {
      if (prev === undefined) delete process.env.CODE_OUTPUT_DIR;
      else process.env.CODE_OUTPUT_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await app.close();
  }
});
