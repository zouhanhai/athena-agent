import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthService } from "../employees/auth.js";
import {
  EmployeeNotFoundError,
  GITHUB_CREDENTIAL_TYPES,
  type EmployeeRegistry,
  type GithubCredential,
  type GithubCredentialType,
} from "../employees/employees.js";
import {
  GithubAuthError,
  GithubCredentialUnsupportedError,
  type GitHubApi,
  type GithubIssueState,
  type UpdateIssueInput,
} from "../github/client.js";
import {
  GITHUB_OP_KINDS,
  GithubOpExpiredError,
  GithubOpNotFoundError,
  type GithubOpKind,
  type GithubOpStore,
  type PendingGithubOp,
} from "../github/ops.js";
import { currentEmployee } from "./helpers.js";

export interface GithubRouteOptions {
  employees: EmployeeRegistry;
  auth: AuthService;
  github: GitHubApi;
  ops: GithubOpStore;
}

/** Validate a non-empty string path/param; returns "" when invalid. */
function requiredString(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Issue state filter validation; returns the normalized state or null when invalid. */
function issueState(value: unknown): GithubIssueState | null {
  const s = optionalString(value);
  if (s === undefined) {
    return "open";
  }
  return s === "open" || s === "closed" || s === "all" ? s : null;
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Validate a positive integer path param (e.g. an issue/PR number). */
function numberParam(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return undefined;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

function mapGithubError(
  err: unknown,
  reply: { code: (code: number) => { send: (payload: unknown) => unknown } },
): void {
  if (err instanceof GithubAuthError) {
    reply.code(401).send({ error: err.message });
    return;
  }
  if (err instanceof GithubCredentialUnsupportedError) {
    reply.code(400).send({ error: err.message });
    return;
  }
  if (err instanceof GithubOpNotFoundError) {
    reply.code(404).send({ error: err.message });
    return;
  }
  if (err instanceof GithubOpExpiredError) {
    reply.code(410).send({ error: err.message });
    return;
  }
  reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
}

interface ValidatedOp {
  input: Record<string, unknown>;
  summary: string;
}

/** Validate a mutation body and build a review summary; returns null after sending a 400. */
function validateOpBody(
  body: Record<string, unknown>,
  reply: { code: (code: number) => { send: (payload: unknown) => unknown } },
): ValidatedOp | null {
  const kind = body.op as unknown;
  if (typeof kind !== "string" || !(GITHUB_OP_KINDS as readonly unknown[]).includes(kind)) {
    reply.code(400).send({ error: `op must be one of: ${GITHUB_OP_KINDS.join(", ")}` });
    return null;
  }
  const owner = requiredString(body.owner);
  const repo = requiredString(body.repo);
  if (!owner || !repo) {
    reply.code(400).send({ error: "owner and repo are required" });
    return null;
  }
  switch (kind as GithubOpKind) {
    case "open_pull": {
      const title = requiredString(body.title);
      const head = requiredString(body.head);
      const base = requiredString(body.base);
      if (!title || !head || !base) {
        reply.code(400).send({ error: "title, head and base are required for open_pull" });
        return null;
      }
      const input: Record<string, unknown> = { owner, repo, title, head, base };
      const bodyText = optionalString(body.body);
      if (bodyText !== undefined) {
        input.body = bodyText;
      }
      return { input, summary: `Open PR "${title}" ${head} → ${base} in ${owner}/${repo}` };
    }
    case "edit_file": {
      const path = requiredString(body.path);
      const message = requiredString(body.message);
      const content = requiredString(body.content);
      if (!path || !message || !content) {
        reply.code(400).send({ error: "path, message and content are required for edit_file" });
        return null;
      }
      const input: Record<string, unknown> = { owner, repo, path, message, content };
      const branch = optionalString(body.branch);
      if (branch !== undefined) {
        input.branch = branch;
      }
      const sha = optionalString(body.sha);
      if (sha !== undefined) {
        input.sha = sha;
      }
      const where = branch ? ` on ${branch}` : "";
      return { input, summary: `Edit ${owner}/${repo}:${path}${where} — "${message}"` };
    }
    case "merge_pull": {
      const number = optionalInt(body.number);
      if (number === undefined) {
        reply.code(400).send({ error: "number is required for merge_pull" });
        return null;
      }
      return { input: { owner, repo, number }, summary: `Merge PR #${number} in ${owner}/${repo}` };
    }
  }
}

/**
 * Per-user GitHub integration (G3.S2.T2 + G3.S6.T5):
 * - POST /api/me/github-credential (Bearer) → register/update the signed-in user's credential
 * - GET /api/github/repos (Bearer) → repos visible to the signed-in user's credential only
 * - Browse: GET /api/github/repos/:owner/:repo/tree|pulls|issues → scoped to the signed-in user's credential
 * - Ops (confirm flow): POST /api/github/ops stages a mutation; GET/confirm/cancel by op id.
 *   Mutations (open PR / edit file / merge PR) execute ONLY on POST /ops/:id/confirm.
 */
export function registerGithubRoutes(app: FastifyInstance, options: GithubRouteOptions): void {
  const { employees, auth, github, ops } = options;

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

  /** Resolve the signed-in employee's credential and run a browse call with it. */
  const withCredential = async (
    request: FastifyRequest,
    reply: { code: (code: number) => { send: (payload: unknown) => unknown } },
    run: (credential: GithubCredential) => Promise<unknown>,
  ): Promise<unknown> => {
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const credential = await employees.getGithubCredential(employee.email);
    if (!credential) {
      return reply.code(400).send({ error: "no github credential registered" });
    }
    try {
      return await run(credential);
    } catch (err) {
      mapGithubError(err, reply);
      return undefined;
    }
  };

  const repoParams = (request: { params: unknown }): { owner: string; repo: string } => {
    const params = request.params as { owner?: string; repo?: string };
    return { owner: requiredString(params.owner), repo: requiredString(params.repo) };
  };

  app.get("/api/github/repos", async (request, reply) =>
    withCredential(request, reply, async (credential) => {
      const repos = await github.listRepos(credential);
      return { repos };
    }),
  );

  app.get("/api/github/repos/:owner/:repo/tree", async (request, reply) => {
    const { owner, repo } = repoParams(request);
    if (!owner || !repo) {
      return reply.code(400).send({ error: "owner and repo are required" });
    }
    const ref = optionalString((request.query as { ref?: unknown }).ref);
    return withCredential(request, reply, async (credential) => {
      const tree = await github.listTree(credential, owner, repo, ref);
      return { tree };
    });
  });

  app.get("/api/github/repos/:owner/:repo/branches", async (request, reply) => {
    const { owner, repo } = repoParams(request);
    if (!owner || !repo) {
      return reply.code(400).send({ error: "owner and repo are required" });
    }
    return withCredential(request, reply, async (credential) => {
      const branches = await github.listBranches(credential, owner, repo);
      return { branches };
    });
  });

  app.get("/api/github/repos/:owner/:repo/content", async (request, reply) => {
    const { owner, repo } = repoParams(request);
    if (!owner || !repo) {
      return reply.code(400).send({ error: "owner and repo are required" });
    }
    const path = requiredString((request.query as { path?: unknown }).path);
    if (!path) {
      return reply.code(400).send({ error: "path is required" });
    }
    const ref = optionalString((request.query as { ref?: unknown }).ref);
    return withCredential(request, reply, async (credential) => {
      const file = await github.getFileContent(credential, owner, repo, path, ref);
      return file;
    });
  });

  app.get("/api/github/repos/:owner/:repo/pulls", async (request, reply) => {
    const { owner, repo } = repoParams(request);
    if (!owner || !repo) {
      return reply.code(400).send({ error: "owner and repo are required" });
    }
    return withCredential(request, reply, async (credential) => {
      const pulls = await github.listPulls(credential, owner, repo);
      return { pulls };
    });
  });

  app.get("/api/github/repos/:owner/:repo/issues", async (request, reply) => {
    const { owner, repo } = repoParams(request);
    if (!owner || !repo) {
      return reply.code(400).send({ error: "owner and repo are required" });
    }
    const state = issueState((request.query as { state?: unknown }).state);
    if (state === null) {
      return reply.code(400).send({ error: "state must be one of: open, closed, all" });
    }
    return withCredential(request, reply, async (credential) => {
      const issues = await github.listIssues(credential, owner, repo, state);
      return { issues };
    });
  });

  app.get("/api/github/repos/:owner/:repo/issues/:number", async (request, reply) => {
    const { owner, repo } = repoParams(request);
    const number = numberParam((request.params as { number?: unknown }).number);
    if (!owner || !repo || number === undefined) {
      return reply.code(400).send({ error: "owner, repo and a positive number are required" });
    }
    return withCredential(request, reply, async (credential) => {
      const issue = await github.getIssue(credential, owner, repo, number);
      const comments = await github.getIssueComments(credential, owner, repo, number);
      return { issue, comments };
    });
  });

  app.patch("/api/github/repos/:owner/:repo/issues/:number", async (request, reply) => {
    const { owner, repo } = repoParams(request);
    const number = numberParam((request.params as { number?: unknown }).number);
    if (!owner || !repo || number === undefined) {
      return reply.code(400).send({ error: "owner, repo and a positive number are required" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const input: UpdateIssueInput = {};
    if (body.title !== undefined) {
      if (typeof body.title !== "string") {
        return reply.code(400).send({ error: "title must be a string" });
      }
      input.title = body.title;
    }
    if (body.body !== undefined) {
      if (typeof body.body !== "string") {
        return reply.code(400).send({ error: "body must be a string" });
      }
      input.body = body.body;
    }
    if (body.state !== undefined) {
      if (body.state !== "open" && body.state !== "closed") {
        return reply.code(400).send({ error: "state must be one of: open, closed" });
      }
      input.state = body.state;
    }
    if (body.labels !== undefined) {
      if (!Array.isArray(body.labels) || body.labels.some((label) => typeof label !== "string")) {
        return reply.code(400).send({ error: "labels must be an array of strings" });
      }
      input.labels = body.labels;
    }
    if (Object.keys(input).length === 0) {
      return reply.code(400).send({ error: "nothing to update" });
    }
    return withCredential(request, reply, async (credential) => {
      const issue = await github.updateIssue(credential, owner, repo, number, input);
      return { issue };
    });
  });

  app.post("/api/github/repos/:owner/:repo/issues/:number/comments", async (request, reply) => {
    const { owner, repo } = repoParams(request);
    const number = numberParam((request.params as { number?: unknown }).number);
    if (!owner || !repo || number === undefined) {
      return reply.code(400).send({ error: "owner, repo and a positive number are required" });
    }
    const commentBody = requiredString((request.body as { body?: unknown } | null | undefined)?.body);
    if (!commentBody) {
      return reply.code(400).send({ error: "body is required" });
    }
    return withCredential(request, reply, async (credential) => {
      const comment = await github.createIssueComment(credential, owner, repo, number, commentBody);
      return reply.code(201).send({ comment });
    });
  });

  app.get("/api/github/repos/:owner/:repo/labels", async (request, reply) => {
    const { owner, repo } = repoParams(request);
    if (!owner || !repo) {
      return reply.code(400).send({ error: "owner and repo are required" });
    }
    return withCredential(request, reply, async (credential) => {
      const labels = await github.listLabels(credential, owner, repo);
      return { labels };
    });
  });

  app.get("/api/github/repos/:owner/:repo/commits", async (request, reply) => {
    const { owner, repo } = repoParams(request);
    if (!owner || !repo) {
      return reply.code(400).send({ error: "owner and repo are required" });
    }
    const ref = optionalString((request.query as { ref?: unknown }).ref);
    return withCredential(request, reply, async (credential) => {
      const commits = await github.listCommits(credential, owner, repo, { ref });
      return { commits };
    });
  });

  /** Load a pending op, verifying it belongs to the signed-in employee; returns null after sending a reply. */
  const ownedOp = async (
    request: FastifyRequest,
    reply: { code: (code: number) => { send: (payload: unknown) => unknown } },
  ): Promise<PendingGithubOp | null> => {
    const opId = requiredString((request.params as { op_id?: unknown }).op_id);
    if (!opId) {
      reply.code(400).send({ error: "op_id is required" });
      return null;
    }
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    let op: PendingGithubOp | null;
    try {
      op = await ops.get(opId);
    } catch (err) {
      mapGithubError(err, reply);
      return null;
    }
    if (!op) {
      reply.code(404).send({ error: `op "${opId}" not found` });
      return null;
    }
    if (op.employee_email !== employee.email) {
      reply.code(403).send({ error: "forbidden: op belongs to another employee" });
      return null;
    }
    return op;
  };

  app.post("/api/github/ops", async (request, reply) => {
    const employee = await currentEmployee(request, auth);
    if (!employee) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const validated = validateOpBody(body, reply);
    if (!validated) {
      return undefined;
    }
    const op = await ops.create({
      employee_email: employee.email,
      kind: body.op as GithubOpKind,
      input: validated.input,
      summary: validated.summary,
    });
    return reply.code(201).send({
      op_id: op.id,
      kind: op.kind,
      status: "pending",
      summary: op.summary,
      created_at: op.created_at,
      expires_at: op.expires_at,
    });
  });

  app.get("/api/github/ops/:op_id", async (request, reply) => {
    const op = await ownedOp(request, reply);
    if (!op) {
      return undefined;
    }
    return {
      op_id: op.id,
      kind: op.kind,
      status: "pending",
      summary: op.summary,
      input: op.input,
      created_at: op.created_at,
      expires_at: op.expires_at,
    };
  });

  app.post("/api/github/ops/:op_id/confirm", async (request, reply) => {
    const op = await ownedOp(request, reply);
    if (!op) {
      return undefined;
    }
    const employee = await currentEmployee(request, auth);
    const credential = employee ? await employees.getGithubCredential(employee.email) : null;
    if (!credential) {
      return reply.code(400).send({ error: "no github credential registered" });
    }
    const input = op.input as Record<string, string | number>;
    try {
      let result: unknown;
      switch (op.kind) {
        case "open_pull": {
          const params: { title: string; head: string; base: string; body?: string } = {
            title: String(input.title),
            head: String(input.head),
            base: String(input.base),
          };
          if (typeof input.body === "string") {
            params.body = input.body;
          }
          result = await github.openPull(credential, String(input.owner), String(input.repo), params);
          break;
        }
        case "edit_file": {
          const params: { message: string; content: string; branch?: string; sha?: string } = {
            message: String(input.message),
            content: String(input.content),
          };
          if (typeof input.branch === "string") {
            params.branch = input.branch;
          }
          if (typeof input.sha === "string") {
            params.sha = input.sha;
          }
          result = await github.editFile(credential, String(input.owner), String(input.repo), String(input.path), params);
          break;
        }
        case "merge_pull":
          result = await github.mergePull(credential, String(input.owner), String(input.repo), Number(input.number));
          break;
      }
      await ops.delete(op.id);
      return { op_id: op.id, kind: op.kind, status: "executed", result };
    } catch (err) {
      mapGithubError(err, reply);
      return undefined;
    }
  });

  app.delete("/api/github/ops/:op_id", async (request, reply) => {
    const op = await ownedOp(request, reply);
    if (!op) {
      return undefined;
    }
    await ops.delete(op.id);
    return { cancelled: true };
  });
}
