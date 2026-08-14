import type { FastifyInstance } from "fastify";
import type { AuthService } from "../employees/auth.js";
import type { EmployeeRegistry } from "../employees/employees.js";
import { buildGithubProjectBoard } from "../kanban/github-sync.js";
import { GithubAuthError, type GitHubApi } from "../github/client.js";
import { currentEmployee } from "./helpers.js";

export interface KanbanRouteOptions {
  auth: AuthService;
  employees: EmployeeRegistry;
  /** The Project v2 read/write surface (GraphQL/REST via the employee's token). */
  github: Pick<
    GitHubApi,
    | "getRepoProjects"
    | "getProjectItems"
    | "getIssue"
    | "getIssueComments"
    | "listIssues"
    | "createIssueComment"
  >;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Kanban GitHub board API (G4.S5 + G4.S6.T4):
 * - GET /api/kanban/github-project?repo=owner/repo → the selected repo's SYNCED
 *   GitHub Project v2 board (G4.S5.T4): cards grouped into Status columns, each
 *   card linking to its GitHub issue for discussion. GraphQL-backed via the
 *   employee's token; 404 when the repo has no linked Project.
 * - GET /api/kanban/github-issue?repo=...&issueNumber=N → the GitHub issue itself
 *   (title, body, state, labels, assignees) for the detail panel (G4.S5.T16).
 * - GET /api/kanban/github-issue-comments?repo=...&issueNumber=N → the issue's
 *   comment thread (local detail panel discussion).
 * - POST /api/kanban/github-issue-comments → create a new comment on a GitHub
 *   issue via the employee's token (G4.S5.T8); returns the created comment.
 */
export function registerKanbanRoutes(app: FastifyInstance, options: KanbanRouteOptions): void {
  const { auth, employees, github } = options;

  app.get("/api/kanban/github-project", async (request, reply) => {
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const query = request.query as { repo?: unknown; project?: unknown };
    const repoParam = optionalString(query.repo);
    const projectParam = optionalString(query.project);
    if (!repoParam) {
      return reply.code(400).send({ error: "repo is required (owner/repo form)" });
    }
    const parts = repoParam.split("/");
    const owner = parts[0] ?? "";
    const repo = parts[1] ?? "";
    if (parts.length !== 2 || !owner || !repo) {
      return reply.code(400).send({ error: "repo must be in owner/repo form" });
    }
    try {
      const credential = await employees.getGithubCredential(employee.email);
      if (!credential) {
        return reply.code(400).send({ error: "no github credential registered" });
      }
      // G4.S5.T11/T12: resolve the Project via the repo's linked projectsV2
      // (repository{ projectsV2 }) — works for ANY repo-linked project regardless
      // of its title (title-guessing missed e.g. caleo.int.abaplorer → "Abaplorer
      // Project"). getRepoProjects returns only OPEN linked projects (T12).
      const projects = await github.getRepoProjects(credential, owner, repo);
      // T12: serve the project the user picked in the selector (by its id), or
      // the first open linked project when none is specified.
      const project = projectParam
        ? (projects.find((p) => p.id === projectParam) ?? null)
        : (projects[0] ?? null);
      if (!project) {
        return reply.code(404).send({ error: `no linked GitHub Project for ${owner}/${repo}` });
      }
      const items = await github.getProjectItems(credential, project.id);
      // Repo issues carry the ticket sub-issues' open/closed state, from which
      // each Spec card's segmented sub-task progress is computed (T6).
      const issues = await github.listIssues(credential, owner, repo, "all");
      return buildGithubProjectBoard(project, items, issues, (issueNumber) =>
        `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
      );
    } catch (err) {
      if (err instanceof GithubAuthError) {
        return reply.code(401).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // G4.S5.T12 — the open linked Projects list for the GitHub Project view's
  // selector (a repo can have several linked Projects; closed ones are hidden).
  app.get("/api/kanban/github-projects", async (request, reply) => {
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const query = request.query as { repo?: unknown };
    const repoParam = optionalString(query.repo);
    if (!repoParam) {
      return reply.code(400).send({ error: "repo is required (owner/repo form)" });
    }
    const parts = repoParam.split("/");
    const owner = parts[0] ?? "";
    const repo = parts[1] ?? "";
    if (parts.length !== 2 || !owner || !repo) {
      return reply.code(400).send({ error: "repo must be in owner/repo form" });
    }
    try {
      const credential = await employees.getGithubCredential(employee.email);
      if (!credential) {
        return reply.code(400).send({ error: "no github credential registered" });
      }
      const projects = await github.getRepoProjects(credential, owner, repo);
      return { projects };
    } catch (err) {
      if (err instanceof GithubAuthError) {
        return reply.code(401).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/kanban/github-issue", async (request, reply) => {
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const query = request.query as { repo?: unknown; issueNumber?: unknown };
    const repoParam = optionalString(query.repo);
    const issueNumber = Number(query.issueNumber);
    if (!repoParam) {
      return reply.code(400).send({ error: "repo is required (owner/repo form)" });
    }
    const parts = repoParam.split("/");
    const owner = parts[0] ?? "";
    const repo = parts[1] ?? "";
    if (parts.length !== 2 || !owner || !repo) {
      return reply.code(400).send({ error: "repo must be in owner/repo form" });
    }
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      return reply.code(400).send({ error: "issueNumber must be a positive integer" });
    }
    try {
      const credential = await employees.getGithubCredential(employee.email);
      if (!credential) {
        return reply.code(400).send({ error: "no github credential registered" });
      }
      const issue = await github.getIssue(credential, owner, repo, issueNumber);
      return { issue };
    } catch (err) {
      if (err instanceof GithubAuthError) {
        return reply.code(401).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/kanban/github-issue-comments", async (request, reply) => {
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const query = request.query as { repo?: unknown; issueNumber?: unknown };
    const repoParam = optionalString(query.repo);
    const issueNumber = Number(query.issueNumber);
    if (!repoParam) {
      return reply.code(400).send({ error: "repo is required (owner/repo form)" });
    }
    const parts = repoParam.split("/");
    const owner = parts[0] ?? "";
    const repo = parts[1] ?? "";
    if (parts.length !== 2 || !owner || !repo) {
      return reply.code(400).send({ error: "repo must be in owner/repo form" });
    }
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      return reply.code(400).send({ error: "issueNumber must be a positive integer" });
    }
    try {
      const credential = await employees.getGithubCredential(employee.email);
      if (!credential) {
        return reply.code(400).send({ error: "no github credential registered" });
      }
      const comments = await github.getIssueComments(credential, owner, repo, issueNumber);
      return { comments };
    } catch (err) {
      if (err instanceof GithubAuthError) {
        return reply.code(401).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/kanban/github-issue-comments", async (request, reply) => {
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = (request.body ?? {}) as { repo?: unknown; issueNumber?: unknown; body?: unknown };
    const repoParam = optionalString(body.repo);
    const issueNumber = Number(body.issueNumber);
    const commentBody = optionalString(body.body);
    if (!repoParam) {
      return reply.code(400).send({ error: "repo is required (owner/repo form)" });
    }
    const parts = repoParam.split("/");
    const owner = parts[0] ?? "";
    const repo = parts[1] ?? "";
    if (parts.length !== 2 || !owner || !repo) {
      return reply.code(400).send({ error: "repo must be in owner/repo form" });
    }
    if (!Number.isInteger(issueNumber) || issueNumber < 1) {
      return reply.code(400).send({ error: "issueNumber must be a positive integer" });
    }
    if (!commentBody) {
      return reply.code(400).send({ error: "body is required" });
    }
    try {
      const credential = await employees.getGithubCredential(employee.email);
      if (!credential) {
        return reply.code(400).send({ error: "no github credential registered" });
      }
      const comment = await github.createIssueComment(credential, owner, repo, issueNumber, commentBody);
      return { comment };
    } catch (err) {
      if (err instanceof GithubAuthError) {
        return reply.code(401).send({ error: err.message });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
