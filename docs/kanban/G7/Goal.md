---
id: G7
title: "G7: Local Desktop App (Athena App) — local agent/worker monitoring, Progress Log + accurate stalled, kanban & issue views"
layer: G
owner: consultant
status: active
created_at: 2026-08-13
acceptance_criteria:
  - "A desktop app (installed, runs on the user's machine) connects to the user's local repos and local agent workers"
  - "The app reads local md / Progress Log directly from the local filesystem → Local kanban shows live Progress Log and ACCURATE stalled (no misjudgment, unlike web which can't read local)"
  - "The app can connect to a local OpenCode serve (session detection) for worker activity"
  - "The app complements the web control plane (S6 remote federation): web = remote collaboration (GitHub Project view), app = local development (Progress Log / stalled / kanban)"
  - "All S5 dataflow-study items (Progress Log sync, stalled signal source, local vs remote) are resolved within this goal"
---

# G7: Local Desktop App (Athena App)

## Background / Context

S5 dataflow study (2026-08-13) found: Local kanban's stalled detection via Progress Log is a good
pattern, but in the **web** model the browser can't read the local filesystem, so a remote worker's
Progress Log never reaches the platform → stalled is misjudged. **Decision: two-tier platform** —
web version (remote collaboration, GitHub Project view, no local Progress Log/stalled) + **app version**
(local development, reads local md/worker, accurate stalled). This goal is the **app version** (Athena App).

## Goal

1. **Desktop app shell** — a cross-platform installable app (e.g. Tauri/Electron) that runs on the
   user's machine, browses local repos, and connects to local agent workers.
2. **Local Progress Log + accurate stalled** — the app reads local md files directly; Local kanban shows
   live Progress Log and correct stalled flags (no misjudgment). Includes the worker activity via a local
   OpenCode serve (session detection).
3. **Local kanban & issue views** — the app renders the local kanban (Progress Log/stalled/goal tree) and
   issue list from the local repo, complementing the web's GitHub Project view.
4. **Web/app parity on shared data** — GitHub Project view + Issues are the same on both (via GitHub),
   so the app and web show consistent board/issue data; only local-only features (Progress Log/stalled)
   are app-specific.

## Confirmed Decisions

- Two-tier: web = remote collaboration (GitHub Project view, no local stalled); app = local development
  (Progress Log + accurate stalled). (2026-08-13)
- Local kanban view is NOT removed — it moves to the app tier (its stalled pattern is valuable there).
- Progress Log stays in md (not committed); the app reads it locally.
- **Single repo + feature flag (2026-08-13)**: web and app share ~90%+ code (same frontend + server), so
  use ONE repo with a runtime/build flag (e.g. `VITE_APP_MODE=web|app` or a build-time switch). web mode
  does not load stalled/Progress Log local logic; app mode does (reads local filesystem). NOT a branch or
  a fork (avoids branch drift / fork duplication).

## Completion Criteria

See frontmatter acceptance_criteria. All Specs under G7 and their Tickets must be approved.
