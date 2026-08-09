---
id: s4
title: "G4.S4: Worker progress tracking via ticket-file Progress Log"
layer: S
parent: G4
owner: consultant
status: backlog
milestone: M4
acceptance_criteria:
  - "OpenCode plugin appends a Progress Log row to the ticket md file on a real change (tool ran / status moved)"
  - "KanbanTab shows the last progress row + 'updated Xs ago' and flags stalled (old timestamp while in_progress)"
  - "Progress Log is written locally and NOT committed during work; pushed together with the ticket on completion"
  - "Eng director reads the ticket file for progress; deep-queries the OpenCode session API only when stalled"
---

# G4.S4: Worker progress tracking via ticket-file Progress Log

## Background

OpenCode workers don't update their ticket file during work, so nobody can see progress/stuck without
manually polling the OpenCode session. Make progress readable directly from the ticket md file.

## Full design

See `docs/spec-m4-worker-progress.md`. Key points:

- **Progress Log table at the bottom of each ticket file**: UTC timestamp + status + one-line progress.
- **Written by an OpenCode plugin** (`tool.execute.after` + `session.status`), NOT an AGENTS.md instruction
  (LLM may forget). Append a row ONLY on a real change (a tool ran / status moved) — not a fixed tick; a stale
  last-row timestamp IS the stalled signal.
- **REAL timestamps from the plugin — critical (2026-08-09 observed)**: LLM workers writing the Progress Log
  by hand **fabricate timestamps** — e.g. T1/T2 logs show perfectly regular 5-10-min whole-hour timestamps
  that don't match the actual commit times (T2 done commit 22:44 vs log "21:05 done"). This makes the log
  useless for real monitoring. The plugin MUST stamp the actual wall-clock time at each tool execute, so the
  last-row timestamp genuinely reflects when work last happened.
- **Git strategy**: Progress Log lives in `ticket.md`, written locally (minute-level) + read by the plan agent,
  but NOT committed during work; pushed only with the ticket on completion (keeps history clean).
- **Kanban reads it**: `KanbanTab` shows last row + updated-ago + stalled flag.
- Eng-director workflow: read file first; deep-query session API only when stalled.

## Dependencies

- G4.S5 (Kanban reading the log) is related but separate.

## Deliverables

- OpenCode plugin (tool.execute.after → append Progress Log row, rate-limited).
- Kanban parser reads the Progress Log; KanbanTab shows last row + stalled.
- Git strategy (local write, commit on completion).
