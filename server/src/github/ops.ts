import { randomUUID } from "node:crypto";

/** Kinds of GitHub mutation ops that require an explicit confirm step (G3.S6.T5). */
export const GITHUB_OP_KINDS = ["open_pull", "edit_file", "merge_pull"] as const;
export type GithubOpKind = (typeof GITHUB_OP_KINDS)[number];

/** A mutation op awaiting the owning employee's confirmation. */
export interface PendingGithubOp {
  id: string;
  employee_email: string;
  kind: GithubOpKind;
  /** Validated parameters for the mutation, executed verbatim on confirm. */
  input: Record<string, unknown>;
  /** Human-readable description shown to the employee before confirming. */
  summary: string;
  created_at: string;
  expires_at: string;
}

export class GithubOpNotFoundError extends Error {}
export class GithubOpExpiredError extends Error {}

export interface GithubOpStore {
  create(op: Omit<PendingGithubOp, "id" | "created_at" | "expires_at">): Promise<PendingGithubOp>;
  /** Return the pending op, or null when unknown. Throws GithubOpExpiredError for expired ops. */
  get(id: string): Promise<PendingGithubOp | null>;
  delete(id: string): Promise<void>;
}

export interface GithubOpStoreOptions {
  /** Pending-op time-to-live in milliseconds. Default: 30 minutes. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * In-memory pending-op store used by the confirm flow (and tests). Ops expire
 * after ttlMs so an unconfirmed mutation is never executed late.
 */
export class MemoryGithubOpStore implements GithubOpStore {
  private readonly ops = new Map<string, PendingGithubOp>();
  private readonly ttlMs: number;

  constructor(options: GithubOpStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async create(op: Omit<PendingGithubOp, "id" | "created_at" | "expires_at">): Promise<PendingGithubOp> {
    const now = Date.now();
    const stored: PendingGithubOp = {
      id: randomUUID(),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.ttlMs).toISOString(),
      ...op,
    };
    this.ops.set(stored.id, stored);
    return stored;
  }

  async get(id: string): Promise<PendingGithubOp | null> {
    const op = this.ops.get(id);
    if (!op) {
      return null;
    }
    if (Date.parse(op.expires_at) < Date.now()) {
      this.ops.delete(id);
      throw new GithubOpExpiredError(`op "${id}" expired`);
    }
    return op;
  }

  async delete(id: string): Promise<void> {
    this.ops.delete(id);
  }
}
