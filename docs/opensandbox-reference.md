# OpenSandbox — reference for per-user agent isolation + independent keys

**Source**: https://github.com/opensandbox-group/OpenSandbox (Apache-2.0, 13k★, CNCF landscape)
**Studied**: 2026-08-15 (user). Evaluated for giving each athena user an isolated Pi + independent OpenRouter key.

## What it is

**OpenSandbox is a general-purpose sandbox platform for AI applications** — multi-language SDKs, unified
sandbox APIs, and Docker/Kubernetes runtimes for Coding Agents, GUI Agents, Agent Evaluation, AI Code
Execution, and RL Training. Key features:
- SDKs (Python/TS/Kotlin/Go/C#) + `osb` CLI + **MCP** server
- **Credential Vault** — secure outbound credential injection (real secrets stay in an egress sidecar;
  the sandbox process only sees fake/empty keys; the sidecar injects the real auth header on allowed
  outbound HTTPS)
- **Strong isolation** — gVisor / Kata / Firecracker microVM
- **Network policy** — ingress gateway + per-sandbox egress controls
- K8s runtime for large-scale distributed scheduling

## Why relevant to athena (caleo, 50 employees)

athena currently runs all employees' Pi sessions in **one server process** (per-employee session dir,
no container isolation), sharing one OpenRouter key. With ~50 employees, the team wants:
1. **each user an independent Pi** (isolated conversation instance), and
2. **each user an independent OpenRouter key** (cost attribution per employee, cache-hit control).

**OpenSandbox's Credential Vault is the strongest match**: give each user a sandbox that runs their Pi,
bind the user's independent OpenRouter key in the vault, inject it at the egress sidecar on requests to
api.openrouter.ai — real key never enters the sandbox/command line/files/logs (anti-exfiltration vs
prompt injection). K8s runtime scales to 50 sandboxes.

## Capability mapping

| athena need (50 emp) | OpenSandbox |
|---|---|
| 50 independent Pi instances | one sandbox per user |
| 50 independent OpenRouter keys | Credential Vault per-sandbox binding |
| isolation (interference / key exfiltration) | gVisor / Kata / Firecracker |
| large-scale scheduling | Kubernetes runtime |

## Cost / complexity (why it's a M-after item, not now)

- Requires opensandbox-server + egress sidecar + K8s (or Docker) + Credential Vault config.
- Credential Vault requires `dns+nft` egress mode + `defaultAction="deny"` network policy + MITM sidecar.
- Full per-user sandbox refactor of athena's agent architecture (currently single-process Pi sessions).
- For our current scale this is heavy; per-user independent keys (employee table field + per-user
  selection at request time) is the cheap first step for cost attribution/cache control.

## Recommendation

- **Now / cheap**: per-user independent OpenRouter key (add a key field to employees, select per user at
  request time) — solves cost attribution + cache control without sandboxing.
- **M-after (deferred)**: evaluate OpenSandbox (or its Credential Vault pattern) if we need strong
  per-user isolation (multi-user Pi instances + key exfiltration protection at ~50 employees) or agent
  evaluation/RL at scale.
- Track as a future milestone ("per-user agent isolation — evaluate OpenSandbox vs lean per-user keys").
