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
 * - PUT /api/agents/:alias { logo_url?, capabilities?, api_url?, agent_id?, token? } → update (200)
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
      return { declarations };
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
      return reply.code(201).send(result);
    } catch (err) {
      const mapped = mapRegistryError(err);
      if (mapped) {
        return reply.code(mapped.code).send({ error: mapped.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * G4.S7.T2: the invited agent registers auth'd — it proves possession of the
   * invitation token and records its real reachability (api_url) + status.
   */
  app.post("/api/agents/register", async (request, reply) => {
    const body = (request.body ?? {}) as { agent_id?: unknown; api_url?: unknown; token?: unknown };

    if (invalidString(body.agent_id)) {
      return reply.code(400).send({ error: "agent_id is required" });
    }
    // api_url is OPTIONAL — under reverse-WS (T4) the agent connects INTO the
    // platform, so it need not expose its own reachable API endpoint.
    if (body.token === undefined || typeof body.token !== "string" || body.token.trim() === "") {
      return reply.code(400).send({ error: "token is required" });
    }

    try {
      const record = await registry.registerWithInvite({
        agent_id: (body.agent_id as string).trim(),
        api_url: typeof body.api_url === "string" ? body.api_url.trim() : "",
        token: (body.token as string).trim(),
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
      logo_url?: unknown;
      capabilities?: unknown;
      agent_id?: unknown;
      api_url?: unknown;
      token?: unknown;
    };
    const patch: AgentUpdateInput = {};
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
      patch.logo_url === undefined &&
      patch.capabilities === undefined &&
      patch.agent_id === undefined &&
      patch.api_url === undefined &&
      patch.token === undefined
    ) {
      return reply.code(400).send({ error: "at least one of logo_url, capabilities, agent_id, api_url or token is required" });
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
}