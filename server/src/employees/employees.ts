import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SecretCipher } from "./crypto.js";

export const EMPLOYEE_ROLES = ["admin", "member"] as const;
export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

/** GitHub credential kinds accepted at registration: SSH key or API token. */
export const GITHUB_CREDENTIAL_TYPES = ["ssh", "token"] as const;
export type GithubCredentialType = (typeof GITHUB_CREDENTIAL_TYPES)[number];

export function isGithubCredentialType(value: unknown): value is GithubCredentialType {
  return (GITHUB_CREDENTIAL_TYPES as readonly unknown[]).includes(value);
}

/** A GitHub credential as provided by the employee (plaintext at the API boundary). */
export interface GithubCredential {
  type: GithubCredentialType;
  value: string;
}

/** Public presence info for a stored credential — never the secret itself. */
export interface GithubCredentialInfo {
  has_credential: boolean;
  type: GithubCredentialType;
}

export interface EmployeeRecord {
  id: string;
  email: string;
  display_name: string;
  logo_url: string;
  role: EmployeeRole;
  created_at: string;
  updated_at: string;
}

export interface EmployeeCreateInput {
  email: string;
  display_name?: string;
  logo_url?: string;
  role?: EmployeeRole;
  /** GitHub credential provided at registration; stored encrypted at rest. */
  github_credential?: GithubCredential;
}

export interface EmployeeUpdateInput {
  display_name?: string;
  logo_url?: string;
  role?: EmployeeRole;
}

export class EmployeeConflictError extends Error {}
export class EmployeeNotFoundError extends Error {}

export interface EmployeeRegistry {
  create(input: EmployeeCreateInput): Promise<EmployeeRecord>;
  getByEmail(email: string): Promise<EmployeeRecord | null>;
  getById(id: string): Promise<EmployeeRecord | null>;
  list(): Promise<EmployeeRecord[]>;
  updateByEmail(email: string, patch: EmployeeUpdateInput): Promise<EmployeeRecord>;
  /** Register/update the employee's GitHub credential; stored encrypted at rest. */
  registerGithubCredential(email: string, input: GithubCredential): Promise<GithubCredentialInfo>;
  /** Return the decrypted GitHub credential, or null when none is registered. */
  getGithubCredential(email: string): Promise<GithubCredential | null>;
  /** Ensure the employees table + seed the first admin (idempotent). */
  seed(): Promise<void>;
  close(): Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isEmployeeRole(value: unknown): value is EmployeeRole {
  return (EMPLOYEE_ROLES as readonly unknown[]).includes(value);
}

function toRecord(input: EmployeeCreateInput): EmployeeRecord {
  const timestamp = now();
  return {
    id: randomUUID(),
    email: normalizeEmail(input.email),
    display_name: input.display_name ?? "",
    logo_url: input.logo_url ?? "",
    role: input.role && isEmployeeRole(input.role) ? input.role : "member",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

/** In-memory employee registry — used by tests and as a dev fallback when DATABASE_URL is unset. */
export class MemoryEmployeeRegistry implements EmployeeRegistry {
  private readonly byId = new Map<string, EmployeeRecord>();
  private readonly byEmail = new Map<string, EmployeeRecord>();
  private readonly githubCredentials = new Map<string, { type: GithubCredentialType; enc: string }>();
  private readonly cipher: SecretCipher | undefined;

  constructor(initial: EmployeeCreateInput[] = [], options: { cipher?: SecretCipher } = {}) {
    this.cipher = options.cipher;
    for (const input of initial) {
      this.setRecord(input);
      if (input.github_credential) {
        this.setGithubCredential(input.email, input.github_credential);
      }
    }
  }

  private setRecord(input: EmployeeCreateInput): void {
    const record = toRecord(input);
    this.byId.set(record.id, record);
    this.byEmail.set(record.email, record);
  }

  private setGithubCredential(email: string, input: GithubCredential): void {
    if (!this.cipher) {
      throw new Error("a SecretCipher is required to store github credentials");
    }
    this.githubCredentials.set(normalizeEmail(email), {
      type: input.type,
      enc: this.cipher.encrypt(input.value),
    });
  }

  async create(input: EmployeeCreateInput): Promise<EmployeeRecord> {
    const email = normalizeEmail(input.email);
    if (this.byEmail.has(email)) {
      throw new EmployeeConflictError(`employee email "${email}" already registered`);
    }
    this.setRecord({ ...input, email });
    if (input.github_credential) {
      this.setGithubCredential(email, input.github_credential);
    }
    return this.byEmail.get(email)!;
  }

  async getByEmail(email: string): Promise<EmployeeRecord | null> {
    return this.byEmail.get(normalizeEmail(email)) ?? null;
  }

  async getById(id: string): Promise<EmployeeRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async list(): Promise<EmployeeRecord[]> {
    return [...this.byEmail.values()];
  }

  async updateByEmail(email: string, patch: EmployeeUpdateInput): Promise<EmployeeRecord> {
    const existing = this.byEmail.get(normalizeEmail(email));
    if (!existing) {
      throw new EmployeeNotFoundError(`employee "${email}" not found`);
    }
    const updated: EmployeeRecord = {
      ...existing,
      display_name: patch.display_name ?? existing.display_name,
      logo_url: patch.logo_url ?? existing.logo_url,
      role: patch.role ?? existing.role,
      updated_at: now(),
    };
    this.byId.set(updated.id, updated);
    this.byEmail.set(updated.email, updated);
    return updated;
  }

  async registerGithubCredential(email: string, input: GithubCredential): Promise<GithubCredentialInfo> {
    const normalized = normalizeEmail(email);
    if (!this.byEmail.has(normalized)) {
      throw new EmployeeNotFoundError(`employee "${email}" not found`);
    }
    this.setGithubCredential(normalized, input);
    return { has_credential: true, type: input.type };
  }

  async getGithubCredential(email: string): Promise<GithubCredential | null> {
    const stored = this.githubCredentials.get(normalizeEmail(email));
    if (!stored || !this.cipher) {
      return null;
    }
    return { type: stored.type, value: this.cipher.decrypt(stored.enc) };
  }

  async seed(): Promise<void> {
    // no-op for the in-memory registry; initial employees are passed to the constructor
  }

  async close(): Promise<void> {
    this.byId.clear();
    this.byEmail.clear();
    this.githubCredentials.clear();
  }
}

export interface PostgresEmployeeRegistryOptions {
  connectionString?: string;
  pool?: pg.Pool;
  /** Cipher used to encrypt/decrypt github credentials at rest. */
  cipher?: SecretCipher;
}

interface EmployeeRow {
  id: string;
  email: string;
  display_name: string;
  logo_url: string;
  role: EmployeeRole;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToRecord(row: EmployeeRow): EmployeeRecord {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    logo_url: row.logo_url,
    role: row.role,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

/**
 * Postgres-backed employee registry: lazy CREATE TABLE + admin seed on first use.
 * The first admin email comes from ADMIN_EMAIL (or S2_TICKET_ADMIN_EMAIL) env.
 */
export class PostgresEmployeeRegistry implements EmployeeRegistry {
  private readonly pool: pg.Pool;
  private readonly cipher: SecretCipher | undefined;
  private ready: Promise<void> | null = null;

  constructor(options: PostgresEmployeeRegistryOptions = {}) {
    this.pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString });
    this.cipher = options.cipher;
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.init();
    }
    return this.ready;
  }

  private async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        logo_url TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        github_credential_type TEXT,
        github_credential_enc TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `ALTER TABLE employees ADD COLUMN IF NOT EXISTS github_credential_type TEXT`,
    );
    await this.pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS github_credential_enc TEXT`);
  }

  /** Eagerly ensure table + seed the first admin when ADMIN_EMAIL is set. Idempotent. */
  async seed(): Promise<void> {
    await this.ensureReady();
    const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    if (!adminEmail) {
      return;
    }
    const existing = await this.pool.query(`SELECT 1 FROM employees WHERE email = $1`, [adminEmail]);
    if (existing.rows.length === 0) {
      await this.pool.query(
        `INSERT INTO employees (id, email, display_name, logo_url, role)
         VALUES ($1, $2, $3, $4, 'admin')`,
        [randomUUID(), adminEmail, adminEmail, ""],
      );
    }
  }

  async create(input: EmployeeCreateInput): Promise<EmployeeRecord> {
    await this.ensureReady();
    const encrypted = input.github_credential
      ? this.encryptGithubCredential(input.github_credential)
      : null;
    try {
      const result = await this.pool.query<EmployeeRow>(
        `INSERT INTO employees (id, email, display_name, logo_url, role, github_credential_type, github_credential_enc)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          randomUUID(),
          normalizeEmail(input.email),
          input.display_name ?? "",
          input.logo_url ?? "",
          input.role ?? "member",
          encrypted?.type ?? null,
          encrypted?.enc ?? null,
        ],
      );
      return rowToRecord(result.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new EmployeeConflictError(
          `employee email "${normalizeEmail(input.email)}" already registered`,
        );
      }
      throw err;
    }
  }

  private encryptGithubCredential(input: GithubCredential): { type: GithubCredentialType; enc: string } {
    if (!this.cipher) {
      throw new Error("a SecretCipher is required to store github credentials");
    }
    return { type: input.type, enc: this.cipher.encrypt(input.value) };
  }

  async getByEmail(email: string): Promise<EmployeeRecord | null> {
    await this.ensureReady();
    const result = await this.pool.query<EmployeeRow>(
      `SELECT * FROM employees WHERE email = $1`,
      [normalizeEmail(email)],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async getById(id: string): Promise<EmployeeRecord | null> {
    await this.ensureReady();
    const result = await this.pool.query<EmployeeRow>(`SELECT * FROM employees WHERE id = $1`, [id]);
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async list(): Promise<EmployeeRecord[]> {
    await this.ensureReady();
    const result = await this.pool.query<EmployeeRow>(
      `SELECT * FROM employees ORDER BY created_at`,
    );
    return result.rows.map(rowToRecord);
  }

  async updateByEmail(email: string, patch: EmployeeUpdateInput): Promise<EmployeeRecord> {
    await this.ensureReady();
    const result = await this.pool.query<EmployeeRow>(
      `UPDATE employees
       SET display_name = COALESCE($2, display_name),
           logo_url = COALESCE($3, logo_url),
           role = COALESCE($4, role),
           updated_at = now()
       WHERE email = $1
       RETURNING *`,
      [normalizeEmail(email), patch.display_name ?? null, patch.logo_url ?? null, patch.role ?? null],
    );
    if (result.rows.length === 0) {
      throw new EmployeeNotFoundError(`employee "${email}" not found`);
    }
    return rowToRecord(result.rows[0]);
  }

  async registerGithubCredential(email: string, input: GithubCredential): Promise<GithubCredentialInfo> {
    await this.ensureReady();
    const encrypted = this.encryptGithubCredential(input);
    const result = await this.pool.query(
      `UPDATE employees
       SET github_credential_type = $2, github_credential_enc = $3, updated_at = now()
       WHERE email = $1
       RETURNING id`,
      [normalizeEmail(email), encrypted.type, encrypted.enc],
    );
    if (result.rows.length === 0) {
      throw new EmployeeNotFoundError(`employee "${email}" not found`);
    }
    return { has_credential: true, type: input.type };
  }

  async getGithubCredential(email: string): Promise<GithubCredential | null> {
    await this.ensureReady();
    if (!this.cipher) {
      return null;
    }
    const result = await this.pool.query<{
      github_credential_type: GithubCredentialType;
      github_credential_enc: string | null;
    }>(
      `SELECT github_credential_type, github_credential_enc FROM employees WHERE email = $1`,
      [normalizeEmail(email)],
    );
    const row = result.rows[0];
    if (!row?.github_credential_enc) {
      return null;
    }
    return { type: row.github_credential_type, value: this.cipher.decrypt(row.github_credential_enc) };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
