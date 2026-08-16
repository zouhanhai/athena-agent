/**
 * Frontend API layer for the agent registry endpoints (G3.S1).
 * Agent-era registration: agents self-declare capabilities; the employee
 * reviews pending declarations, picks alias + logo, and confirms.
 */

export interface AgentCapabilities {
  system: string;
  mcp: string[];
  tools: string[];
  skills: string[];
  specialty: string;
  description?: string;
  /** A2A-aligned: discovery tags (e.g. ["sap", "reporting"]). */
  tags?: string[];
  /** A2A-aligned: example prompts/queries showing what the agent can do. */
  examples?: string[];
}

/**
 * Reachability / onboarding status of an agent (G4.S7.T2):
 * - unknown / invited / registered / reachable — see server AgentStatus.
 */
export type AgentStatus = "unknown" | "invited" | "registered" | "reachable";

export interface AgentRecord {
  id: string;
  alias: string;
  /** The agent's unique platform identity (invitation-issued / inherited). */
  agent_id: string;
  owner_employee_id: string;
  logo_url: string;
  capabilities: AgentCapabilities;
  runtime: string;
  /** Where the platform reaches the agent's own API server (reachability). */
  api_url: string;
  status: AgentStatus;
  /** Whether an invitation auth token is active for this agent (never the raw token). */
  has_token: boolean;
  /** G4.S7.T4: whether the agent holds a live reverse-WS tunnel right now (platform-driven). */
  connected?: boolean;
  created_at: string;
  updated_at: string;
}

export interface PendingAgentDeclaration {
  id: string;
  agent_id: string;
  capabilities: AgentCapabilities;
  runtime: string;
  declared_at: string;
}

export interface LogoRecord {
  id: string;
  name: string;
  animal?: string;
  color?: string;
  url: string;
  filename: string;
  source: "generated" | "upload";
  created_at: string;
}

export interface RegisterDeclarationInput {
  alias: string;
  owner_employee_id: string;
  logo_url?: string;
  /** Optional remote reachability + identity recorded at registration (G4.S7.T2). */
  api_url?: string;
  agent_id?: string;
  token?: string;
}

/** Manual registration input mirroring AgentCreateInput (POST /api/agents). */
export interface CreateAgentInput {
  alias: string;
  owner_employee_id: string;
  logo_url?: string;
  capabilities: AgentCapabilities;
  runtime?: string;
  agent_id?: string;
  api_url?: string;
  token?: string;
}

/** Admin generates { agent_id, api_url, token } and hands it to the remote agent. */
export interface AgentInviteInput {
  alias: string;
  owner_employee_id: string;
  logo_url?: string;
  capabilities?: AgentCapabilities;
  runtime?: string;
  api_url?: string;
  agent_id?: string;
}

export interface AgentInvite {
  agent_id: string;
  api_url: string;
  /** Raw auth token — shown exactly once, then only its hash is stored. */
  token: string;
  /** Self-serve onboarding link the remote agent can open to read the
   *  registration flow + its credentials + the capability-declaration format. */
  onboarding_url?: string;
}

export interface AgentInviteResult {
  agent: AgentRecord;
  invite: AgentInvite;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return (await res.json()) as T;
}

/** POST /api/agents/self-declare → an agent auto-fills its own capabilities (no alias/logo yet). */
export async function submitSelfDeclaration(
  agentId: string,
  capabilities: AgentCapabilities,
  runtime?: string,
): Promise<PendingAgentDeclaration> {
  const data = await request<{ declaration: PendingAgentDeclaration }>("/api/agents/self-declare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId, capabilities, runtime }),
  });
  return data.declaration;
}

/** GET /api/agents/declarations → agents that self-declared but are not registered yet. */
export async function listDeclarations(): Promise<PendingAgentDeclaration[]> {
  const data = await request<{ declarations: PendingAgentDeclaration[] }>("/api/agents/declarations");
  return data.declarations;
}

/** POST /api/agents/register-declaration/:id → employee confirms alias + logo, creating the agent. */
export async function registerDeclaration(
  id: string,
  input: RegisterDeclarationInput,
): Promise<AgentRecord> {
  return request<AgentRecord>(`/api/agents/register-declaration/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * POST /api/agents/invite (admin) → generate `{agent_id, api_url, token}` and hand it
 * to the remote agent, which registers via POST /api/agents/register (G4.S7.T2).
 */
export async function inviteAgent(
  sessionToken: string,
  input: AgentInviteInput,
): Promise<AgentInviteResult> {
  return request<AgentInviteResult>("/api/agents/invite", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(input),
  });
}

/** POST /api/agents/register → the invited agent registers auth'd with its token + reachability. */
export async function registerAgent(input: {
  agent_id: string;
  api_url?: string;
  token: string;
}): Promise<AgentRecord> {
  return request<AgentRecord>("/api/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** POST /api/agents → manually register an agent with its capabilities + remote fields. */
export async function createAgent(input: CreateAgentInput): Promise<AgentRecord> {
  return request<AgentRecord>("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** GET /api/agents → registered agents. */
export async function listAgents(): Promise<AgentRecord[]> {
  const data = await request<{ agents: AgentRecord[] }>("/api/agents");
  return data.agents;
}

/** DELETE /api/agents/:agentId → delete an agent record (cancel an invite / remove an agent). */
export async function deleteAgent(agentId: string, sessionToken: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
}

export interface ListLogosOptions {
  /** Server-side filter: drop logos already used by an agent or employee. */
  excludeInUse?: boolean;
}

/** GET /api/logos → the generated animal logo set + self-uploads for the employee to pick from. */
export async function listLogos(options?: ListLogosOptions): Promise<LogoRecord[]> {
  const url = options?.excludeInUse ? "/api/logos?exclude-in-use=1" : "/api/logos";
  const data = await request<{ logos: LogoRecord[] }>(url);
  return data.logos;
}

/** POST /api/logos (multipart `file`) → upload a custom logo image; appears in the picker after refresh. */
export async function uploadLogo(file: File): Promise<LogoRecord> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/logos", { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  const data = (await res.json()) as { logo: LogoRecord };
  return data.logo;
}
