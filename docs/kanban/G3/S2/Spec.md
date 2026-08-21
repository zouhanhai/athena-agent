---
id: g3_s2
title: "G3.S2: Employee Identity + RBAC + GitHub Credentials"
layer: S
parent: G3
owner: pm
status: approved
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

Build employee identity — **invitation-based registration**: the platform sends an invitation email (Resend); the employee clicks through, links their own email, fills in profile + GitHub credential. Plus RBAC, and agents archived under employees.

## Key Dependencies

- G3.S1 (agent registry — agents belong to employees)
- Postgres — employee + credential storage
- Email (Resend) — invitation + magic-link login

## Architecture

```
Employee registration (invitation flow)
  → Platform sends invitation email (Resend) to employee's address
  → Employee clicks link → associates their own email (magic-link verify)
  → Employee fills profile (display name, logo) + GitHub key/token (encrypted)
  → stored in PG: employees table + encrypted github credential
  → RBAC: role per employee (e.g. admin/member)
  → agents: grouped under employee (owner_employee_id from S1)
GitHub: credential scoped to user → GET /api/github/repos shows ONLY what this user can see
```

## UI Placement (Decided)

- **Invitation email** (Resend) → magic-link → employee **registration page** (link email, fill profile + GitHub key)
- Login flow (email magic-link via Resend) — existing M4 auth pattern can be reused/extended
- Logo picker during registration (from S1 generated set or self-upload)

## Implementation

### 1. Employee data model (Postgres)
- `employees` table: id, email, display_name, logo_url, role, created_at
- Role-based access (RBAC): simple role column + permission checks in routes

### 2. Registration (invitation flow)
- **Invite**: admin/owner sends invitation email (Resend) → magic-link with invite token
- **Registration page**: employee clicks link, associates their email (verify), fills profile (display name, logo) + GitHub key/token
- Login: email magic-link (Resend) — reuse existing auth scaffolding
- On login, resolve employee + their agents (from S1)

### 3. GitHub credential
- Employee provides SSH key or token during invitation registration
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
