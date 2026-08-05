# Dialogue Structure: Individual AgentSession per Person + Shared Pi for Team (Evolving to Plan B)

Personal conversations = one independent AgentSession per employee (long-lived); team conversations = one shared AgentSession. The ultimate goal, Plan B: Pi acts as a speakable team member, communicating via pi-intercom.

**Context**: Requires personal conversation isolation + team collaboration conversations. The dialogue structure affects the number of AgentSessions and the messaging architecture.

**Decision**: POC uses Plan A (Pi as assistant): personal = independent AgentSession, team = shared Pi. The architecture reserves Plan B (Pi can speak): team messages use a unified event stream, and Pi joins by adding a subscriber.

**Consequences**: The POC is simple and clear (one long-lived AgentSession per employee). Plan B requires evolving team conversations from a "message stream" to an "event bus," with Pi joining as a subscriber.
