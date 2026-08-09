import type { FastifyInstance } from "fastify";
import type { AuthService } from "../employees/auth.js";
import type { EmployeeRegistry } from "../employees/employees.js";
import type { RemoteBoardSource } from "../kanban/scan.js";
import { scanRemoteBoard } from "../kanban/scan.js";
import { toIndex, type KanbanIndexService } from "../kanban/index-file.js";
import { GithubAuthError } from "../github/client.js";
import { currentEmployee } from "./helpers.js";

export interface KanbanRouteOptions {
  /** Root index service: fast `read()` + explicit `rescan()` (rebuild + rewrite). */
  index: KanbanIndexService;
  auth: AuthService;
  employees: EmployeeRegistry;
  github: RemoteBoardSource;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function truthy(value: unknown): boolean {
  return ["1", "true", true].includes(value as string | boolean);
}

/**
 * Kanban board API (G3.S6.T6 + G3.S4.T5 + G3.S4.T7):
 * - GET /api/kanban → the board served from the root index file `kanban-index.json`
 *   (fast — no per-refresh recursive scan of docs/kanban/*.md).
 * - GET /api/kanban?rescan=1 → forces a rescan and rebuilds the index file (fallback).
 * - GET /api/kanban?repo=owner/repo → the SELECTED repo's board, read via the
 *   signed-in employee's GitHub credential (converted to the same index shape).
 */
export function registerKanbanRoutes(app: FastifyInstance, options: KanbanRouteOptions): void {
  const { index, auth, employees, github } = options;

  app.get("/api/kanban", async (request, reply) => {
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const query = request.query as { repo?: unknown; rescan?: unknown };
    const repoParam = optionalString(query.repo);
    const rescan = truthy(query.rescan);
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
        const board = await scanRemoteBoard(github, credential, owner, repo, undefined, { includeBody: true });
        return toIndex(board);
      }
      return rescan ? await index.rescan() : await index.read();
    } catch (err) {
      if (err instanceof GithubAuthError) {
        return reply.code(401).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
