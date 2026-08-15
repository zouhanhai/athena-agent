import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthService } from "../employees/auth.js";
import {
  EMPLOYEE_ROLES,
  EmployeeConflictError,
  EmployeeNotFoundError,
  isGithubCredentialType,
  type EmployeeRecord,
  type EmployeeRegistry,
  type EmployeeUpdateInput,
  type GithubCredential,
  type GithubCredentialType,
} from "../employees/employees.js";
import type { AgentRegistry } from "../agents/registry.js";
import {
  ALL_PERMISSIONS,
  roleHasPermission,
  type Permission,
} from "../employees/rbac.js";
import { currentEmployee } from "./helpers.js";

export interface EmployeeRouteOptions {
  employees: EmployeeRegistry;
  auth: AuthService;
  agents: AgentRegistry;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invalidString(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * Partial mask of a stored GitHub credential so the UI can show first + last 4
 * chars for the user to compare with GitHub — never the full secret.
 */
export function maskGithubCredential(value: string): string {
  if (value.length <= 8) {
    return "****";
  }
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/** Employee record enriched with GitHub credential presence (never the value). */
export type MeEmployee = EmployeeRecord & {
  github_has_credential: boolean;
  github_credential_type?: GithubCredentialType;
  github_credential_masked?: string;
};

/**
 * Enrich an employee record with GitHub credential presence + a partial mask.
 * Used by GET /api/me and PUT /api/me so the frontend can show the mask —
 * including right after a save.
 */
async function withGithubPresence(
  employees: EmployeeRegistry,
  record: EmployeeRecord,
): Promise<MeEmployee> {
  const credential = await employees.getGithubCredential(record.email);
  if (!credential) {
    return { ...record, github_has_credential: false };
  }
  return {
    ...record,
    github_has_credential: true,
    github_credential_type: credential.type,
    github_credential_masked: maskGithubCredential(credential.value),
  };
}

function isRole(value: unknown): value is "admin" | "member" {
  return (EMPLOYEE_ROLES as readonly unknown[]).includes(value);
}

/** Validate an optional github_credential body; returns the input or a 400 reply. */
function githubCredentialFromBody(
  value: unknown,
  reply: { code: (code: number) => { send: (payload: unknown) => unknown } },
): GithubCredential | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    reply.code(400).send({ error: "github_credential must be an object" });
    return null;
  }
  const cred = value as { type?: unknown; value?: unknown };
  if (!isGithubCredentialType(cred.type)) {
    reply.code(400).send({ error: "github_credential.type must be one of: ssh, token" });
    return null;
  }
  if (typeof cred.value !== "string" || cred.value.trim().length === 0) {
    reply.code(400).send({ error: "github_credential.value is required" });
    return null;
  }
  return { type: cred.type, value: cred.value.trim() };
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
 * - PUT /api/me (Bearer) → update own display_name / logo_url / github_credential
 * - GET/POST /api/employees, GET/PUT /api/employees/:email (admin RBAC)
 * - GET /api/employees/:id/agents → agents archived under an employee
 */
export function registerEmployeeRoutes(app: FastifyInstance, options: EmployeeRouteOptions): void {
  const { employees, auth, agents } = options;

  app.post("/api/auth/login", async (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown; password?: unknown };
    if (invalidString(body.email) || !EMAIL_RE.test((body.email as string).trim())) {
      return reply.code(400).send({ error: "a valid email is required" });
    }
    const email = (body.email as string).trim();
    try {
      // G4.S7.T6: with a password, sign in with email+password (bcrypt). When the
      // employee has no password set, fall back to the magic link so they can still
      // get in. Without a password, the request is the classic magic-link flow.
      if (typeof body.password === "string" && body.password.length > 0) {
        const result = await auth.loginWithPassword(email, body.password);
        if (result.kind === "authenticated") {
          return { session_token: result.session_token, employee: result.employee };
        }
        if (result.kind === "invalid-credentials") {
          return reply.code(401).send({ error: "invalid email or password" });
        }
      }
      return await auth.requestLogin(email);
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
      return withGithubPresence(employees, employee);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Update the signed-in employee's own profile (self-scoped, no RBAC permission
   * needed): display_name, logo_url and/or github_credential (encrypted at rest,
   * never returned in the response).
   */
  app.put("/api/me", async (request, reply) => {
    const body = (request.body ?? {}) as {
      display_name?: unknown;
      logo_url?: unknown;
      github_credential?: unknown;
    };
    const patch: EmployeeUpdateInput = {};
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
    const githubCredential = githubCredentialFromBody(body.github_credential, reply);
    if (githubCredential === null) {
      return;
    }
    if (githubCredential !== undefined) {
      patch.github_credential = githubCredential;
    }
    try {
      const employee = await currentEmployee(request, auth);
      if (!employee) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const record = await employees.updateByEmail(employee.email, patch);
      return withGithubPresence(employees, record);
    } catch (err) {
      const mapped = mapEmployeeError(err);
      if (mapped) {
        return reply.code(mapped.code).send({ error: mapped.message });
      }
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
    const body = (request.body ?? {}) as {
      email?: unknown;
      display_name?: unknown;
      logo_url?: unknown;
      role?: unknown;
      github_credential?: unknown;
    };
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
    const githubCredential = githubCredentialFromBody(body.github_credential, reply);
    if (githubCredential === null) {
      return;
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
        github_credential: githubCredential,
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
    const body = (request.body ?? {}) as {
      display_name?: unknown;
      logo_url?: unknown;
      role?: unknown;
      permissions?: unknown;
    };
    const patch: { display_name?: string; logo_url?: string; role?: "admin" | "member"; permissions?: Permission[] } = {};
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
    // G4.S3.T10: an admin grants/revokes extra permissions (e.g. kb.edit to a member).
    if (body.permissions !== undefined) {
      if (
        !Array.isArray(body.permissions) ||
        !body.permissions.every((p): p is string => typeof p === "string")
      ) {
        return reply.code(400).send({ error: "permissions must be an array of permission names" });
      }
      const unknown = (body.permissions as string[]).filter((p) => !ALL_PERMISSIONS.includes(p as Permission));
      if (unknown.length > 0) {
        return reply.code(400).send({
          error: `unknown permission${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
        });
      }
      patch.permissions = body.permissions as Permission[];
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

  app.get("/api/employees/:id/agents", async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (typeof id !== "string" || id.trim().length === 0) {
      return reply.code(400).send({ error: "employee id is required" });
    }
    try {
      const employee = await requireEmployee(request, reply, "agent.list");
      if (!employee) {
        return;
      }
      const owner = await employees.getById(id.trim());
      if (!owner) {
        return reply.code(404).send({ error: `employee "${id.trim()}" not found` });
      }
      const agentRecords = await agents.list({ ownerEmployeeId: owner.id });
      return { agents: agentRecords };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
