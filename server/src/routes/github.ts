import type { FastifyInstance } from "fastify";
import type { AuthService } from "../employees/auth.js";
import {
  EmployeeNotFoundError,
  GITHUB_CREDENTIAL_TYPES,
  type EmployeeRegistry,
  type GithubCredentialType,
} from "../employees/employees.js";
import {
  GithubAuthError,
  GithubCredentialUnsupportedError,
  type GitHubApi,
} from "../github/client.js";
import { currentEmployee } from "./helpers.js";

export interface GithubRouteOptions {
  employees: EmployeeRegistry;
  auth: AuthService;
  github: GitHubApi;
}

/**
 * Per-user GitHub credential + scoped repos (G3.S2.T2):
 * - POST /api/me/github-credential (Bearer) → register/update the signed-in user's credential
 * - GET /api/github/repos (Bearer) → repos visible to the signed-in user's credential only
 */
export function registerGithubRoutes(app: FastifyInstance, options: GithubRouteOptions): void {
  const { employees, auth, github } = options;

  app.post("/api/me/github-credential", async (request, reply) => {
    const body = (request.body ?? {}) as { type?: unknown; value?: unknown };
    if (typeof body.type !== "string" || !(GITHUB_CREDENTIAL_TYPES as readonly unknown[]).includes(body.type)) {
      return reply.code(400).send({ error: `type must be one of: ${GITHUB_CREDENTIAL_TYPES.join(", ")}` });
    }
    if (typeof body.value !== "string" || body.value.trim().length === 0) {
      return reply.code(400).send({ error: "value is required" });
    }
    try {
      const employee = await currentEmployee(request, auth);
      if (!employee) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const info = await employees.registerGithubCredential(employee.email, {
        type: body.type as GithubCredentialType,
        value: body.value.trim(),
      });
      return info;
    } catch (err) {
      if (err instanceof EmployeeNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/github/repos", async (request, reply) => {
    try {
      const employee = await currentEmployee(request, auth);
      if (!employee) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const credential = await employees.getGithubCredential(employee.email);
      if (!credential) {
        return reply.code(400).send({ error: "no github credential registered" });
      }
      const repos = await github.listRepos(credential);
      return { repos };
    } catch (err) {
      if (err instanceof GithubAuthError) {
        return reply.code(401).send({ error: err.message });
      }
      if (err instanceof GithubCredentialUnsupportedError) {
        return reply.code(400).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
