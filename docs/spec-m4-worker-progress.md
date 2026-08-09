# M4 Spec — Worker progress tracking via ticket-file Progress Log (OpenCode plugin)

**Status**: Planned (2026-08-09) · **Milestone**: M4 · **Owner**: eng-director

## Problem

OpenCode workers don't update their ticket file during work, so nobody (human or Kanban) can see
whether a worker is progressing, stuck, or blocked without manually poking the OpenCode session
(`/session/{id}/message`) and asking. This is the recurring "monitor it for me" pain.

## Goal

Make progress readable **directly from the ticket md file**, so Kanban (and humans) can tell at a
glance whether a worker is making progress, is stuck, or had a new milestone — no polling of OpenCode.

## Design: a Progress Log table at the bottom of each ticket file

Each ticket md (`docs/kanban/G*/S*/T*.md`) gets an auto-updated **Progress Log** section at the bottom:

```
## Progress Log
| Timestamp (UTC) | Status | Progress |
|-----------------|--------|----------|
| 2026-08-09 12:00:00Z | in_progress | Reading code, understood ticket |
| 2026-08-09 12:01:00Z | in_progress | Implementing shared repo selector |
| 2026-08-09 12:02:00Z | in_progress | Fixed code scroll CSS |
```

- **Timestamp** is UTC (matches the OpenCode server logs — do NOT mix timezones).
- **Status** mirrors the ticket state-machine (backlog / in_progress / done / in_review / ...).
- **Progress** = one short line of what the worker is currently doing.
- The most recent row is the source of truth for "current progress".

## Write mechanism (reliable, not LLM self-discipline)

**OpenCode Plugin** (`@opencode-ai/plugin`), not an AGENTS.md instruction (LLM may forget).

- Hook **`tool.execute.after`**: after each tool call, derive a one-line progress note
  (e.g. which file was edited / command run) and append a row to the active ticket's Progress Log.
- Hook **`session.status` / `session.idle` / `message.*`**: update status (e.g. idle → maybe blocked,
  new assistant message → progressing).
- Rate-limit to ~1 row/minute so it doesn't spam the table.
- The plugin knows which ticket it's working on (from the claim in AGENTS.md / the dispatch prompt).

## Read mechanism (Kanban)

- Kanban parser (`server/src/kanban/scan.ts`) already reads ticket frontmatter; extend it to also read
  the **Progress Log** section → expose `progress_log` (last row / last N rows) + `last_updated_at`.
- `KanbanTab` shows the last progress row + "updated Xs ago"; flag a ticket as **stalled** when
  `last_updated_at` is old relative to now (threshold, e.g. > 2–3 min) while status is in_progress.
- The refresh button re-scans (already planned in G3.S4.T5).

## Open items (M4)

- Plugin deployment: workers run `opencode serve` on 6900XT — plugin must be installed/enabled there.
- How the plugin learns the current ticket ref (from dispatch prompt / session metadata / AGENTS.md).
- Rate-limiting + debounce; avoid writing to the wrong file (only the claimed ticket).
- Fallback if plugin unavailable (AGENTS.md "update every minute" as best-effort).

## Reference

- OpenCode plugins: `tool.execute.after`, `session.status`, `session.idle` (see opencode.ai docs).
- `server/src/kanban/scan.ts` (ticket parsing), `web/src/components/KanbanTab.vue`, `web/src/api/kanban.ts`.
- Ticket dispatch: POST `/session/{id}/prompt_async` on 6900XT `opencode serve :4096`.
