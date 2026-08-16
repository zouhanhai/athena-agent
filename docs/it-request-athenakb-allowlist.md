# IT Request: Allowlist athenakb.com (blocked as "Unrated")

**Date**: 2026-08-16
**Requester**: Hanhai Zou (zouha108@caleo.com)
**Company**: CALEO Consulting

## Summary

Please allowlist the domain **`athenakb.com`** in the corporate web-content
filter. It is currently blocked as **"Unrated"** (unclassified), which the
filter policy default-blocks. This domain is our company's internal AI agent
platform and needs to be reachable by our own employees and agents.

## What the user sees

Accessing `https://athenakb.com` returns the filter's block page:

```
Access Restricted
Web access is restricted. Please contact the administrator.

Category: Warning
URL: Unrated
https://athenakb.com/
```

## Symptoms observed

| Test | Result |
|---|---|
| `https://google.com` | OK (HTTP 301) |
| `https://1.1.1.1` | OK (HTTP 301) |
| `https://cloudflare.com` | OK (HTTP 200) |
| `https://athenakb.com` | Blocked — TLS connection reset / "Unrated" filter page |
| Browser | Intermittent `ERR_CERT_AUTHORITY_INVALID` (filter SSL interception) |

All other domains work. Only `athenakb.com` is blocked, and it is flagged as
**Unrated** — a newly-registered / not-yet-classified domain.

## Root cause

This is not a certificate, proxy, IPv4/IPv6, or platform issue. The corporate
web-content filter categorizes `athenakb.com` as **Unrated** and its policy
default-blocks unclassified domains.

## Requested action

1. **Add `athenakb.com` (and its subdomains) to the allowlist**, or
2. **Submit `athenakb.com` for re-categorization / rating** so it is no longer
   treated as "Unrated", or
3. **Whitelist the Cloudflare tunnel origin** — the site is served via
   Cloudflare (IPs in Cloudflare's published ranges).

## Background (why we need access)

`athenakb.com` hosts CALEO's **Athena Agent** platform — our internal AI
assistant / multi-agent collaboration system. Engineers access it to:

- Use the company knowledge-base assistant (search, wiki, graph Q&A)
- Register and connect remote coding agents (via WebSocket, `wss://athenakb.com/ws/agent`)
- Route tasks to remote agents through the platform

Blocking it prevents our engineers and agents from using the platform.

## Contact

Hanhai Zou — zouha108@caleo.com
