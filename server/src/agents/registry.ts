import { randomUUID } from "node:crypto";
import pg from "pg";

export interface AgentCapabilities {
  system: string;
  mcp: string[];
  tools: string[];
  skills: string[];
  specialty: string;
  description?: string;
}

export interface AgentRecord {
  id: string;
  alias: string;
  owner_employee_id: string;
  logo_url: string;
  capabilities: AgentCapabilities;
  runtime: string;
  created_at: string;
  updated_at: string;
}

export interface AgentCreateInput {
  alias: string;
  owner_employee_id: string;
  logo_url?: string;
  capabilities: AgentCapabilities;
  runtime?: string;
}

export interface AgentUpdateInput {
  logo_url?: string;
  capabilities?: AgentCapabilities;
}

/**
 * A self-declared but not yet registered agent (G3.S1.T4). The agent auto-fills
 * its own capabilities + runtime; alias/logo/owner are chosen later by the
 * employee during registration.
 */
export interface PendingAgentDeclaration {
  id: string;
  /** The agent's own identity (auto-filled, e.g. "opencode-ses_xyz"). */
  agent_id: string;
  capabilities: AgentCapabilities;
  runtime: string;
  declared_at: string;
}

export interface AgentDeclarationInput {
  agent_id: string;
  capabilities: AgentCapabilities;
  runtime?: string;
}

/** Employee-provided fields that finalize a pending declaration into a registered agent. */
export interface AgentConfirmInput {
  alias: string;
  owner_employee_id: string;
  logo_url?: string;
}

export class AgentConflictError extends Error {}
export class AgentNotFoundError extends Error {}

/** Local Athena default declaration (Spec §2): knowledge assistant with owl logo. */
export const DEFAULT_ATHENA: AgentCreateInput = {
  alias: "Athena",
  owner_employee_id: "system",
  logo_url: "/athena-logo-ai.png",
  runtime: "server",
  capabilities: {
    system: "athena",
    mcp: ["lightrag", "llm_wiki"],
    tools: ["file_upload", "knowledge_graph_qa"],
    skills: ["knowledge_graph_qa", "wiki_search", "document_ingest"],
    specialty: "knowledge",
  },
};

export interface AgentRegistry {
  list(filter?: { ownerEmployeeId?: string }): Promise<AgentRecord[]>;
  getByAlias(alias: string): Promise<AgentRecord | null>;
  create(input: AgentCreateInput): Promise<AgentRecord>;
  updateByAlias(alias: string, patch: AgentUpdateInput): Promise<AgentRecord>;
  /** An agent auto-fills its own capabilities; no alias/logo yet. */
  submitDeclaration(input: AgentDeclarationInput): Promise<PendingAgentDeclaration>;
  listDeclarations(): Promise<PendingAgentDeclaration[]>;
  /** Finalize a pending declaration into a registered agent (alias/logo chosen by the employee) and consume it. */
  registerDeclaration(id: string, input: AgentConfirmInput): Promise<AgentRecord>;
  /** Seed the default Athena agent (idempotent). Called on server start. */
  seed(): Promise<void>;
  close(): Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

/** In-memory registry — used by tests and as a dev fallback when DATABASE_URL is unset. */
export class MemoryAgentRegistry implements AgentRegistry {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly declarations = new Map<string, PendingAgentDeclaration>();

  constructor(initial: AgentCreateInput[] = []) {
    for (const input of initial) {
      if (!this.agents.has(input.alias)) {
        this.setRecord(input);
      }
    }
  }

  private setRecord(input: AgentCreateInput): void {
    const timestamp = now();
    this.agents.set(input.alias, {
      id: randomUUID(),
      alias: input.alias,
      owner_employee_id: input.owner_employee_id,
      logo_url: input.logo_url ?? "",
      capabilities: input.capabilities,
      runtime: input.runtime ?? "",
      created_at: timestamp,
      updated_at: timestamp,
    });
  }

  async create(input: AgentCreateInput): Promise<AgentRecord> {
    if (this.agents.has(input.alias)) {
      throw new AgentConflictError(`agent alias "${input.alias}" already registered`);
    }
    this.setRecord(input);
    return this.agents.get(input.alias)!;
  }

  async getByAlias(alias: string): Promise<AgentRecord | null> {
    return this.agents.get(alias) ?? null;
  }

  async list(filter?: { ownerEmployeeId?: string }): Promise<AgentRecord[]> {
    const records = [...this.agents.values()];
    if (!filter?.ownerEmployeeId) {
      return records;
    }
    return records.filter((r) => r.owner_employee_id === filter.ownerEmployeeId);
  }

  async updateByAlias(alias: string, patch: AgentUpdateInput): Promise<AgentRecord> {
    const existing = this.agents.get(alias);
    if (!existing) {
      throw new AgentNotFoundError(`agent "${alias}" not found`);
    }
    const updated: AgentRecord = {
      ...existing,
      logo_url: patch.logo_url ?? existing.logo_url,
      capabilities: patch.capabilities ?? existing.capabilities,
      updated_at: now(),
    };
    this.agents.set(alias, updated);
    return updated;
  }

  async submitDeclaration(input: AgentDeclarationInput): Promise<PendingAgentDeclaration> {
    const declaration: PendingAgentDeclaration = {
      id: randomUUID(),
      agent_id: input.agent_id,
      capabilities: input.capabilities,
      runtime: input.runtime ?? "",
      declared_at: now(),
    };
    this.declarations.set(declaration.id, declaration);
    return declaration;
  }

  async listDeclarations(): Promise<PendingAgentDeclaration[]> {
    return [...this.declarations.values()];
  }

  async registerDeclaration(id: string, input: AgentConfirmInput): Promise<AgentRecord> {
    const declaration = this.declarations.get(id);
    if (!declaration) {
      throw new AgentNotFoundError(`pending declaration "${id}" not found`);
    }
    const record = await this.create({
      alias: input.alias,
      owner_employee_id: input.owner_employee_id,
      logo_url: input.logo_url,
      capabilities: declaration.capabilities,
      runtime: declaration.runtime,
    });
    this.declarations.delete(id);
    return record;
  }

  async seed(): Promise<void> {
    if (!this.agents.has(DEFAULT_ATHENA.alias)) {
      this.setRecord(DEFAULT_ATHENA);
    }
  }

  async close(): Promise<void> {
    this.agents.clear();
    this.declarations.clear();
  }
}

export interface PostgresAgentRegistryOptions {
  connectionString?: string;
  pool?: pg.Pool;
}

interface AgentRow {
  id: string;
  alias: string;
  owner_employee_id: string;
  logo_url: string;
  capabilities: AgentCapabilities;
  runtime: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AgentDeclarationRow {
  id: string;
  agent_id: string;
  capabilities: AgentCapabilities;
  runtime: string;
  declared_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    alias: row.alias,
    owner_employee_id: row.owner_employee_id,
    logo_url: row.logo_url,
    capabilities: row.capabilities,
    runtime: row.runtime,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function rowToDeclaration(row: AgentDeclarationRow): PendingAgentDeclaration {
  return {
    id: row.id,
    agent_id: row.agent_id,
    capabilities: row.capabilities,
    runtime: row.runtime,
    declared_at: toIso(row.declared_at),
  };
}

/** Postgres-backed registry: lazy CREATE TABLE + Athena seed on first use. */
export class PostgresAgentRegistry implements AgentRegistry {
  private readonly pool: pg.Pool;
  private ready: Promise<void> | null = null;

  constructor(options: PostgresAgentRegistryOptions = {}) {
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
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        alias TEXT UNIQUE NOT NULL,
        owner_employee_id TEXT NOT NULL,
        logo_url TEXT NOT NULL DEFAULT '',
        capabilities JSONB NOT NULL,
        runtime TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_declarations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        capabilities JSONB NOT NULL,
        runtime TEXT NOT NULL DEFAULT '',
        declared_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(
      `INSERT INTO agents (id, alias, owner_employee_id, logo_url, capabilities, runtime)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (alias) DO NOTHING`,
      [
        randomUUID(),
        DEFAULT_ATHENA.alias,
        DEFAULT_ATHENA.owner_employee_id,
        DEFAULT_ATHENA.logo_url ?? "",
        JSON.stringify(DEFAULT_ATHENA.capabilities),
        DEFAULT_ATHENA.runtime ?? "",
      ],
    );
  }

  /** Eagerly ensure table + seed Athena. Idempotent (ON CONFLICT DO NOTHING). */
  async seed(): Promise<void> {
    await this.ensureReady();
  }

  async create(input: AgentCreateInput): Promise<AgentRecord> {
    await this.ensureReady();
    try {
      const result = await this.pool.query<AgentRow>(
        `INSERT INTO agents (id, alias, owner_employee_id, logo_url, capabilities, runtime)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          randomUUID(),
          input.alias,
          input.owner_employee_id,
          input.logo_url ?? "",
          JSON.stringify(input.capabilities),
          input.runtime ?? "",
        ],
      );
      return rowToRecord(result.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AgentConflictError(`agent alias "${input.alias}" already registered`);
      }
      throw err;
    }
  }

  async getByAlias(alias: string): Promise<AgentRecord | null> {
    await this.ensureReady();
    const result = await this.pool.query<AgentRow>(
      `SELECT * FROM agents WHERE alias = $1`,
      [alias],
    );
    return result.rows[0] ? rowToRecord(result.rows[0]) : null;
  }

  async list(filter?: { ownerEmployeeId?: string }): Promise<AgentRecord[]> {
    await this.ensureReady();
    const result = filter?.ownerEmployeeId
      ? await this.pool.query<AgentRow>(
          `SELECT * FROM agents WHERE owner_employee_id = $1 ORDER BY created_at`,
          [filter.ownerEmployeeId],
        )
      : await this.pool.query<AgentRow>(`SELECT * FROM agents ORDER BY created_at`);
    return result.rows.map(rowToRecord);
  }

  async updateByAlias(alias: string, patch: AgentUpdateInput): Promise<AgentRecord> {
    await this.ensureReady();
    const result = await this.pool.query<AgentRow>(
      `UPDATE agents
       SET logo_url = COALESCE($2, logo_url),
           capabilities = COALESCE($3, capabilities),
           updated_at = now()
       WHERE alias = $1
       RETURNING *`,
      [alias, patch.logo_url ?? null, patch.capabilities ? JSON.stringify(patch.capabilities) : null],
    );
    if (result.rows.length === 0) {
      throw new AgentNotFoundError(`agent "${alias}" not found`);
    }
    return rowToRecord(result.rows[0]);
  }

  async submitDeclaration(input: AgentDeclarationInput): Promise<PendingAgentDeclaration> {
    await this.ensureReady();
    const result = await this.pool.query<AgentDeclarationRow>(
      `INSERT INTO agent_declarations (id, agent_id, capabilities, runtime)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [randomUUID(), input.agent_id, JSON.stringify(input.capabilities), input.runtime ?? ""],
    );
    return rowToDeclaration(result.rows[0]);
  }

  async listDeclarations(): Promise<PendingAgentDeclaration[]> {
    await this.ensureReady();
    const result = await this.pool.query<AgentDeclarationRow>(
      `SELECT * FROM agent_declarations ORDER BY declared_at`,
    );
    return result.rows.map(rowToDeclaration);
  }

  async registerDeclaration(id: string, input: AgentConfirmInput): Promise<AgentRecord> {
    await this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const decl = await client.query<AgentDeclarationRow>(
        `SELECT * FROM agent_declarations WHERE id = $1`,
        [id],
      );
      if (decl.rows.length === 0) {
        await client.query("ROLLBACK");
        throw new AgentNotFoundError(`pending declaration "${id}" not found`);
      }
      const declaration = decl.rows[0];
      let result: pg.QueryResult<AgentRow>;
      try {
        result = await client.query<AgentRow>(
          `INSERT INTO agents (id, alias, owner_employee_id, logo_url, capabilities, runtime)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [
            randomUUID(),
            input.alias,
            input.owner_employee_id,
            input.logo_url ?? "",
            JSON.stringify(declaration.capabilities),
            declaration.runtime,
          ],
        );
      } catch (err) {
        await client.query("ROLLBACK");
        if (isUniqueViolation(err)) {
          throw new AgentConflictError(`agent alias "${input.alias}" already registered`);
        }
        throw err;
      }
      await client.query(`DELETE FROM agent_declarations WHERE id = $1`, [id]);
      await client.query("COMMIT");
      return rowToRecord(result.rows[0]);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}
