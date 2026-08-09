import type { FastifyInstance } from "fastify";
import type { AuthService } from "../employees/auth.js";
import type { EmployeeRegistry } from "../employees/employees.js";
import type { BoardScanner, RemoteBoardSource } from "../kanban/scan.js";
import { scanRemoteBoard } from "../kanban/scan.js";
import { GithubAuthError } from "../github/client.js";
import { currentEmployee } from "./helpers.js";

export interface KanbanRouteOptions {
  board: BoardScanner;
  auth: AuthService;
  employees: EmployeeRegistry;
  github: RemoteBoardSource;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Kanban docs-scan API (G3.S6.T6 + G3.S4.T5):
 * - GET /api/kanban → board constructed by scanning the local repo's docs/kanban/*.md
 * - GET /api/kanban?repo=owner/repo → the SELECTED repo's docs/kanban board, read via
 *   the signed-in employee's GitHub credential (live status/assignee/session_id).
 */
export function registerKanbanRoutes(app: FastifyInstance, options: KanbanRouteOptions): void {
  const { board, auth, employees, github } = options;

  app.get("/api/kanban", async (request, reply) => {
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const repoParam = optionalString((request.query as { repo?: unknown }).repo);
    try {
      if (repoParam) {
        const parts = repoParam.split("/");
        const owner = parts[0] ?? "";
        const repo = parts[1] ?? "";
        if (parts.length !== 2 || !owner || !repo) {
          return reply.code(400).send({ error: "repo must be in owner/repo form" });
        }
        const credential = await employees.getGithubCredential(employee.email);
        if (!credential) {
          return reply.code(400).send({ error: "no github credential registered" });
        }
        return await scanRemoteBoard(github, credential, owner, repo);
      }
      return await board.scan();
    } catch (err) {
      if (err instanceof GithubAuthError) {
        return reply.code(401).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
