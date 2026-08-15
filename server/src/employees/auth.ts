import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type { EmployeeRecord, EmployeeRegistry } from "./employees.js";
import { hashPassword, verifyPassword } from "./password.js";

/** Delivers magic-link login emails. */
export interface MagicLinkMailer {
  sendLoginLink(input: { to: string; magicLinkUrl: string }): Promise<void>;
}

/**
 * Stores one-time login tokens and long-lived session tokens.
 * Raw tokens are handed to the client; only their SHA-256 hash is persisted.
 */
export interface AuthTokenStore {
  createLoginToken(employeeId: string, ttlMs?: number): Promise<string>;
  /** Consume a one-time login token → employeeId, or null when invalid/expired/used. */
  consumeLoginToken(token: string): Promise<string | null>;
  createSessionToken(employeeId: string): Promise<string>;
  /** Resolve a session token → employeeId, or null when unknown. */
  resolveSessionToken(token: string): Promise<string | null>;
  close(): Promise<void>;
}

export interface MagicLinkAuthServiceOptions {
  registry: EmployeeRegistry;
  mailer: MagicLinkMailer;
  tokens: AuthTokenStore;
  /** Base URL of the frontend used to build the verify link. Default: http://localhost:5173 */
  appBaseUrl?: string;
  /** Login-token time-to-live in ms. Default: 15 minutes. */
  loginTtlMs?: number;
}

export interface LoginVerification {
  session_token: string;
  employee: EmployeeRecord;
}

/**
 * Result of an email+password sign-in attempt (G4.S7.T6):
 * - "authenticated": the password matched — the caller returns the session directly.
 * - "invalid-credentials": the employee HAS a password but it didn't match (reject).
 * - "no-password": no password is set (or the email is unknown) — fall back to magic link.
 */
export type PasswordLoginResult =
  | { kind: "authenticated"; session_token: string; employee: EmployeeRecord }
  | { kind: "invalid-credentials" }
  | { kind: "no-password" };

/** Email magic-link login + session resolution (G3.S2), plus email+password (G4.S7.T6). */
export interface AuthService {
  /** Email a magic link to the employee when they exist; always answers { ok: true }. */
  requestLogin(email: string): Promise<{ ok: boolean }>;
  /** Sign in with email+password (bcrypt). See PasswordLoginResult. */
  loginWithPassword(email: string, password: string): Promise<PasswordLoginResult>;
  /** Set/replace the employee's password (stored as a bcrypt hash). */
  setPassword(email: string, password: string): Promise<void>;
  /** Exchange a one-time login token for a session token + employee. Returns null when invalid. */
  verifyLogin(token: string): Promise<LoginVerification | null>;
  /** Resolve the employee behind a session token, or null. */
  getEmployeeForSession(sessionToken: string): Promise<EmployeeRecord | null>;
  close(): Promise<void>;
}

/** Email magic-link login (G3.S2). Never leaks whether an email is registered. */
export class MagicLinkAuthService implements AuthService {
  private readonly registry: EmployeeRegistry;
  private readonly mailer: MagicLinkMailer;
  private readonly tokens: AuthTokenStore;
  private readonly appBaseUrl: string;
  private readonly loginTtlMs: number;

  constructor(options: MagicLinkAuthServiceOptions) {
    this.registry = options.registry;
    this.mailer = options.mailer;
    this.tokens = options.tokens;
    this.appBaseUrl = options.appBaseUrl ?? "http://localhost:5173";
    this.loginTtlMs = options.loginTtlMs ?? 15 * 60 * 1000;
  }

  /** Email a magic link to the employee when they exist; always answers { ok: true }. */
  async requestLogin(email: string): Promise<{ ok: boolean }> {
    const employee = await this.registry.getByEmail(email.trim().toLowerCase());
    if (!employee) {
      return { ok: true };
    }
    const token = await this.tokens.createLoginToken(employee.id, this.loginTtlMs);
    const magicLinkUrl = `${this.appBaseUrl.replace(/\/+$/, "")}/auth/verify?token=${encodeURIComponent(token)}`;
    await this.mailer.sendLoginLink({ to: employee.email, magicLinkUrl });
    return { ok: true };
  }

  /**
   * Email+password sign-in (G4.S7.T6). Unknown emails and employees without a
   * password both report "no-password" (no existence leak); a stored-but-wrong
   * password reports "invalid-credentials". Never emails a magic link here.
   */
  async loginWithPassword(email: string, password: string): Promise<PasswordLoginResult> {
    const employee = await this.registry.getByEmail(email.trim().toLowerCase());
    if (!employee) {
      return { kind: "no-password" };
    }
    const hash = await this.registry.getPasswordHash(employee.email);
    if (!hash) {
      return { kind: "no-password" };
    }
    if (!(await verifyPassword(password, hash))) {
      return { kind: "invalid-credentials" };
    }
    const session_token = await this.tokens.createSessionToken(employee.id);
    return { kind: "authenticated", session_token, employee };
  }

  /** Set/replace the employee's password; only the bcrypt hash is ever stored. */
  async setPassword(email: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    await this.registry.setPassword(email.trim().toLowerCase(), hash);
  }

  /** Exchange a one-time login token for a session token + employee. Returns null when invalid. */
  async verifyLogin(token: string): Promise<LoginVerification | null> {
    const employeeId = await this.tokens.consumeLoginToken(token);
    if (!employeeId) {
      return null;
    }
    const employee = await this.registry.getById(employeeId);
    if (!employee) {
      return null;
    }
    const session_token = await this.tokens.createSessionToken(employee.id);
    return { session_token, employee };
  }

  /** Resolve the employee behind a session token, or null. */
  async getEmployeeForSession(sessionToken: string): Promise<EmployeeRecord | null> {
    const employeeId = await this.tokens.resolveSessionToken(sessionToken);
    if (!employeeId) {
      return null;
    }
    return this.registry.getById(employeeId);
  }

  async close(): Promise<void> {
    await this.tokens.close();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

/** In-memory token store — used by tests and as a dev fallback when DATABASE_URL is unset. */
export class MemoryAuthTokenStore implements AuthTokenStore {
  private readonly loginTokens = new Map<string, { employeeId: string; expiresAt: number }>();
  private readonly sessions = new Map<string, { employeeId: string }>();

  async createLoginToken(employeeId: string, ttlMs = 15 * 60 * 1000): Promise<string> {
    const token = randomToken();
    this.loginTokens.set(hashToken(token), { employeeId, expiresAt: Date.now() + ttlMs });
    return token;
  }

  async consumeLoginToken(token: string): Promise<string | null> {
    const entry = this.loginTokens.get(hashToken(token));
    if (!entry) {
      return null;
    }
    this.loginTokens.delete(hashToken(token));
    if (Date.now() > entry.expiresAt) {
      return null;
    }
    return entry.employeeId;
  }

  async createSessionToken(employeeId: string): Promise<string> {
    const token = randomToken();
    this.sessions.set(hashToken(token), { employeeId });
    return token;
  }

  async resolveSessionToken(token: string): Promise<string | null> {
    return this.sessions.get(hashToken(token))?.employeeId ?? null;
  }

  async close(): Promise<void> {
    this.loginTokens.clear();
    this.sessions.clear();
  }
}

interface LoginTokenRow {
  employee_id: string;
}

interface SessionTokenRow {
  employee_id: string;
}

/** Postgres-backed token store: auth_login_tokens + auth_sessions, lazy CREATE TABLE. */
export class PostgresAuthTokenStore implements AuthTokenStore {
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
      CREATE TABLE IF NOT EXISTS auth_login_tokens (
        token_hash TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async createLoginToken(employeeId: string, ttlMs = 15 * 60 * 1000): Promise<string> {
    await this.ensureReady();
    const token = randomToken();
    await this.pool.query(
      `INSERT INTO auth_login_tokens (token_hash, employee_id, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 millisecond'))`,
      [hashToken(token), employeeId, ttlMs],
    );
    return token;
  }

  async consumeLoginToken(token: string): Promise<string | null> {
    await this.ensureReady();
    const result = await this.pool.query<LoginTokenRow>(
      `DELETE FROM auth_login_tokens
       WHERE token_hash = $1 AND expires_at > now()
       RETURNING employee_id`,
      [hashToken(token)],
    );
    return result.rows[0]?.employee_id ?? null;
  }

  async createSessionToken(employeeId: string): Promise<string> {
    await this.ensureReady();
    const token = randomToken();
    await this.pool.query(
      `INSERT INTO auth_sessions (token_hash, employee_id) VALUES ($1, $2)`,
      [hashToken(token), employeeId],
    );
    return token;
  }

  async resolveSessionToken(token: string): Promise<string | null> {
    await this.ensureReady();
    const result = await this.pool.query<SessionTokenRow>(
      `SELECT employee_id FROM auth_sessions WHERE token_hash = $1`,
      [hashToken(token)],
    );
    return result.rows[0]?.employee_id ?? null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface ResendMailerOptions {
  apiKey?: string;
  from?: string;
  /** Resend API base. Default: https://api.resend.com */
  baseUrl?: string;
  /** Injectable fetch implementation for unit tests. */
  fetchImpl?: typeof fetch;
}

/** Sends magic-link emails through the Resend REST API. */
export class ResendMailer implements MagicLinkMailer {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendMailerOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.RESEND_API_KEY ?? "";
    this.from = options.from ?? process.env.RESEND_FROM ?? "Athena <noreply@caleo.com>";
    this.baseUrl = (options.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendLoginLink(input: { to: string; magicLinkUrl: string }): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject: "Your Athena sign-in link",
        html: `<p>Sign in to Athena with this magic link:</p>
<p><a href="${input.magicLinkUrl}">${input.magicLinkUrl}</a></p>
<p>This link expires in 15 minutes.</p>`,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Resend API error ${response.status}: ${detail}`);
    }
  }
}

/** Dev-mode mailer: logs the magic link to the server console when no RESEND_API_KEY is set. */
export class ConsoleMailer implements MagicLinkMailer {
  async sendLoginLink(input: { to: string; magicLinkUrl: string }): Promise<void> {
    console.log(`[magic-link] login for ${input.to}: ${input.magicLinkUrl}`);
  }
}
