---
id: s5
title: "G4.S5: Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop"
layer: S
parent: G4
owner: consultant
status: backlog
milestone: M4
acceptance_criteria:
  - "Each Spec → a GitHub Issue (title 'Gx.Sx <spec title>', tickets as ## Sub-tasks checklist)"
  - "md is the single source of truth; md → GitHub projects spec as issue + syncs ticket status/assignee/session (not Progress Log detail)"
  - "GitHub → md feedback loop: plan agent reads issue discussion and creates/edits tickets or a new spec back into md"
  - "Sync CLI/tool (board.js-style); human keeps authority; md authoritative on conflict"
---

# G4.S5: Kanban ↔ GitHub Issues bidirectional sync + planning feedback loop

## Background

md files stay the single source of truth for agent work; GitHub Issues are the team discussion surface.
Bidirectional sync with a planning feedback loop (inspired by the ABAPlorer workflow).

## Full design

See `docs/spec-m4-kanban-issues-sync.md`. Key points:

- **md → GitHub (projection)**: each **Spec → one GitHub Issue** (title `Gx.Sx <spec title>` → traces back to
  the md file; body = description + `## Sub-tasks` checklist of its tickets). Ticket state-machine changes +
  assignee/session sync; **Progress Log detail NOT pushed** (stays in md, avoids noise). Sync CLI/tool.
- **GitHub → md (feedback loop)**: team comments/ideas → plan agent reads them → new/edited tickets or a new
  spec back into md (source of truth). Human keeps authority; md authoritative on conflict.
- Reference: ABAPlorer workflow (Caleo private repo WORKFLOW-PROPOSAL.md + scripts/board.js).

## Dependencies

- G4.S4 (Progress Log) — related but separate.

## Deliverables

- Spec → Issue generator (CLI/tool).
- Ticket state/assignee/session sync to the issue.
- Plan-agent feedback loop (read issue discussion → update md).
- md-authoritative conflict handling.
