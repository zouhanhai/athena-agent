import type { FastifyInstance } from "fastify";
import {
  AgentConflictError,
  AgentNotFoundError,
  type AgentCapabilities,
  type AgentCreateInput,
  type AgentRegistry,
  type AgentUpdateInput,
} from "../agents/registry.js";

export interface AgentRouteOptions {
  registry: AgentRegistry;
}

interface AgentBody {
  alias?: unknown;
  owner_employee_id?: unknown;
  logo_url?: unknown;
  capabilities?: unknown;
  runtime?: unknown;
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
  return null;
}

/**
 * Agent registry endpoints:
 * - POST /api/agents { alias, owner_employee_id, logo_url?, capabilities, runtime? } → register (201)
 * - PUT /api/agents/:alias { logo_url?, capabilities? } → update (200)
 * - GET /api/agents?ownerEmployeeId= → list
 * - GET /api/agents/:alias → single agent
 */
export function registerAgentRoutes(app: FastifyInstance, options: AgentRouteOptions): void {
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

    const input: AgentCreateInput = {
      alias: (body.alias as string).trim(),
      owner_employee_id: (body.owner_employee_id as string).trim(),
      logo_url: typeof body.logo_url === "string" ? body.logo_url : "",
      capabilities,
      runtime: typeof body.runtime === "string" ? body.runtime : "",
    };

    try {
      const record = await options.registry.create(input);
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
    const body = (request.body ?? {}) as { logo_url?: unknown; capabilities?: unknown };
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
    if (patch.logo_url === undefined && patch.capabilities === undefined) {
      return reply.code(400).send({ error: "at least one of logo_url or capabilities is required" });
    }

    try {
      const record = await options.registry.updateByAlias(alias.trim(), patch);
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
      const agents = await options.registry.list(filter);
      return { agents };
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
      const record = await options.registry.getByAlias(alias.trim());
      if (!record) {
        return reply.code(404).send({ error: `agent "${alias.trim()}" not found` });
      }
      return record;
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
