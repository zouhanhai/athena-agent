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

/** GET /api/agents → registered agents. */
export async function listAgents(): Promise<AgentRecord[]> {
  const data = await request<{ agents: AgentRecord[] }>("/api/agents");
  return data.agents;
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
