/**
 * Frontend API layer for invitation-based employee registration (G3.S2.T4)
 * plus the employee magic-link login flow it builds on (G3.S2.T1).
 */

export interface GithubCredential {
  type: "ssh" | "token";
  value: string;
}

export interface EmployeeRecord {
  id: string;
  email: string;
  display_name: string;
  logo_url: string;
  role: "admin" | "member";
  /** Admin-granted extra permissions beyond the role defaults (G4.S3.T10), e.g. `kb.edit`. */
  permissions?: string[];
  created_at: string;
  updated_at: string;
  /** Whether the employee has a stored GitHub credential (never the value). */
  github_has_credential?: boolean;
  github_credential_type?: "ssh" | "token";
  /** Partial mask (first + last 4 chars) of the stored credential, when present. */
  github_credential_masked?: string;
}

export interface LoginVerification {
  session_token: string;
  employee: EmployeeRecord;
}

export interface InvitedEmployeeRegistrationInput {
  display_name?: string;
  logo_url?: string;
  github_credential?: GithubCredential;
}

/** Self-service profile update for the signed-in employee (PUT /api/me). */
export interface MeUpdateInput {
  display_name?: string;
  logo_url?: string;
  github_credential?: GithubCredential;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message =
      detail && typeof (detail as { error?: unknown }).error === "string"
        ? (detail as { error: string }).error
        : `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** GET /api/invitations/resolve?token=TOKEN → the invited email (public). */
export async function resolveInvitation(token: string): Promise<string> {
  const data = await request<{ email: string }>(
    `/api/invitations/resolve?token=${encodeURIComponent(token)}`,
  );
  return data.email;
}

/** POST /api/invitations/register → { session_token, employee } (auto-login). */
export async function registerInvitedEmployee(
  token: string,
  input: InvitedEmployeeRegistrationInput,
): Promise<LoginVerification> {
  return request<LoginVerification>("/api/invitations/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...input }),
  });
}

/** POST /api/invitations (admin) → invite an employee by email. */
export async function sendInvite(email: string): Promise<void> {
  await request<{ ok: boolean }>("/api/invitations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

/** POST /api/auth/login → email a magic link. Always resolves; no existence leak. */
export async function requestMagicLink(email: string): Promise<void> {
  await request<{ ok: boolean }>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

/** POST /api/auth/verify → exchange a one-time login token for a session + employee. */
export async function verifyMagicLink(token: string): Promise<LoginVerification> {
  return request<LoginVerification>("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

/** GET /api/me → the employee behind a session token, or null when unauthenticated. */
export async function fetchMe(sessionToken: string): Promise<EmployeeRecord | null> {
  const res = await fetch("/api/me", {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (res.status === 401) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return (await res.json()) as EmployeeRecord;
}

/** PUT /api/me → update the signed-in employee's own display_name / logo_url / github_credential. */
export async function updateMe(
  sessionToken: string,
  input: MeUpdateInput,
): Promise<EmployeeRecord> {
  return request<EmployeeRecord>("/api/me", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(input),
  });
}

/** GET /api/employees (Bearer) → the registered employees, for the add-employee entry. */
export async function listEmployees(sessionToken: string): Promise<EmployeeRecord[]> {
  const res = await fetch("/api/employees", {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  const data = (await res.json()) as { employees?: EmployeeRecord[] };
  return data.employees ?? [];
}
