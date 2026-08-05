# Resend Email Magic Link Authentication

Authentication uses email magic links, sent via the Resend API.

**Context**: The company email is Outlook (Microsoft 365), but SMTP AUTH is disabled by the tenant (both regular passwords and app passwords return 535). Sending via the company SMTP is not possible.

**Decision**: Use the Resend API to send magic links (key verified working). This bypasses Outlook SMTP restrictions, the free tier is sufficient for POC, and it does not depend on corporate IT.

**Consequences**: The caleo.com domain must be verified in Resend before sending to employees; during the POC phase, emails can only be sent to oneself (zouhanhai@live.com).
