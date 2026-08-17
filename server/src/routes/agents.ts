import type { FastifyInstance } from "fastify";
import {
  AgentAuthError,
  AgentConflictError,
  AgentNotFoundError,
  type AgentCapabilities,
  type AgentCreateInput,
  type AgentRegistry,
  type AgentUpdateInput,
} from "../agents/registry.js";
import type { AuthService } from "../employees/auth.js";
import { roleHasPermission } from "../employees/rbac.js";
import { currentEmployee } from "./helpers.js";
import type { AgentWsGateway } from "../ws/agent.js";
import type { EmployeeRegistry } from "../employees/employees.js";

export interface AgentRouteOptions {
  registry: AgentRegistry;
  /** Needed to gate the admin invitation endpoint (POST /api/agents/invite). */
  auth?: AuthService;
  /** G4.S7.T4: reverse-WS gateway — marks agents with a live tunnel as connected. */
  hub?: AgentWsGateway;
  /** Employee registry — lets the invite endpoint accept an owner EMAIL and
   *  resolve it to an employee id (more user-friendly than a raw UUID). */
  employees?: EmployeeRegistry;
}

interface AgentBody {
  alias?: unknown;
  owner_employee_id?: unknown;
  logo_url?: unknown;
  capabilities?: unknown;
  runtime?: unknown;
  agent_id?: unknown;
  api_url?: unknown;
  token?: unknown;
}

function invalidString(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Validate + normalize capabilities shape { system, mcp[], tools[], skills[], specialty, description? }. */
function parseCapabilities(value: unknown): AgentCapabilities | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const caps = value as Record<string, unknown>;
  if (invalidString(caps.system)) return null;
  if (!isStringArray(caps.mcp)) return null;
  if (!isStringArray(caps.tools)) return null;
  if (!isStringArray(caps.skills)) return null;
  if (invalidString(caps.specialty)) return null;
  if (caps.description !== undefined && typeof caps.description !== "string") return null;
  const capabilities: AgentCapabilities = {
    system: (caps.system as string).trim(),
    mcp: caps.mcp.map((item) => item.trim()),
    tools: caps.tools.map((item) => item.trim()),
    skills: caps.skills.map((item) => item.trim()),
    specialty: (caps.specialty as string).trim(),
  };
  if (typeof caps.description === "string" && caps.description.trim()) {
    capabilities.description = caps.description.trim();
  }
  // A2A-aligned: tags[] (discovery) + examples[] (sample prompts), both optional.
  if (isStringArray(caps.tags)) {
    capabilities.tags = caps.tags.map((item) => item.trim()).filter(Boolean);
  }
  if (isStringArray(caps.examples)) {
    capabilities.examples = caps.examples.map((item) => item.trim()).filter(Boolean);
  }
  return capabilities;
}

function mapRegistryError(err: unknown): { code: number; message: string } | null {
  if (err instanceof AgentConflictError) {
    return { code: 409, message: err.message };
  }
  if (err instanceof AgentNotFoundError) {
    return { code: 404, message: err.message };
  }
  if (err instanceof AgentAuthError) {
    return { code: 401, message: err.message };
  }
  return null;
}

/** Optional remote fields shared by invite + create + register-declaration bodies. */
function remoteFields(
  body: { agent_id?: unknown; api_url?: unknown; token?: unknown },
  reply: { code: (code: number) => { send: (payload: unknown) => unknown } },
): { agent_id?: string; api_url?: string; token?: string } | null {
  if (body.agent_id !== undefined && invalidString(body.agent_id)) {
    reply.code(400).send({ error: "agent_id must be a non-empty string" });
    return null;
  }
  if (body.api_url !== undefined && typeof body.api_url !== "string") {
    reply.code(400).send({ error: "api_url must be a string" });
    return null;
  }
  if (body.token !== undefined && invalidString(body.token)) {
    reply.code(400).send({ error: "token must be a non-empty string" });
    return null;
  }
  return {
    agent_id: typeof body.agent_id === "string" ? body.agent_id.trim() : undefined,
    api_url: typeof body.api_url === "string" ? body.api_url.trim() : undefined,
    token: typeof body.token === "string" ? body.token.trim() : undefined,
  };
}

/**
 * Agent registry endpoints:
 * - POST /api/agents/self-declare { agent_id, capabilities, runtime? } → agent auto-fills capabilities (201)
 * - GET /api/agents/declarations → pending self-declarations
 * - POST /api/agents/register-declaration/:id { alias, owner_employee_id, logo_url?, api_url?, token? } → employee confirms (201)
 * - POST /api/agents/invite (admin) → generate { agent_id, api_url, token } invitation (201)
 * - POST /api/agents/register { agent_id, api_url, token } → invited agent registers auth'd; records reachability (200)
 * - POST /api/agents { alias, owner_employee_id, logo_url?, capabilities, runtime?, agent_id?, api_url?, token? } → register (201)
 * - PUT /api/agents/:alias { alias?, logo_url?, capabilities?, api_url?, agent_id?, token? } → update (200); capabilities changes require re-confirm
 * - POST /api/agents/:agentId/confirm (owner/admin Bearer) → approve the declared capabilities (200)
 * - GET /api/agents?ownerEmployeeId= → list
 * - GET /api/agents/:alias → single agent
 */
export function registerAgentRoutes(app: FastifyInstance, options: AgentRouteOptions): void {
  const { registry, auth, hub } = options;

  /** G4.S7.T4: attach live reverse-WS reachability to an AgentRecord. */
  function withConnectivity(record: import("../agents/registry.js").AgentRecord) {
    const connected = hub?.isConnected(record.agent_id) ?? false;
    return connected ? { ...record, connected } : record;
  }

  app.post("/api/agents/self-declare", async (request, reply) => {
    const body = (request.body ?? {}) as { agent_id?: unknown; capabilities?: unknown; runtime?: unknown };

    if (invalidString(body.agent_id)) {
      return reply.code(400).send({ error: "agent_id is required" });
    }
    if (body.runtime !== undefined && typeof body.runtime !== "string") {
      return reply.code(400).send({ error: "runtime must be a string" });
    }
    const capabilities = parseCapabilities(body.capabilities);
    if (!capabilities) {
      return reply
        .code(400)
        .send({ error: "capabilities must be { system, mcp: string[], tools: string[], skills: string[], specialty, description? }" });
    }

    try {
      const declaration = await registry.submitDeclaration({
        agent_id: (body.agent_id as string).trim(),
        capabilities,
        runtime: typeof body.runtime === "string" ? body.runtime : "",
      });
      return reply.code(201).send({ declaration });
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/agents/declarations", async (_request, reply) => {
    try {
      const declarations = await registry.listDeclarations();
      // Enrich each pending declaration with the invite alias + owner email of
      // the agent it belongs to (if that agent was invited/registered before
      // the self-declaration — G4.S7.T9). This lets the confirm page prefill
      // the alias and show the owner as an EMAIL (invite-time input), matching
      // what the user typed when inviting the agent, instead of a raw UUID.
      const enriched: unknown[] = [];
      for (const declaration of declarations) {
        let suggested_alias: string | undefined;
        let suggested_owner_email: string | undefined;
        const existing = await registry.getByAgentId(declaration.agent_id);
        if (existing?.alias && existing.owner_employee_id && options.employees) {
          suggested_alias = existing.alias;
          const owner = await options.employees.getById(existing.owner_employee_id);
          if (owner) {
            suggested_owner_email = owner.email;
          }
        }
        enriched.push(declaration.suggested_alias && declaration.suggested_owner_email ? declaration : { ...declaration, suggested_alias, suggested_owner_email });
      }
      return { declarations: enriched };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/agents/register-declaration/:id", async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (typeof id !== "string" || id.trim().length === 0) {
      return reply.code(400).send({ error: "declaration id is required" });
    }
    const body = (request.body ?? {}) as {
      alias?: unknown;
      owner_employee_id?: unknown;
      logo_url?: unknown;
      agent_id?: unknown;
      api_url?: unknown;
      token?: unknown;
    };

    if (invalidString(body.alias)) {
      return reply.code(400).send({ error: "alias is required" });
    }
    if (invalidString(body.owner_employee_id)) {
      return reply.code(400).send({ error: "owner_employee_id is required" });
    }
    if (body.logo_url !== undefined && typeof body.logo_url !== "string") {
      return reply.code(400).send({ error: "logo_url must be a string" });
    }
    const remote = remoteFields(body, reply);
    if (remote === null) {
      return;
    }

    try {
      const record = await registry.registerDeclaration(id.trim(), {
        alias: (body.alias as string).trim(),
        owner_employee_id: (body.owner_employee_id as string).trim(),
        logo_url: typeof body.logo_url === "string" ? body.logo_url : "",
        agent_id: remote.agent_id,
        api_url: remote.api_url,
        token: remote.token,
      });
      return reply.code(201).send(record);
    } catch (err) {
      const mapped = mapRegistryError(err);
      if (mapped) {
        return reply.code(mapped.code).send({ error: mapped.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * G4.S7.T2 invitation onboarding: an admin generates `{agent_id, api_url, token}`
   * and hands it to the remote agent, which then registers via
   * POST /api/agents/register. Mirrors the employee-invitation flow.
   */
  app.post("/api/agents/invite", async (request, reply) => {
    const body = (request.body ?? {}) as AgentBody;

    if (invalidString(body.alias)) {
      return reply.code(400).send({ error: "alias is required" });
    }
    if (invalidString(body.owner_employee_id)) {
      return reply.code(400).send({ error: "owner_employee_id is required" });
    }
    if (body.logo_url !== undefined && typeof body.logo_url !== "string") {
      return reply.code(400).send({ error: "logo_url must be a string" });
    }
    if (body.runtime !== undefined && typeof body.runtime !== "string") {
      return reply.code(400).send({ error: "runtime must be a string" });
    }
    const remote = remoteFields(body, reply);
    if (remote === null) {
      return;
    }
    if (body.capabilities !== undefined) {
      const capabilities = parseCapabilities(body.capabilities);
      if (!capabilities) {
        return reply
          .code(400)
          .send({ error: "capabilities must be { system, mcp: string[], tools: string[], skills: string[], specialty, description? }" });
      }
    }

    try {
      const employee = await currentEmployee(request, auth!);
      if (!employee) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      if (!roleHasPermission(employee.role, "agent.register")) {
        return reply.code(403).send({ error: 'forbidden: requires permission "agent.register"' });
      }
      // Resolve an owner EMAIL to an employee id (friendlier than a raw UUID).
      let ownerEmployeeId = (body.owner_employee_id as string).trim();
      if (ownerEmployeeId.includes("@") && options.employees) {
        const owner = await options.employees.getByEmail(ownerEmployeeId);
        if (!owner) {
          return reply.code(400).send({ error: `no employee found for email "${ownerEmployeeId}"` });
        }
        ownerEmployeeId = owner.id;
      }
      const capabilities = parseCapabilities(body.capabilities);
      const result = await registry.createInvitation({
        alias: (body.alias as string).trim(),
        owner_employee_id: ownerEmployeeId,
        logo_url: typeof body.logo_url === "string" ? body.logo_url : "",
        runtime: typeof body.runtime === "string" ? body.runtime : "",
        agent_id: remote.agent_id,
        api_url: remote.api_url,
        capabilities: capabilities ?? undefined,
      });
      // Give the remote agent a self-serve onboarding link it can open to read
      // the registration flow + its credentials + the capability-declaration
      // format, then register itself (T5). Base = the PUBLIC base URL
      // (APP_BASE_URL, e.g. https://athenakb.com) so the link works for a remote
      // agent over the Cloudflare tunnel — NOT the incoming request host, which
      // could be localhost in dev.
      const publicBase = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
      const base =
        publicBase ||
        (request.headers["x-forwarded-proto"] === "https" ? "https" : request.protocol) +
          "://" +
          (request.headers.host ?? request.hostname);
      const withUrl = {
        ...result,
        invite: {
          ...result.invite,
          // Agent-readable onboarding guide: GET this URL to READ what
          // registration is, how to register, and how to declare capabilities.
          // The agent then calls the register / self-declare endpoints itself
          // (no browser form needed).
          onboarding_url: `${base}/api/agents/onboard?token=${encodeURIComponent((result.invite as { token: string }).token)}`,
        },
      };
      return reply.code(201).send(withUrl);
    } catch (err) {
      const mapped = mapRegistryError(err);
      if (mapped) {
        return reply.code(mapped.code).send({ error: mapped.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Agent self-serve onboarding guide (T5): a remote agent opens the onboarding
   * URL (GET /api/agents/onboard?token=…) to READ what registration is, how to
   * register, and how to declare capabilities — then it calls the register /
   * self-declare endpoints itself (no browser form needed).
   */
  app.get("/api/agents/onboard", async (request, reply) => {
    const { token } = request.query as { token?: unknown };
    if (typeof token !== "string" || !token.trim()) {
      return reply.code(400).send({ error: "token is required" });
    }
    const agent = await registry.getByInviteToken(token.trim());
    if (!agent) {
      return reply.code(404).send({ error: "invalid or expired invitation token" });
    }
    const publicBase = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
    const base = publicBase || (request.headers["x-forwarded-proto"] === "https" ? "https" : request.protocol) + "://" + (request.headers.host ?? request.hostname);
    const wsBase = base.replace(/^https/, "wss").replace(/^http/, "ws");
    return reply.send({
      platform: "athenakb.com",
      purpose:
        "Register this agent into the Athena agent platform and declare what it can do, then connect over reverse WebSocket.",
      invitation: {
        agent_id: agent.agent_id,
        alias: agent.alias,
        token: token.trim(),
        status: agent.status,
      },
      register: {
        method: "POST",
        endpoint: `${base}/api/agents/register`,
        contentType: "application/json",
        body: {
          agent_id: agent.agent_id,
          api_url: "optional — leave blank; reverse-WS connects INTO the platform",
          token: token.trim(),
          capabilities: "optional — declare what you can do HERE, in the SAME request (see capabilities section). If omitted, declare later via self-declare.",
          runtime: "optional — e.g. hermes-agent / opencode / codex / pi",
        },
        notes: [
          "agent_id + token are REQUIRED. api_url is optional.",
          "On success you get the agent record back with status reachable.",
          "If you include capabilities in this request, they are stored on your agent row PENDING REVIEW — an owner must confirm them before they become active.",
          "Calling this endpoint AGAIN with the same agent_id + token UPDATES your existing registration: re-submitted capabilities REPLACE the previous ones and go back to pending review. This is how you update your capabilities — just register again with the new capabilities.",
        ],
      },
      capabilities: {
        purpose:
          "Declare what the agent can do (A2A-aligned). Two ways: (1) include it in the register request (recommended — one call), or (2) POST to self-declare afterwards, which the owner also reviews.",
        fields: {
          system: "runtime family, e.g. hermes / opencode / codex / pi",
          specialty: "e.g. general / integration / sap",
          mcp: "string[] of MCP server ids this agent exposes",
          tools: "string[] of tool ids this agent provides",
          skills: "string[] of skill ids this agent has",
          tags: "string[] discovery tags, e.g. [\"sap\",\"reporting\"]",
          examples: "string[] sample prompts, e.g. [\"How is Q2 reporting structured?\"]",
          description: "optional short blurb",
        },
        inRegister: {
          method: "POST",
          endpoint: `${base}/api/agents/register`,
          body: {
            agent_id: agent.agent_id,
            token: token.trim(),
            capabilities: {
              system: "hermes",
              specialty: "sap",
              mcp: ["<mcp-server-id>"],
              tools: ["<tool-id>"],
              skills: ["<skill-id>"],
              tags: ["example-tag"],
              examples: ["How is Q2 reporting structured?"],
              description: "optional short blurb",
            },
          },
        },
        declareMethod: "POST",
        declareEndpoint: `${base}/api/agents/self-declare`,
        declareBody: {
          agent_id: agent.agent_id,
          capabilities: {
            system: "",
            mcp: [],
            tools: [],
            skills: [],
            specialty: "",
            tags: [],
            examples: [],
          },
          runtime: "optional",
        },
      },
      updatingCapabilities: {
        purpose:
          "Already registered? Use the SAME invitation link and registration endpoint to update what you declared.",
        steps: [
          "Call POST /api/agents/register again with the SAME agent_id + token.",
          "Submit the complete NEW capabilities object (it REPLACES the old one entirely — there is no append/merge).",
          "Your updated capabilities go to pending review; the owner confirms them in Settings before they become active.",
          "Do NOT submit a different agent_id — that would be treated as a new/unknown agent. Keep your original agent_id.",
        ],
        exampleBody: {
          agent_id: agent.agent_id,
          token: token.trim(),
          capabilities: {
            system: "hermes",
            specialty: "sap",
            mcp: ["<mcp-server-id>"],
            tools: ["<tool-id>"],
            skills: ["<skill-id>"],
            tags: ["example-tag"],
            examples: ["How is Q2 reporting structured?"],
          },
          runtime: "hermes-agent",
        },
      },
      connect: {
        method: "WebSocket",
        endpoint: `${wsBase}/ws/agent`,
        registerFrame: {
          type: "register",
          agent_id: agent.agent_id,
          token: token.trim(),
        },
        notes: ["Connect to become reachable and receive pushed tasks."],
      },
    });
  });

  /**
   * G4.S7.T2: the invited agent registers auth'd — it proves possession of the
   * invitation token and records its real reachability (api_url) + status.
   */
  app.post("/api/agents/register", async (request, reply) => {
    const body = (request.body ?? {}) as {
      agent_id?: unknown;
      api_url?: unknown;
      token?: unknown;
      capabilities?: unknown;
      runtime?: unknown;
    };

    if (invalidString(body.agent_id)) {
      return reply.code(400).send({ error: "agent_id is required" });
    }
    // api_url is OPTIONAL — under reverse-WS (T4) the agent connects INTO the
    // platform, so it need not expose its own reachable API endpoint.
    if (body.token === undefined || typeof body.token !== "string" || body.token.trim() === "") {
      return reply.code(400).send({ error: "token is required" });
    }
    // The agent MAY ship its capability profile in the SAME request (G4.S7.T9):
    // capabilities + runtime get stored on the agent row directly, so no
    // separate self-declare / confirm round-trip is needed.
    let capabilities: AgentCapabilities | null | undefined;
    if (body.capabilities !== undefined) {
      capabilities = parseCapabilities(body.capabilities);
      if (!capabilities) {
        return reply
          .code(400)
          .send({ error: "capabilities must be { system, mcp: string[], tools: string[], skills: string[], specialty, description? }" });
      }
    }

    try {
      const record = await registry.registerWithInvite({
        agent_id: (body.agent_id as string).trim(),
        api_url: typeof body.api_url === "string" ? body.api_url.trim() : "",
        token: (body.token as string).trim(),
        capabilities: capabilities ?? undefined,
        runtime: typeof body.runtime === "string" ? body.runtime.trim() : "",
      });
      return record;
    } catch (err) {
      const mapped = mapRegistryError(err);
      if (mapped) {
        return reply.code(mapped.code).send({ error: mapped.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Delete an agent record (cancel an invitation / remove a registered agent).
   *  Only the agent's owner or an admin may delete it. */
  app.delete("/api/agents/:agentId", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      const employee = await currentEmployee(request, auth!);
      if (!employee) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const target = await registry.getByAgentId(agentId);
      if (!target) {
        return reply.code(404).send({ error: "agent not found" });
      }
      // Owner or admin (system default agents like Athena can't be deleted by an owner).
      const isOwner = target.owner_employee_id === employee.id;
      const canDelete =
        isOwner || roleHasPermission(employee.role, "agent.register");
      if (!canDelete) {
        return reply.code(403).send({ error: 'forbidden: you can only delete your own agents' });
      }
      await registry.deleteByAgentId(agentId);
      return { ok: true };
    } catch (err) {
      const mapped = mapRegistryError(err);
      if (mapped) {
        return reply.code(mapped.code).send({ error: mapped.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/agents", async (request, reply) => {
    const body = (request.body ?? {}) as AgentBody;

    if (invalidString(body.alias)) {
      return reply.code(400).send({ error: "alias is required" });
    }
    if (invalidString(body.owner_employee_id)) {
      return reply.code(400).send({ error: "owner_employee_id is required" });
    }
    if (body.logo_url !== undefined && typeof body.logo_url !== "string") {
      return reply.code(400).send({ error: "logo_url must be a string" });
    }
    if (body.runtime !== undefined && typeof body.runtime !== "string") {
      return reply.code(400).send({ error: "runtime must be a string" });
    }
    const capabilities = parseCapabilities(body.capabilities);
    if (!capabilities) {
      return reply
        .code(400)
        .send({ error: "capabilities must be { system, mcp: string[], tools: string[], skills: string[], specialty, description? }" });
    }
    const remote = remoteFields(body, reply);
    if (remote === null) {
      return;
    }

    const input: AgentCreateInput = {
      alias: (body.alias as string).trim(),
      owner_employee_id: (body.owner_employee_id as string).trim(),
      logo_url: typeof body.logo_url === "string" ? body.logo_url : "",
      capabilities,
      runtime: typeof body.runtime === "string" ? body.runtime : "",
      agent_id: remote.agent_id,
      api_url: remote.api_url,
      token: remote.token,
    };

    try {
      const record = await registry.create(input);
      return reply.code(201).send(record);
    } catch (err) {
      const mapped = mapRegistryError(err);
      if (mapped) {
        return reply.code(mapped.code).send({ error: mapped.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put("/api/agents/:alias", async (request, reply) => {
    const { alias } = request.params as { alias?: string };
    if (typeof alias !== "string" || alias.trim().length === 0) {
      return reply.code(400).send({ error: "alias is required" });
    }
    const body = (request.body ?? {}) as {
      alias?: unknown;
      logo_url?: unknown;
      capabilities?: unknown;
      agent_id?: unknown;
      api_url?: unknown;
      token?: unknown;
    };
    const patch: AgentUpdateInput = {};
    if (body.alias !== undefined) {
      if (invalidString(body.alias)) {
        return reply.code(400).send({ error: "alias must be a non-empty string" });
      }
      patch.alias = (body.alias as string).trim();
    }
    if (body.logo_url !== undefined) {
      if (typeof body.logo_url !== "string") {
        return reply.code(400).send({ error: "logo_url must be a string" });
      }
      patch.logo_url = body.logo_url;
    }
    if (body.capabilities !== undefined) {
      const capabilities = parseCapabilities(body.capabilities);
      if (!capabilities) {
        return reply
          .code(400)
          .send({ error: "capabilities must be { system, mcp: string[], tools: string[], skills: string[], specialty, description? }" });
      }
      patch.capabilities = capabilities;
    }
    const remote = remoteFields(body, reply);
    if (remote === null) {
      return;
    }
    if (remote.agent_id !== undefined) patch.agent_id = remote.agent_id;
    if (remote.api_url !== undefined) patch.api_url = remote.api_url;
    if (remote.token !== undefined) patch.token = remote.token;
    if (
      patch.alias === undefined &&
      patch.logo_url === undefined &&
      patch.capabilities === undefined &&
      patch.agent_id === undefined &&
      patch.api_url === undefined &&
      patch.token === undefined
    ) {
      return reply.code(400).send({ error: "at least one of alias, logo_url, capabilities, agent_id, api_url or token is required" });
    }

    try {
      const record = await registry.updateByAlias(alias.trim(), patch);
      return reply.code(200).send(record);
    } catch (err) {
      const mapped = mapRegistryError(err);
      if (mapped) {
        return reply.code(mapped.code).send({ error: mapped.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/agents", async (request, reply) => {
    const { ownerEmployeeId } = request.query as { ownerEmployeeId?: unknown };
    const filter =
      typeof ownerEmployeeId === "string" && ownerEmployeeId.trim()
        ? { ownerEmployeeId: ownerEmployeeId.trim() }
        : undefined;
    try {
      const agents = await registry.list(filter);
      return { agents: agents.map(withConnectivity) };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/agents/:alias", async (request, reply) => {
    const { alias } = request.params as { alias?: string };
    if (typeof alias !== "string" || alias.trim().length === 0) {
      return reply.code(400).send({ error: "alias is required" });
    }
    try {
      const record = await registry.getByAlias(alias.trim());
      if (!record) {
        return reply.code(404).send({ error: `agent "${alias.trim()}" not found` });
      }
      return withConnectivity(record);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * G4.S7.T9: the owner approves the agent's current declared capabilities
   * (clears the pending-review state). Only the agent's owner or an admin may
   * confirm it.
   */
  app.post("/api/agents/:agentId/confirm", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    try {
      const employee = await currentEmployee(request, auth!);
      if (!employee) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const target = await registry.getByAgentId(agentId);
      if (!target) {
        return reply.code(404).send({ error: "agent not found" });
      }
      const isOwner = target.owner_employee_id === employee.id;
      const canConfirm =
        isOwner || roleHasPermission(employee.role, "agent.register");
      if (!canConfirm) {
        return reply.code(403).send({ error: "forbidden: you can only confirm your own agents" });
      }
      const record = await registry.confirmCapabilities(agentId);
      if (!record) {
        return reply.code(404).send({ error: "agent not found" });
      }
      return withConnectivity(record);
    } catch (err) {
      const mapped = mapRegistryError(err);
      if (mapped) {
        return reply.code(mapped.code).send({ error: mapped.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}