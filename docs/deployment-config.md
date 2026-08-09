# Athena Agent — Deployment Configuration (Secrets & Env)

Where every environment secret lives, so it can be re-provisioned on a new server.

## Key locations (6900XT, 192.168.178.30)

| Secret | Location | How it's loaded | Notes |
|--------|----------|-----------------|-------|
| `RESEND_API_KEY` | `server/.env.local` (git-ignored) | `scripts/start-all.sh` does `set -a; . server/.env.local; set +a` | Resend email for magic-link + invitations. **Domain `caleo.com` must be verified in Resend, else 403.** |
| `OPENROUTER_API_KEY` | `~/.bashrc` (base64-encoded command) | `scripts/start-all.sh` `load_openrouter_key()` decodes it | Used by athena-back for docling VLM descriptions + llm_wiki classify |
| Athena refinement OpenRouter key | Pi `~/.pi/agent/auth.json` (as **`athena` provider**) | Pi `ModelRuntime` via `getModel("athena", ...)` | **Dedicated** key for the Athena document-refinement LLM pass (G4.S1) — separate `athena` provider, independent cache/cost from the shared `openrouter` provider |
| `EMBEDDING_OPENROUTER_KEY` | `server/.env.local` (git-ignored) | loaded by `scripts/start-all.sh` | **Dedicated** key for the embedding step — consumed by the G4.S2 self-built RAG interface (not the Pi agent) |
| `DATABASE_URL` | `scripts/start-all.sh` (server block) | `export` in start-all.sh | `postgres://hh:<pass>@127.0.0.1:5432/athena` |
| `ADMIN_EMAIL` | `scripts/start-all.sh` | `export` | Seeds first admin: `zouha108@caleo.com` |
| `APP_BASE_URL` | `scripts/start-all.sh` | `export` | `http://192.168.178.30:5173` |
| PG password | LightRAG `.env` + start-all.sh | | `athena_pg_2026` (shared local PG) |

## Re-provisioning on a new server

`git clone` does NOT bring `.env.local` (git-ignored) or `~/.bashrc` (home file).
After cloning on a new machine:

1. Create `server/.env.local`:
   ```bash
   RESEND_API_KEY=re_xxxx
   EMBEDDING_OPENROUTER_KEY=sk-or-v1-xxxx  # dedicated embedding key (G4.S1), for the RAG interface
   ```
2. Ensure `OPENROUTER_API_KEY` is exported in `~/.bashrc` (or the shell that launches start-all.sh).
3. Add the **dedicated Athena refinement key** as an **`athena` provider** in `~/.pi/agent/auth.json`
   (`{ "athena": { "type": "api_key", "baseUrl": "https://openrouter.ai/api/v1", "key": "sk-or-v1-xxxx" } }`).
3. Set `DATABASE_URL`, `ADMIN_EMAIL`, `APP_BASE_URL` in `scripts/start-all.sh` (edit the export block) — or override in the environment.
4. Verify Resend has the mail domain verified (else 403 on send).
5. `cd server && npm install && npm run dev` (or `bash scripts/start-all.sh`).
6. First run auto-creates the Postgres schema + seeds the admin from `ADMIN_EMAIL`.

## Never commit

- `server/.env.local` is in `.gitignore`.
- Keep `RESEND_API_KEY` / `OPENROUTER_API_KEY` out of any committed file.
