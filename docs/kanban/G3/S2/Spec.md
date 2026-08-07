---
id: g3_s2
title: "G3.S2: Employee Identity + RBAC + GitHub Credentials"
layer: S
parent: G3
owner: pm
status: active
milestone: M3
acceptance_criteria:
  - "Employee table in PG: email login, display name, logo, role"
  - "RBAC: role-based access control per employee"
  - "GitHub credential (SSH key or token) provided at registration, stored encrypted in PG"
  - "GitHub visibility scoped to the signed-in user's permission (repos they can see)"
  - "Agents archived/grouped under their owning employee"
---

# G3.S2: Employee Identity + RBAC + GitHub Credentials

## Task

Build employee identity — email login, pick a logo, RBAC, and per-user GitHub credential (SSH/token) stored securely. Agents are archived under employees. GitHub visibility is driven by each user's own credential.

## Key Dependencies

- G3.S1 (agent registry — agents belong to employees)
- Postgres — employee + credential storage
- Email (Resend) — login flow

## Architecture

```
Employee (email login)
  → register: POST /api/auth/register { email, name, logo, github_token/ssh }
  → stored in PG: employees table + encrypted github credential
  → RBAC: role per employee (e.g. admin/member)
  → agents: grouped under employee (owner_employee_id from S1)
GitHub: credential scoped to user → GET /api/github/repos shows ONLY what this user can see
```

## UI Placement (Decided)

- Login flow (email magic-link via Resend) — existing M4 auth pattern can be reused/extended
- Logo picker during registration (from S1 generated set or self-upload)

## Implementation

### 1. Employee data model (Postgres)
- `employees` table: id, email, display_name, logo_url, role, created_at
- Role-based access (RBAC): simple role column + permission checks in routes

### 2. Login
- Email magic-link (Resend) — reuse existing auth scaffolding
- On login, resolve employee + their agents (from S1)

### 3. GitHub credential
- Employee provides SSH key or token at registration
- Stored **encrypted** in PG (never plaintext)
- Used by S6 GitHub ops, scoped to this user

### 4. Agents archived under employee
- Agent registration (S1) links `owner_employee_id` → employee; query agents by employee

## Reference

- Spec: `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §3 (employee login + RBAC) + §4.1 (GitHub per-user credential)

## How to Locate Reference Docs

- `parent: G3` → `docs/kanban/G3/Goal.md`
- Requirements: `docs/g3-requirements.md` §3, §4.1

## Notes

- GitHub credential **must** be encrypted at rest
- RBAC is simple role-based (G3 POC); fine-grained can come later
- Use **implement** + tdd + code-review

## Dependencies

- G3.S1 (agents), Resend (email), Postgres

## Log
