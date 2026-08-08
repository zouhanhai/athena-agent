# M4 Roadmap — Deferred / Next-Milestone Items

Items discovered during G3 that are **out of scope for G3** but should be picked up in **M4** (or the next milestone).
Each entry notes the problem, context, and suggested approach so it can be implemented later without rediscovery.

## 1. Remote / Tailscale access for out-of-LAN users

**Status:** OPEN — deferred to M4.

**Problem:** The portal runs on 6900XT (192.168.178.30). The invite + magic-link URLs use
`APP_BASE_URL=http://192.168.178.30:5173`, which only works **inside the LAN**.
Colleagues (remote, e.g. in Germany) **cannot reach it** without a private network.

**Options:**
- **Tailscale** (preferred, already used by the team): install/join 6900XT to the team tailnet,
  then set `APP_BASE_URL` to the Tailscale IP (e.g. `http://100.x.x.x:5173`) so generated
  invite/login links point at the reachable address.
- **Tunnel / public ingress**: frp / cloudflared / ngrok → public URL (needs DNS/ports; user
  currently has **no DNS capability**).

**Context:** User lacks DNS setup ability, so Resend domain verification (`caleo.com`) is also blocked
(see below). ConsoleMailer is used meanwhile (links printed to server log).

## 2. Resend domain verification for email delivery

**Status:** OPEN — blocked on user's DNS capability.

**Problem:** `RESEND_API_KEY` is configured (`server/.env.local`) but sending fails with
`403: The caleo.com domain is not verified`. Resend requires verifying the sending domain via DNS.

**Impact:** Until verified, email magic-links + invites use **ConsoleMailer** (links logged to
`~/.athena-tmp/athena-server.log`, `grep invite` / `grep magic-link`). Once DNS is available, verify
`caleo.com` in Resend and the key works automatically (app auto-switches via `RESEND_API_KEY` presence).

## 3. LightRAG full per-stage progress (simplified decision)

**Status:** RESOLVED (G3) — recorded for reference.

**Decision:** LightRAG chunking already includes entity extraction + embedding upsert (inline per chunk),
so the UI shows a **single** `chunking_embedding` step with chunk progress, elapsed time + ETA — instead of
4 separate sub-steps. Backend `LIGHTRAG_STEPS = ["chunking_embedding"]`. (Ticket G3.S5.T4 was superseded by
this simplification; the 4-step ticket is no longer needed.)

## 4. Settings consolidation (done in G3)

**Status:** RESOLVED (G3.S2.T5). Recorded for reference: Settings now has Profile (name/logo/GitHub via
`PUT /api/me`) + Agents management; standalone `/agents` tab + sidebar item removed.

## 5. App-base URL config should come from env, not hardcode

**Status:** OPEN — minor.

**Problem:** `APP_BASE_URL` is hardcoded in `scripts/start-all.sh`. On server migration it must be edited
there (documented in `docs/deployment-config.md`). Consider moving to `server/.env.local` alongside the
other secrets for consistency.

---
See `docs/deployment-config.md` for full key/env locations and re-provisioning steps.
