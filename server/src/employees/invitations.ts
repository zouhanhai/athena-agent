import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import type { AuthTokenStore } from "./auth.js";
import {
  EmployeeConflictError,
  type EmployeeRecord,
  type EmployeeRegistry,
  type GithubCredential,
} from "./employees.js";

/** Delivers invitation emails (G3.S2.T4). */
export interface InvitationMailer {
  sendInvitation(input: { to: string; inviteUrl: string }): Promise<void>;
}

/**
 * Stores pending invitations keyed by the SHA-256 hash of the invite token.
 * The raw token is handed to the client; only its hash is persisted.
 */
export interface InvitationStore {
  /** Create a pending invitation for an email; returns the raw invite token. */
  createInvitation(email: string, ttlMs?: number): Promise<string>;
  /** Resolve an invite token → the invited email, or null when invalid/expired. Non-consuming. */
  resolveInvitation(token: string): Promise<{ email: string } | null>;
  /** Consume a one-time invite token → the invited email, or null when invalid/expired/used. */
  consumeInvitation(token: string): Promise<string | null>;
  close(): Promise<void>;
}

export interface InvitedEmployeeRegistrationInput {
  display_name?: string;
  logo_url?: string;
  /** GitHub credential provided at registration; stored encrypted at rest. */
  github_credential?: GithubCredential;
}

export interface InvitationServiceOptions {
  registry: EmployeeRegistry;
  /** Shared token store — session tokens minted here resolve through the auth service. */
  tokens: AuthTokenStore;
  store: InvitationStore;
  mailer: InvitationMailer;
  /** Base URL of the frontend used to build the registration link. Default: http://localhost:5173 */
  appBaseUrl?: string;
  /** Invite-token time-to-live in ms. Default: 7 days (invitations outlive login links). */
  ttlMs?: number;
}

/** The invited email is already an employee, so no invitation is needed/sent. */
export class InvitationConflictError extends Error {}

/** The invite token is unknown, expired, or already consumed. */
export class InvitationInvalidError extends Error {}

/** Result of creating an invitation — includes the generated registration URL (G4.S3.T11). */
export interface InviteResult {
  ok: true;
  /** The registration link handed to the invitee; rendered copy-able in the Admin console. */
  inviteUrl: string;
  /** Invite-token time-to-live in ms (default 7 days). */
  expiresInMs: number;
}

/**
 * Invitation-based employee registration (G3.S2.T4): an admin invites an email
 * address; the invitation email carries a single-use magic-link token. Clicking
 * it opens the registration page (verifying ownership of the invited email),
 * where the employee completes their profile + GitHub credential and is
 * registered with a fresh session token (immediate login).
 */
export class InvitationService {
  private readonly registry: EmployeeRegistry;
  private readonly tokens: AuthTokenStore;
  private readonly store: InvitationStore;
  private readonly mailer: InvitationMailer;
  private readonly appBaseUrl: string;
  private readonly ttlMs: number;

  constructor(options: InvitationServiceOptions) {
    this.registry = options.registry;
    this.tokens = options.tokens;
    this.store = options.store;
    this.mailer = options.mailer;
    this.appBaseUrl = options.appBaseUrl ?? "http://localhost:5173";
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
  }

  /** Invite an email: create a pending invitation + email the registration link. */
  async invite(email: string): Promise<InviteResult> {
    const normalized = email.trim().toLowerCase();
    const existing = await this.registry.getByEmail(normalized);
    if (existing) {
      throw new InvitationConflictError(`email "${normalized}" is already an employee`);
    }
    const token = await this.store.createInvitation(normalized, this.ttlMs);
    const inviteUrl = `${this.appBaseUrl.replace(/\/+$/, "")}/register?token=${encodeURIComponent(token)}`;
    await this.mailer.sendInvitation({ to: normalized, inviteUrl });
    return { ok: true, inviteUrl, expiresInMs: this.ttlMs };
  }

  /** Resolve an invite token → the invited email (registration page uses this). */
  async resolveInvitation(token: string): Promise<{ email: string } | null> {
    return this.store.resolveInvitation(token);
  }

  /**
   * Complete registration for an invited employee: consume the token, create the
   * employee (role member) with the provided profile + encrypted GitHub
   * credential, then mint a session token so they are signed in immediately.
   */
  async registerInvitedEmployee(
    token: string,
    input: InvitedEmployeeRegistrationInput,
  ): Promise<{ session_token: string; employee: EmployeeRecord }> {
    const email = await this.store.consumeInvitation(token);
    if (!email) {
      throw new InvitationInvalidError("invitation token is invalid or expired");
    }
    const existing = await this.registry.getByEmail(email);
    if (existing) {
      throw new EmployeeConflictError(`employee email "${email}" already registered`);
    }
    const employee = await this.registry.create({
      email,
      display_name: input.display_name,
      logo_url: input.logo_url,
      role: "member",
      github_credential: input.github_credential,
    });
    const session_token = await this.tokens.createSessionToken(employee.id);
    return { session_token, employee };
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

/** In-memory invitation store — used by tests and as a dev fallback when DATABASE_URL is unset. */
export class MemoryInvitationStore implements InvitationStore {
  private readonly byHash = new Map<string, { email: string; expiresAt: number }>();

  async createInvitation(email: string, ttlMs = 7 * 24 * 60 * 60 * 1000): Promise<string> {
    const token = randomToken();
    this.byHash.set(hashToken(token), { email, expiresAt: Date.now() + ttlMs });
    return token;
  }

  async resolveInvitation(token: string): Promise<{ email: string } | null> {
    const entry = this.byHash.get(hashToken(token));
    if (!entry || Date.now() > entry.expiresAt) {
      return null;
    }
    return { email: entry.email };
  }

  async consumeInvitation(token: string): Promise<string | null> {
    const entry = this.byHash.get(hashToken(token));
    if (!entry) {
      return null;
    }
    this.byHash.delete(hashToken(token));
    if (Date.now() > entry.expiresAt) {
      return null;
    }
    return entry.email;
  }

  async close(): Promise<void> {
    this.byHash.clear();
  }
}

interface InvitationRow {
  email: string;
}

/** Postgres-backed invitation store: auth_invitations, lazy CREATE TABLE. */
export class PostgresInvitationStore implements InvitationStore {
  private readonly pool: pg.Pool;
  private ready: Promise<void> | null = null;

  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString });
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.init();
    }
    return this.ready;
  }

  private async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS auth_invitations (
        token_hash TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async createInvitation(email: string, ttlMs = 7 * 24 * 60 * 60 * 1000): Promise<string> {
    await this.ensureReady();
    const token = randomToken();
    await this.pool.query(
      `INSERT INTO auth_invitations (token_hash, email, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 millisecond'))`,
      [hashToken(token), email, ttlMs],
    );
    return token;
  }

  async resolveInvitation(token: string): Promise<{ email: string } | null> {
    await this.ensureReady();
    const result = await this.pool.query<InvitationRow>(
      `SELECT email FROM auth_invitations WHERE token_hash = $1 AND expires_at > now()`,
      [hashToken(token)],
    );
    return result.rows[0] ? { email: result.rows[0].email } : null;
  }

  async consumeInvitation(token: string): Promise<string | null> {
    await this.ensureReady();
    const result = await this.pool.query<InvitationRow>(
      `DELETE FROM auth_invitations
       WHERE token_hash = $1 AND expires_at > now()
       RETURNING email`,
      [hashToken(token)],
    );
    return result.rows[0]?.email ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface ResendInvitationMailerOptions {
  apiKey?: string;
  from?: string;
  /** Resend API base. Default: https://api.resend.com */
  baseUrl?: string;
  /** Injectable fetch implementation for unit tests. */
  fetchImpl?: typeof fetch;
}

/** Sends invitation emails through the Resend REST API. */
export class ResendInvitationMailer implements InvitationMailer {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendInvitationMailerOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.RESEND_API_KEY ?? "";
    this.from = options.from ?? process.env.RESEND_FROM ?? "Athena <noreply@caleo.com>";
    this.baseUrl = (options.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendInvitation(input: { to: string; inviteUrl: string }): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject: "You're invited to Athena",
        html: `<p>You've been invited to join the Athena agent portal.</p>
<p>Click the link below to verify your email and complete your registration:</p>
<p><a href="${input.inviteUrl}">${input.inviteUrl}</a></p>
<p>This invitation link expires after a limited time.</p>`,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Resend API error ${response.status}: ${detail}`);
    }
  }
}

/** Dev-mode mailer: logs the invite link to the server console when no RESEND_API_KEY is set. */
export class ConsoleInvitationMailer implements InvitationMailer {
  async sendInvitation(input: { to: string; inviteUrl: string }): Promise<void> {
    console.log(`[invite] for ${input.to}: ${input.inviteUrl}`);
  }
}
