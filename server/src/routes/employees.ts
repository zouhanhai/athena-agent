import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthService } from "../employees/auth.js";
import {
  EMPLOYEE_ROLES,
  EmployeeConflictError,
  EmployeeNotFoundError,
  type EmployeeRecord,
  type EmployeeRegistry,
} from "../employees/employees.js";
import { roleHasPermission, type Permission } from "../employees/rbac.js";

export interface EmployeeRouteOptions {
  employees: EmployeeRegistry;
  auth: AuthService;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invalidString(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function isRole(value: unknown): value is "admin" | "member" {
  return (EMPLOYEE_ROLES as readonly unknown[]).includes(value);
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

async function currentEmployee(
  request: FastifyRequest,
  auth: AuthService,
): Promise<EmployeeRecord | null> {
  const token = bearerToken(request);
  if (!token) {
    return null;
  }
  return auth.getEmployeeForSession(token);
}

function mapEmployeeError(err: unknown): { code: number; message: string } | null {
  if (err instanceof EmployeeConflictError) {
    return { code: 409, message: err.message };
  }
  if (err instanceof EmployeeNotFoundError) {
    return { code: 404, message: err.message };
  }
  return null;
}

/**
 * Employee identity + email magic-link login + RBAC (G3.S2):
 * - POST /api/auth/login { email } → email a magic link (200)
 * - POST /api/auth/verify { token } → { session_token, employee } (200 | 401)
 * - GET /api/me (Bearer) → current employee
 * - GET/POST /api/employees, GET/PUT /api/employees/:email (admin RBAC)
 */
export function registerEmployeeRoutes(app: FastifyInstance, options: EmployeeRouteOptions): void {
  const { employees, auth } = options;

  app.post("/api/auth/login", async (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown };
    if (invalidString(body.email) || !EMAIL_RE.test((body.email as string).trim())) {
      return reply.code(400).send({ error: "a valid email is required" });
    }
    try {
      return await auth.requestLogin((body.email as string).trim());
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/auth/verify", async (request, reply) => {
    const body = (request.body ?? {}) as { token?: unknown };
    if (invalidString(body.token)) {
      return reply.code(400).send({ error: "token is required" });
    }
    try {
      const verification = await auth.verifyLogin((body.token as string).trim());
      if (!verification) {
        return reply.code(401).send({ error: "invalid or expired token" });
      }
      return verification;
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/me", async (request, reply) => {
    try {
      const employee = await currentEmployee(request, auth);
      if (!employee) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      return employee;
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const requireEmployee = async (
    request: FastifyRequest,
    reply: { code: (code: number) => { send: (payload: unknown) => unknown } },
    permission: Permission,
  ): Promise<EmployeeRecord | null> => {
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (!roleHasPermission(employee.role, permission)) {
      reply.code(403).send({ error: `forbidden: requires permission "${permission}"` });
      return null;
    }
    return employee;
  };

  app.get("/api/employees", async (request, reply) => {
    try {
      const employee = await requireEmployee(request, reply, "employees.list");
      if (!employee) {
        return;
      }
      const records = await employees.list();
      return { employees: records };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/employees", async (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown; display_name?: unknown; logo_url?: unknown; role?: unknown };
    if (invalidString(body.email) || !EMAIL_RE.test((body.email as string).trim())) {
      return reply.code(400).send({ error: "a valid email is required" });
    }
    if (body.display_name !== undefined && typeof body.display_name !== "string") {
      return reply.code(400).send({ error: "display_name must be a string" });
    }
    if (body.logo_url !== undefined && typeof body.logo_url !== "string") {
      return reply.code(400).send({ error: "logo_url must be a string" });
    }
    if (body.role !== undefined && !isRole(body.role)) {
      return reply.code(400).send({ error: `role must be one of: ${EMPLOYEE_ROLES.join(", ")}` });
    }
    try {
      const employee = await requireEmployee(request, reply, "employees.create");
      if (!employee) {
        return;
      }
      const record = await employees.create({
        email: (body.email as string).trim(),
        display_name: typeof body.display_name === "string" ? body.display_name : undefined,
        logo_url: typeof body.logo_url === "string" ? body.logo_url : undefined,
        role: isRole(body.role) ? body.role : undefined,
      });
      return reply.code(201).send(record);
    } catch (err) {
      const mapped = mapEmployeeError(err);
      if (mapped) {
        return reply.code(mapped.code).send({ error: mapped.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/employees/:email", async (request, reply) => {
    const { email } = request.params as { email?: string };
    if (typeof email !== "string" || email.trim().length === 0) {
      return reply.code(400).send({ error: "email is required" });
    }
    try {
      const employee = await requireEmployee(request, reply, "employees.list");
      if (!employee) {
        return;
      }
      const record = await employees.getByEmail(email.trim());
      if (!record) {
        return reply.code(404).send({ error: `employee "${email.trim()}" not found` });
      }
      return record;
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put("/api/employees/:email", async (request, reply) => {
    const { email } = request.params as { email?: string };
    if (typeof email !== "string" || email.trim().length === 0) {
      return reply.code(400).send({ error: "email is required" });
    }
    const body = (request.body ?? {}) as { display_name?: unknown; logo_url?: unknown; role?: unknown };
    const patch: { display_name?: string; logo_url?: string; role?: "admin" | "member" } = {};
    if (body.display_name !== undefined) {
      if (typeof body.display_name !== "string") {
        return reply.code(400).send({ error: "display_name must be a string" });
      }
      patch.display_name = body.display_name;
    }
    if (body.logo_url !== undefined) {
      if (typeof body.logo_url !== "string") {
        return reply.code(400).send({ error: "logo_url must be a string" });
      }
      patch.logo_url = body.logo_url;
    }
    if (body.role !== undefined) {
      if (!isRole(body.role)) {
        return reply.code(400).send({ error: `role must be one of: ${EMPLOYEE_ROLES.join(", ")}` });
      }
      patch.role = body.role;
    }
    try {
      const employee = await requireEmployee(request, reply, "employees.update");
      if (!employee) {
        return;
      }
      const record = await employees.updateByEmail(email.trim(), patch);
      return record;
    } catch (err) {
      const mapped = mapEmployeeError(err);
      if (mapped) {
        return reply.code(mapped.code).send({ error: mapped.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
