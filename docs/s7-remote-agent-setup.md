# G4.S7 — Remote agent connectivity: two-part setup

**Status**: planning (2026-08-15). Model = **reverse WebSocket** (agent connects INTO platform; see
`docs/remote-agent-connectivity.md`).
**Split into two independent parts**: (1) platform/server-side + Cloudflare, (2) remote-agent template.

---

## Part 1 — Server side (athena platform, 6900XT) + Cloudflare

### 1.1 Platform: expose an inbound WebSocket endpoint for agents
- athena server exposes a **WebSocket server** endpoint that remote agents connect INTO (outbound).
  Agent initiates the connection + registers `{agent_id, capabilities, token}`; platform keeps the
  tunnel and drives the agent back through it (push tasks, stream tool.started/completed + results).
- This is **G4.S7.T4** (Agent bidirectional connection, reverse WebSocket).

### 1.2 Platform: agent registration (invitation flow)
- Admin generates `{agent_id, api_url, token}` invite → agent registers (auth'd). Capabilities already
  modeled (`AgentCapabilities` + `POST /api/agents/self-declare`). This is **G4.S7.T2**.

### 1.3 Cloudflare: expose the platform WS endpoint publicly
So remote agents (from anywhere) can reach the platform's WS endpoint.

**LIVE (2026-08-15, G4.S7.T1)** — named tunnel `athena-platform` on the **athenakb.com** domain.
The endpoint is `wss://athenakb.com/ws/agent` and is reachable from anywhere (verified from outside
the LAN through the public Cloudflare edge). Config: `/home/hh/.cloudflared/config.yml` on 6900XT,
run as the systemd service `cloudflared-athenakb`:
```yaml
tunnel: b3822b51-f0a9-4cda-8bc3-7b14045ec207
credentials-file: /home/hh/.cloudflared/b3822b51-f0a9-4cda-8bc3-7b14045ec207.json

ingress:
  # Reverse-WebSocket endpoint for remote agents (connect INTO the platform).
  - hostname: athenakb.com
    path: /ws/*
    service: http://localhost:3000        # the athena server (WS endpoint + REST API)
  # Frontend (Vite dev server) — keeps working.
  - hostname: athenakb.com
    service: http://localhost:5173
  - service: http_status:404
```
Restart after a config change: `sudo systemctl restart cloudflared-athenakb`.
Cloudflare Tunnel proxies WebSocket upgrades natively (free, no extra cost).

Alternative options (if a different domain were used):
- **Named Cloudflare Tunnel** (stable, free + a domain) — recommended for production:
  ```bash
  cloudflared tunnel login                     # authorize, pick a domain
  cloudflared tunnel create athena-platform
  cloudflared tunnel route dns athena-platform athena-platform.yourdomain.com
  # config.yml ingress:
  #   - hostname: athena-platform.yourdomain.com
  #     service: http://localhost:<ws-port>     # the athena WS server
  #   - service: http_status:404
  cloudflared tunnel run athena-platform
  ```
- **Quick tunnel** (temporary, no account, for testing):
  ```bash
  cloudflared tunnel --url http://localhost:<ws-port>
  # gives a random trycloudflare.com URL; lasts while the process runs; URL changes on restart
  ```
- Cost: **Cloudflare Tunnel is free** (Zero Trust free tier, 50 seats). Only cost = a **domain**
  ($8–15/yr) hosted on Cloudflare. Named tunnel removes quick-tunnel's 200-concurrent + SSE limits.

**Verify the public WS endpoint** (from a machine NOT on the LAN; the URL resolves to the public
Cloudflare edge, not to 192.168.178.30):
```bash
wscat -c wss://athenakb.com/ws/agent
# → {"type":"welcome","service":"athena-agent-ws","path":"/ws/agent","protocolVersion":1,...}
#   then send {"type":"echo","data":"hi"} → {"type":"echo","data":"hi",...}
```

### 1.4 Platform config
- `APP_BASE_URL` should point at the reachable address so invite/magic links open remotely
  (currently `https://athenakb.com`).
- Remote agents connect to the platform's public WS URL: `wss://athenakb.com/ws/agent`.

---

## Part 2 — Remote agent template (copy this to each remote agent / Hermes)

> Give this to the remote agent operator (e.g. the remote Hermes) as the setup checklist.

---

### Remote agent connect-to-platform template

**Goal**: make this machine's Hermes/agent reachable by the athena platform and register into it.

**Prereqs**:
- Hermes API Server enabled (or an OpenAI-compatible agent API). Here: `127.0.0.1:8642`, model
  `hermes-agent`, Bearer `API_SERVER_KEY`.
- `cloudflared` installed (user-level, no admin needed):
  - Windows: `scoop install cloudflared` or download the binary
  - Linux/macOS: `brew install cloudflared` / apt / download

**Step 1 — Expose your API over Cloudflare (quick, for testing):**
```bash
cloudflared tunnel --url http://127.0.0.1:8642
# prints a public URL, e.g. https://<random>.trycloudflare.com
# NOTE: keep this process running; URL is valid while it runs, changes on restart.
```

**Step 2 — (optional, stable) Named tunnel instead:**
```bash
cloudflared tunnel login
cloudflared tunnel create hermes-agent
cloudflared tunnel route dns hermes-agent hermes-agent.yourdomain.com
# config.yml:
#   tunnel: <tunnel-id>
#   credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
#   ingress:
#     - hostname: hermes-agent.yourdomain.com
#       service: http://localhost:8642
#     - service: http_status:404
cloudflared tunnel run hermes-agent
```

**Step 3 — Register into the athena platform:**
- Send the platform (6900XT admin) your **public URL** (from Step 1/2) + your **API_SERVER_KEY**.
- The platform registers you as an agent `{agent_id, api_url=<public URL>, token=<API_SERVER_KEY>}`
  and your declared capabilities.
- (Or, when the platform WS flow is live: connect your agent into the platform's WS endpoint and
  register `{agent_id, capabilities, token}` there.)

**Verify (from a machine that can reach the public URL, e.g. 6900XT):**
```bash
curl -s https://<public-url>/health            # → {"status":"ok",...}
curl -sN https://<public-url>/v1/chat/completions \
  -H "Authorization: Bearer $API_SERVER_KEY" -H "Content-Type: application/json" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"hi"}],"stream":true}'
# → SSE token stream, ends with data: [DONE]
```

**Keep alive:**
- Run `cloudflared` in the background / as a Windows scheduled task so it restarts on reboot.
- If using a quick tunnel, the URL changes on restart → re-register with the platform (or use a named
  tunnel for a stable URL).

---

## Checklist status

| Piece | Side | Status |
|---|---|---|
| Platform WS endpoint (reverse WebSocket) | server | ✅ done (G4.S7.T1) — `/ws/agent`, handshake + echo |
| Invitation onboarding `{agent_id, api_url, token}` | server | ✅ done (G4.S7.T2) |
| Cloudflare named tunnel config | server/Cloudflare | ✅ done (G4.S7.T1) — `athenakb.com/ws/*` → `localhost:3000` |
| Bidirectional reverse-WS (register auth, task push, tool/delta relay, reconnect) | server | ✅ done (G4.S7.T4) — see `docs/remote-agent-connectivity.md` Status 2026-08-16 |
| Remote agent template (outbound connect + local /v1/chat/completions relay) | remote | ✅ drafted — `server/scripts/agent-client.ts` (G4.S7.T4) |
| Remote Hermes API server | remote | ✅ done (port 8642) |
| Quick tunnel proof | remote | ✅ done (SSE verified) |
