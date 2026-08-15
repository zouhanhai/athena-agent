import type { FastifyInstance } from "fastify";
import type { AuthService } from "../employees/auth.js";
import {
  EmployeeConflictError,
  isGithubCredentialType,
  type GithubCredential,
} from "../employees/employees.js";
import {
  InvitationConflictError,
  InvitationInvalidError,
  type InvitationService,
} from "../employees/invitations.js";
import { roleHasPermission } from "../employees/rbac.js";
import { MIN_PASSWORD_LENGTH } from "../employees/password.js";
import { currentEmployee } from "./helpers.js";

export interface InvitationRouteOptions {
  invitations: InvitationService;
  auth: AuthService;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invalidString(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/** Validate an optional github_credential body; returns the input or a 400 reply. */
function githubCredentialFromBody(
  value: unknown,
  reply: { code: (code: number) => { send: (payload: unknown) => unknown } },
): GithubCredential | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object") {
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

/**
 * Invitation-based employee registration (G3.S2.T4):
 * - POST /api/invitations { email } (admin RBAC employees.invite) → send invite
 * - GET /api/invitations/resolve?token=TOKEN (public) → { email } | 401
 * - POST /api/invitations/register { token, display_name?, logo_url?, github_credential? }
 *   → { session_token, employee } | 401 | 409 | 400
 */
export function registerInvitationRoutes(app: FastifyInstance, options: InvitationRouteOptions): void {
  const { invitations, auth } = options;

  app.post("/api/invitations", async (request, reply) => {
    const body = (request.body ?? {}) as { email?: unknown };
    if (invalidString(body.email) || !EMAIL_RE.test((body.email as string).trim())) {
      return reply.code(400).send({ error: "a valid email is required" });
    }
    try {
      const employee = await currentEmployee(request, auth);
      if (!employee) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      if (!roleHasPermission(employee.role, "employees.invite")) {
        return reply.code(403).send({ error: 'forbidden: requires permission "employees.invite"' });
      }
      const result = await invitations.invite((body.email as string).trim());
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof InvitationConflictError) {
        return reply.code(409).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/invitations/resolve", async (request, reply) => {
    const { token } = request.query as { token?: unknown };
    if (invalidString(token)) {
      return reply.code(400).send({ error: "token is required" });
    }
    try {
      const resolution = await invitations.resolveInvitation((token as string).trim());
      if (!resolution) {
        return reply.code(401).send({ error: "invitation token is invalid or expired" });
      }
      return resolution;
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/invitations/register", async (request, reply) => {
    const body = (request.body ?? {}) as {
      token?: unknown;
      display_name?: unknown;
      logo_url?: unknown;
      github_credential?: unknown;
      password?: unknown;
    };
    if (invalidString(body.token)) {
      return reply.code(400).send({ error: "token is required" });
    }
    if (body.display_name !== undefined && typeof body.display_name !== "string") {
      return reply.code(400).send({ error: "display_name must be a string" });
    }
    if (body.logo_url !== undefined && typeof body.logo_url !== "string") {
      return reply.code(400).send({ error: "logo_url must be a string" });
    }
    if (body.password !== undefined) {
      if (typeof body.password !== "string") {
        return reply.code(400).send({ error: "password must be a string" });
      }
      if (body.password.length < MIN_PASSWORD_LENGTH) {
        return reply.code(400).send({
          error: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
        });
      }
    }
    const githubCredential = githubCredentialFromBody(body.github_credential, reply);
    if (githubCredential === null) {
      return;
    }
    try {
      const { session_token, employee } = await invitations.registerInvitedEmployee(
        (body.token as string).trim(),
        {
          display_name: typeof body.display_name === "string" ? body.display_name : undefined,
          logo_url: typeof body.logo_url === "string" ? body.logo_url : undefined,
          github_credential: githubCredential,
          password: typeof body.password === "string" ? body.password : undefined,
        },
      );
      return reply.code(201).send({ session_token, employee });
    } catch (err) {
      if (err instanceof InvitationInvalidError) {
        return reply.code(401).send({ error: err.message });
      }
      if (err instanceof EmployeeConflictError) {
        return reply.code(409).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
