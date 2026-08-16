import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

export interface AgentCapabilities {
  system: string;
  mcp: string[];
  tools: string[];
  skills: string[];
  specialty: string;
  description?: string;
  /** A2A-aligned: discovery tags (e.g. ["sap", "reporting"]) for categorization. */
  tags?: string[];
  /** A2A-aligned: example prompts/queries showing what the agent can do. */
  examples?: string[];
}

/**
 * Reachability / onboarding status of an agent (G4.S7.T2):
 * - `unknown`: no remote identity or reachability recorded (e.g. seeded local Athena).
 * - `invited`: an invitation `{agent_id, api_url, token}` was issued; the agent has not registered yet.
 * - `registered`: registered with the platform (manual or via invitation); reachability recorded but not recently confirmed.
 * - `reachable`: registered AND the agent confirmed connectivity recently (api_url + fresh last_seen_at).
 */
export type AgentStatus = "unknown" | "invited" | "registered" | "reachable";

export interface AgentRecord {
  id: string;
  alias: string;
  /** The agent's unique platform identity (invitation-issued or inherited). */
  agent_id: string;
  owner_employee_id: string;
  logo_url: string;
  capabilities: AgentCapabilities;
  runtime: string;
  /** Where the platform reaches the agent's own API server (reachability). */
  api_url: string;
  /** Derived reachability/onboarding status (see AgentStatus). */
  status: AgentStatus;
  /** Whether an invitation auth token is active for this agent (never the raw token). */
  has_token: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentCreateInput {
  alias: string;
  owner_employee_id: string;
  logo_url?: string;
  capabilities: AgentCapabilities;
  runtime?: string;
  /** Optional external identity. Defaults to the record id when omitted. */
  agent_id?: string;
  /** Where the agent's own API server can be reached. */
  api_url?: string;
  /** Optional invitation auth token (stored only as a SHA-256 hash). */
  token?: string;
}

export interface AgentUpdateInput {
  logo_url?: string;
  capabilities?: AgentCapabilities;
  api_url?: string;
  agent_id?: string;
  /** Raw invitation auth token (stored only as a SHA-256 hash). */
  token?: string;
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
  /** Optional remote reachability fields recorded at registration (G4.S7.T2). */
  api_url?: string;
  agent_id?: string;
  token?: string;
}

/** Invitation issued by an admin: identity + reachability + a fresh auth token. */
export interface AgentInvite {
  agent_id: string;
  /** Reachability the platform will use to drive the agent (T4 Chat routing). */
  api_url: string;
  /** Raw auth token — returned exactly once, only the SHA-256 hash is stored. */
  token: string;
}

export interface AgentInviteResult {
  agent: AgentRecord;
  invite: AgentInvite;
}

/** Admin input to generate an agent invitation. */
export interface AgentInviteInput {
  alias: string;
  owner_employee_id: string;
  logo_url?: string;
  api_url?: string;
  runtime?: string;
  /** Optional pre-selected identity; a random one is generated when omitted. */
  agent_id?: string;
  /** Optional capability profile. Can be filled later via self-declare/register. */
  capabilities?: AgentCapabilities;
}

/** Auth'd registration the invited agent performs: posts its real reachability + token. */
export interface AgentInviteRegisterInput {
  agent_id: string;
  api_url: string;
  token: string;
}

export class AgentConflictError extends Error {}
export class AgentNotFoundError extends Error {}
/** The agent's invitation token (and/or agent_id) did not match the platform's record. */
export class AgentAuthError extends Error {}

/** Capabilities placeholder for an invited agent that has not self-declared yet. */
const EMPTY_CAPABILITIES: AgentCapabilities = {
  system: "",
  mcp: [],
  tools: [],
  skills: [],
  specialty: "",
};

/** Freshness window before a registered agent's connectivity is considered stale. */
export const AGENT_REACHABLE_WINDOW_MS = 5 * 60 * 1000;

/** Local Athena default declaration (Spec §2): knowledge assistant with owl logo. */
export const DEFAULT_ATHENA: AgentCreateInput = {
  alias: "Athena",
  owner_employee_id: "system",
  logo_url: "/athena-logo-ai.png",
  runtime: "server",
  capabilities: {
    system: "athena",
    mcp: ["llm_wiki"],
    tools: ["file_upload", "knowledge_graph_qa"],
    skills: ["knowledge_graph_qa", "wiki_search", "document_ingest"],
    specialty: "knowledge",
  },
};

export interface AgentRegistry {
  list(filter?: { ownerEmployeeId?: string }): Promise<AgentRecord[]>;
  getByAlias(alias: string): Promise<AgentRecord | null>;
  /** Look an agent up by its unique invitation-issued identity (agent_id). */
  getByAgentId(agentId: string): Promise<AgentRecord | null>;
  create(input: AgentCreateInput): Promise<AgentRecord>;
  updateByAlias(alias: string, patch: AgentUpdateInput): Promise<AgentRecord>;
  /** An agent auto-fills its own capabilities; no alias/logo yet. */
  submitDeclaration(input: AgentDeclarationInput): Promise<PendingAgentDeclaration>;
  listDeclarations(): Promise<PendingAgentDeclaration[]>;
  /** Finalize a pending declaration into a registered agent (alias/logo chosen by the employee) and consume it. */
  registerDeclaration(id: string, input: AgentConfirmInput): Promise<AgentRecord>;
  /** Admin generates `{agent_id, api_url, token}` and hands it to the agent (G4.S7.T2). */
  createInvitation(input: AgentInviteInput): Promise<AgentInviteResult>;
  /** The invited agent registers with its token + real api_url (auth'd); records reachability. */
  registerWithInvite(input: AgentInviteRegisterInput): Promise<AgentRecord>;
  /**
   * G4.S7.T4 reverse-WS credentials check: validates that `token` matches the
   * agent's stored invitation hash, WITHOUT requiring an api_url. Used by the
   * WS gateway when an agent connects INTO the platform. Returns null on a
   * mismatch (never exposes the raw token).
   */
  verifyCredentials(agentId: string, token: string): Promise<AgentRecord | null>;
  /** Touch the agent's last_seen_at so a live reverse-WS tunnel reads as reachable (G4.S7.T4). */
  markReachable(agentId: string): Promise<AgentRecord | null>;
  /** Delete an agent record (cancel an invitation / remove a registered agent). */
  deleteByAgentId(agentId: string): Promise<boolean>;
  /** Seed the default Athena agent (idempotent). Called on server start. */
  seed(): Promise<void>;
  close(): Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("hex");
}

function toEpochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function recordStatus(
  registeredAt: Date | string | null,
  tokenHash: string,
  apiUrl: string,
  lastSeenAt: Date | string | null,
  windowMs: number,
): AgentStatus {
  if (!registeredAt) {
    return tokenHash ? "invited" : "unknown";
  }
  // Reachability = connectivity confirmed recently. With reverse WS (G4.S7.T4)
  // the live tunnel is the reachability signal (it touches last_seen_at on
  // connect) — api_url is the old HTTP-forwarding address and no longer required.
  if (lastSeenAt && Date.now() - toEpochMs(lastSeenAt) <= windowMs) {
    return "reachable";
  }
  return "registered";
}

/**
 * In-memory registry — used by tests and as a dev fallback when DATABASE_URL is unset.
 */
export class MemoryAgentRegistry implements AgentRegistry {
  private readonly agents = new Map<string, StoredAgent>();
  private readonly declarations = new Map<string, PendingAgentDeclaration>();
  private readonly windowMs: number;

  constructor(
    initial: AgentCreateInput[] = [],
    options: { reachableWindowMs?: number } = {},
  ) {
    this.windowMs = options.reachableWindowMs ?? AGENT_REACHABLE_WINDOW_MS;
    for (const input of initial) {
      if (!this.agents.has(input.alias)) {
        this.setRecord(input);
      }
    }
  }

  private setRecord(input: AgentCreateInput): void {
    const id = randomUUID();
    const timestamp = now();
    this.agents.set(input.alias, {
      id,
      alias: input.alias,
      agent_id: input.agent_id ?? id,
      owner_employee_id: input.owner_employee_id,
      logo_url: input.logo_url ?? "",
      capabilities: input.capabilities,
      runtime: input.runtime ?? "",
      api_url: input.api_url ?? "",
      token_hash: input.token ? hashToken(input.token) : "",
      registered_at: null,
      last_seen_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }

  private findByAgentId(agentId: string): StoredAgent | null {
    for (const stored of this.agents.values()) {
      if (stored.agent_id === agentId) {
        return stored;
      }
    }
    return null;
  }

  private recordFromStored(stored: StoredAgent): AgentRecord {
    return recordFromFields(stored, this.windowMs);
  }

  async create(input: AgentCreateInput): Promise<AgentRecord> {
    if (this.agents.has(input.alias)) {
      throw new AgentConflictError(`agent alias "${input.alias}" already registered`);
    }
    const id = randomUUID();
    const agentId = input.agent_id ?? id;
    if (this.findByAgentId(agentId)) {
      throw new AgentConflictError(`agent identity "${agentId}" already registered`);
    }
    const timestamp = now();
    const stored: StoredAgent = {
      id,
      alias: input.alias,
      agent_id: agentId,
      owner_employee_id: input.owner_employee_id,
      logo_url: input.logo_url ?? "",
      capabilities: input.capabilities,
      runtime: input.runtime ?? "",
      api_url: input.api_url ?? "",
      token_hash: input.token ? hashToken(input.token) : "",
      registered_at: timestamp,
      last_seen_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.agents.set(stored.alias, stored);
    return this.recordFromStored(stored);
  }

  async getByAlias(alias: string): Promise<AgentRecord | null> {
    const stored = this.agents.get(alias);
    return stored ? this.recordFromStored(stored) : null;
  }

  async getByAgentId(agentId: string): Promise<AgentRecord | null> {
    const stored = this.findByAgentId(agentId);
    return stored ? this.recordFromStored(stored) : null;
  }

  async list(filter?: { ownerEmployeeId?: string }): Promise<AgentRecord[]> {
    const records = [...this.agents.values()].map((s) => this.recordFromStored(s));
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
    const agentId = patch.agent_id ?? existing.agent_id;
    if (agentId !== existing.agent_id) {
      const clash = this.findByAgentId(agentId);
      if (clash && clash.alias !== alias) {
        throw new AgentConflictError(`agent identity "${agentId}" already registered`);
      }
    }
    const updated: StoredAgent = {
      ...existing,
      logo_url: patch.logo_url ?? existing.logo_url,
      capabilities: patch.capabilities ?? existing.capabilities,
      api_url: patch.api_url ?? existing.api_url,
      agent_id: agentId,
      token_hash: patch.token ? hashToken(patch.token) : existing.token_hash,
      updated_at: now(),
    };
    this.agents.delete(alias);
    this.agents.set(updated.alias, updated);
    return this.recordFromStored(updated);
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
      // Inherit the agent's self-declared identity so declaration + invitation unify.
      agent_id: input.agent_id ?? declaration.agent_id,
      api_url: input.api_url,
      token: input.token,
    });
    this.declarations.delete(id);
    return record;
  }

  async createInvitation(input: AgentInviteInput): Promise<AgentInviteResult> {
    if (this.agents.has(input.alias)) {
      throw new AgentConflictError(`agent alias "${input.alias}" already registered`);
    }
    const id = randomUUID();
    const agentId = input.agent_id ?? `agent-${randomToken()}`;
    if (this.findByAgentId(agentId)) {
      throw new AgentConflictError(`agent identity "${agentId}" already registered`);
    }
    const token = randomToken();
    const timestamp = now();
    const stored: StoredAgent = {
      id,
      alias: input.alias,
      agent_id: agentId,
      owner_employee_id: input.owner_employee_id,
      logo_url: input.logo_url ?? "",
      capabilities: input.capabilities ?? EMPTY_CAPABILITIES,
      runtime: input.runtime ?? "",
      api_url: input.api_url ?? "",
      token_hash: hashToken(token),
      registered_at: null,
      last_seen_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.agents.set(stored.alias, stored);
    return {
      agent: this.recordFromStored(stored),
      invite: { agent_id: agentId, api_url: stored.api_url, token },
    };
  }

  async registerWithInvite(input: AgentInviteRegisterInput): Promise<AgentRecord> {
    const existing = this.findByAgentId(input.agent_id);
    if (!existing || existing.token_hash.length === 0 || existing.token_hash !== hashToken(input.token)) {
      throw new AgentAuthError("invalid agent_id or token");
    }
    const stored: StoredAgent = {
      ...existing,
      api_url: input.api_url,
      registered_at: now(),
      last_seen_at: now(),
      updated_at: now(),
    };
    this.agents.set(stored.alias, stored);
    return this.recordFromStored(stored);
  }

  /** G4.S7.T4: reverse-WS credentials check — token must match the stored hash. */
  async verifyCredentials(agentId: string, token: string): Promise<AgentRecord | null> {
    const stored = this.findByAgentId(agentId);
    if (!stored || !stored.token_hash || stored.token_hash !== hashToken(token)) {
      return null;
    }
    return this.recordFromStored(stored);
  }

  /** G4.S7.T4: a live tunnel marks the agent reachable (fresh last_seen_at). An
   *  auth'd WS connection is itself proof of registration, so a not-yet-HTTPS-
   *  registered agent is promoted to registered at the same time. */
  async markReachable(agentId: string): Promise<AgentRecord | null> {
    const stored = this.findByAgentId(agentId);
    if (!stored) {
      return null;
    }
    const updated: StoredAgent = {
      ...stored,
      registered_at: stored.registered_at ?? now(),
      last_seen_at: now(),
      updated_at: now(),
    };
    this.agents.set(updated.alias, updated);
    return this.recordFromStored(updated);
  }

  async deleteByAgentId(agentId: string): Promise<boolean> {
    const stored = this.findByAgentId(agentId);
    if (!stored) {
      return false;
    }
    return this.agents.delete(stored.alias);
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

interface StoredAgent {
  id: string;
  alias: string;
  agent_id: string;
  owner_employee_id: string;
  logo_url: string;
  capabilities: AgentCapabilities;
  runtime: string;
  api_url: string;
  token_hash: string;
  registered_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PostgresAgentRegistryOptions {
  connectionString?: string;
  pool?: pg.Pool;
  /** Freshness window before a registered agent is considered stale (default 5 min). */
  reachableWindowMs?: number;
}

interface AgentRow {
  id: string;
  alias: string;
  agent_id: string;
  owner_employee_id: string;
  logo_url: string;
  capabilities: AgentCapabilities;
  runtime: string;
  api_url: string;
  token_hash: string;
  registered_at: Date | string | null;
  last_seen_at: Date | string | null;
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

function recordFromFields(
  fields: {
    id: string;
    alias: string;
    agent_id: string;
    owner_employee_id: string;
    logo_url: string;
    capabilities: AgentCapabilities;
    runtime: string;
    api_url: string;
    token_hash: string;
    registered_at: string | Date | null;
    last_seen_at: string | Date | null;
    created_at: string | Date;
    updated_at: string | Date;
  },
  windowMs: number,
): AgentRecord {
  return {
    id: fields.id,
    alias: fields.alias,
    agent_id: fields.agent_id || fields.id,
    owner_employee_id: fields.owner_employee_id,
    logo_url: fields.logo_url,
    capabilities: fields.capabilities,
    runtime: fields.runtime,
    api_url: fields.api_url,
    status: recordStatus(fields.registered_at, fields.token_hash, fields.api_url, fields.last_seen_at, windowMs),
    has_token: fields.token_hash.length > 0,
    created_at: toIso(fields.created_at),
    updated_at: toIso(fields.updated_at),
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
  private readonly windowMs: number;
  private ready: Promise<void> | null = null;

  constructor(options: PostgresAgentRegistryOptions = {}) {
    this.pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString });
    this.windowMs = options.reachableWindowMs ?? AGENT_REACHABLE_WINDOW_MS;
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
        agent_id TEXT NOT NULL DEFAULT '',
        owner_employee_id TEXT NOT NULL,
        logo_url TEXT NOT NULL DEFAULT '',
        capabilities JSONB NOT NULL,
        runtime TEXT NOT NULL DEFAULT '',
        api_url TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL DEFAULT '',
        registered_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // G4.S7.T2 migration for existing databases: add the remote reachability
    // columns (nullable / defaulted), backfill agent_id from the record id, and
    // enforce agent_id uniqueness.
    await this.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT ''`);
    await this.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_url TEXT NOT NULL DEFAULT ''`);
    await this.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS token_hash TEXT NOT NULL DEFAULT ''`);
    await this.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ`);
    await this.pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`);
    await this.pool.query(`UPDATE agents SET agent_id = id WHERE agent_id = '' OR agent_id IS NULL`);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS agents_agent_id_key ON agents (agent_id)`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_declarations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        capabilities JSONB NOT NULL,
        runtime TEXT NOT NULL DEFAULT '',
        declared_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO agents (id, alias, agent_id, owner_employee_id, logo_url, capabilities, runtime)
       VALUES ($1, $2, $1, $3, $4, $5, $6)
       ON CONFLICT (alias) DO NOTHING`,
      [
        id,
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

  private recordFromRow(row: AgentRow): AgentRecord {
    return recordFromFields(row, this.windowMs);
  }

  async create(input: AgentCreateInput): Promise<AgentRecord> {
    await this.ensureReady();
    const id = randomUUID();
    const agentId = input.agent_id ?? id;
    try {
      const result = await this.pool.query<AgentRow>(
        `INSERT INTO agents (id, alias, agent_id, owner_employee_id, logo_url, capabilities, runtime, api_url, token_hash, registered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         RETURNING *`,
        [
          id,
          input.alias,
          agentId,
          input.owner_employee_id,
          input.logo_url ?? "",
          JSON.stringify(input.capabilities),
          input.runtime ?? "",
          input.api_url ?? "",
          input.token ? hashToken(input.token) : "",
        ],
      );
      return this.recordFromRow(result.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AgentConflictError(`agent alias "${input.alias}" or identity "${agentId}" already registered`);
      }
      throw err;
    }
  }

  async getByAlias(alias: string): Promise<AgentRecord | null> {
    await this.ensureReady();
    const result = await this.pool.query<AgentRow>(`SELECT * FROM agents WHERE alias = $1`, [alias]);
    return result.rows[0] ? this.recordFromRow(result.rows[0]) : null;
  }

  async getByAgentId(agentId: string): Promise<AgentRecord | null> {
    await this.ensureReady();
    const result = await this.pool.query<AgentRow>(`SELECT * FROM agents WHERE agent_id = $1`, [agentId]);
    return result.rows[0] ? this.recordFromRow(result.rows[0]) : null;
  }

  async list(filter?: { ownerEmployeeId?: string }): Promise<AgentRecord[]> {
    await this.ensureReady();
    const result = filter?.ownerEmployeeId
      ? await this.pool.query<AgentRow>(
          `SELECT * FROM agents WHERE owner_employee_id = $1 ORDER BY created_at`,
          [filter.ownerEmployeeId],
        )
      : await this.pool.query<AgentRow>(`SELECT * FROM agents ORDER BY created_at`);
    return result.rows.map((row) => this.recordFromRow(row));
  }

  async updateByAlias(alias: string, patch: AgentUpdateInput): Promise<AgentRecord> {
    await this.ensureReady();
    try {
      const result = await this.pool.query<AgentRow>(
        `UPDATE agents
         SET logo_url = COALESCE($2, logo_url),
             capabilities = COALESCE($3, capabilities),
             api_url = COALESCE($4, api_url),
             agent_id = COALESCE($5, agent_id),
             token_hash = CASE WHEN $6 IS NULL THEN token_hash ELSE $6 END,
             updated_at = now()
         WHERE alias = $1
         RETURNING *`,
        [
          alias,
          patch.logo_url ?? null,
          patch.capabilities ? JSON.stringify(patch.capabilities) : null,
          patch.api_url ?? null,
          patch.agent_id ?? null,
          patch.token ? hashToken(patch.token) : null,
        ],
      );
      if (result.rows.length === 0) {
        throw new AgentNotFoundError(`agent "${alias}" not found`);
      }
      return this.recordFromRow(result.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AgentConflictError(`agent alias "${alias}" or identity already registered`);
      }
      throw err;
    }
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
          `INSERT INTO agents (id, alias, agent_id, owner_employee_id, logo_url, capabilities, runtime, api_url, token_hash, registered_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
           RETURNING *`,
          [
            randomUUID(),
            input.alias,
            input.agent_id ?? declaration.agent_id,
            input.owner_employee_id,
            input.logo_url ?? "",
            JSON.stringify(declaration.capabilities),
            declaration.runtime,
            input.api_url ?? "",
            input.token ? hashToken(input.token) : "",
          ],
        );
      } catch (err) {
        await client.query("ROLLBACK");
        if (isUniqueViolation(err)) {
          throw new AgentConflictError(`agent alias "${input.alias}" or identity already registered`);
        }
        throw err;
      }
      await client.query(`DELETE FROM agent_declarations WHERE id = $1`, [id]);
      await client.query("COMMIT");
      return this.recordFromRow(result.rows[0]);
    } finally {
      client.release();
    }
  }

  async createInvitation(input: AgentInviteInput): Promise<AgentInviteResult> {
    await this.ensureReady();
    const id = randomUUID();
    const agentId = input.agent_id ?? `agent-${randomToken()}`;
    const token = randomToken();
    try {
      const result = await this.pool.query<AgentRow>(
        `INSERT INTO agents (id, alias, agent_id, owner_employee_id, logo_url, capabilities, runtime, api_url, token_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          id,
          input.alias,
          agentId,
          input.owner_employee_id,
          input.logo_url ?? "",
          JSON.stringify(input.capabilities ?? EMPTY_CAPABILITIES),
          input.runtime ?? "",
          input.api_url ?? "",
          hashToken(token),
        ],
      );
      return {
        agent: this.recordFromRow(result.rows[0]),
        invite: { agent_id: agentId, api_url: input.api_url ?? "", token },
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AgentConflictError(`agent alias "${input.alias}" or identity "${agentId}" already registered`);
      }
      throw err;
    }
  }

  async registerWithInvite(input: AgentInviteRegisterInput): Promise<AgentRecord> {
    await this.ensureReady();
    const found = await this.pool.query<AgentRow>(
      `SELECT * FROM agents WHERE agent_id = $1`,
      [input.agent_id],
    );
    const row = found.rows[0];
    if (!row || !row.token_hash || row.token_hash !== hashToken(input.token)) {
      throw new AgentAuthError("invalid agent_id or token");
    }
    const result = await this.pool.query<AgentRow>(
      `UPDATE agents
       SET api_url = $2, registered_at = now(), last_seen_at = now(), updated_at = now()
       WHERE agent_id = $1
       RETURNING *`,
      [input.agent_id, input.api_url],
    );
    return this.recordFromRow(result.rows[0]);
  }

  /** G4.S7.T4: reverse-WS credentials check — token must match the stored hash. */
  async verifyCredentials(agentId: string, token: string): Promise<AgentRecord | null> {
    await this.ensureReady();
    const result = await this.pool.query<AgentRow>(
      `SELECT * FROM agents WHERE agent_id = $1 AND token_hash = $2 AND token_hash <> ''`,
      [agentId, hashToken(token)],
    );
    return result.rows[0] ? this.recordFromRow(result.rows[0]) : null;
  }

  /** G4.S7.T4: a live tunnel marks the agent reachable (fresh last_seen_at). An
   *  auth'd WS connection is itself proof of registration, so a not-yet-HTTPS-
   *  registered agent is promoted to registered at the same time. */
  async markReachable(agentId: string): Promise<AgentRecord | null> {
    await this.ensureReady();
    const result = await this.pool.query<AgentRow>(
      `UPDATE agents
       SET registered_at = COALESCE(registered_at, now()), last_seen_at = now(), updated_at = now()
       WHERE agent_id = $1
       RETURNING *`,
      [agentId],
    );
    return result.rows[0] ? this.recordFromRow(result.rows[0]) : null;
  }

  async deleteByAgentId(agentId: string): Promise<boolean> {
    await this.ensureReady();
    const result = await this.pool.query(
      `DELETE FROM agents WHERE agent_id = $1`,
      [agentId],
    );
    return (result.rowCount ?? 0) > 0;
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