import type { FastifyInstance } from "fastify";
import type { AuthService } from "../employees/auth.js";
import type { BoardScanner } from "../kanban/scan.js";
import { currentEmployee } from "./helpers.js";

export interface KanbanRouteOptions {
  board: BoardScanner;
  auth: AuthService;
}

/**
 * Kanban docs-scan API (G3.S6.T6):
 * - GET /api/kanban → board constructed by scanning docs/kanban/*.md,
 *   consumed by the Workbench Kanban tab (G3.S4).
 */
export function registerKanbanRoutes(app: FastifyInstance, options: KanbanRouteOptions): void {
  const { board, auth } = options;

  app.get("/api/kanban", async (request, reply) => {
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    try {
      return await board.scan();
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
