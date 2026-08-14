---
id: g3_s7
title: "G3.S7: Frontend Polish (Theme Toggle Animation + Design Audit)"
layer: S
parent: G3
owner: pm
status: done
milestone: M3
acceptance_criteria:
  - "Theme toggle with animation: deep (dark) theme shows stars + moon, light theme shows sun + cloud, animated on switch, slider placed under the settings button"
  - "Animations follow emilkowalski/skills (animate): ease-out, crossfade, <300ms, prefers-reduced-motion respected"
  - "Frontend fully audited with taste-skill (redesign-existing-projects / design-taste-frontend) and improved per findings"
---

# G3.S7: Frontend Polish (Theme Toggle Animation + Design Audit)

## Task

Polish the athena frontend: (1) add an animated theme-toggle control (deep = stars + moon, light = sun + cloud) as a slider under the settings button, and (2) run a taste-skill design audit across the whole frontend and improve per its findings.

## Key Dependencies

- Existing theme store (deep/light) + Settings button in the sidebar
- Skills installed: emilkowalski/skills (animate/emil-design-eng) + leonxlnx/taste-skill (design-taste-frontend / redesign-existing-projects / minimalist-ui)

## UI Placement (Decided)

- **Theme toggle**: a slider directly under the Settings button (not buried in the settings panel)
- Deep (dark) theme state shows **stars + moon** icon; light theme shows **sun + cloud**
- Toggling animates the icon (crossfade / morph between sun-moon and cloud-stars)
- Global Chat / Workbench / Uploads pages all reflect the same theme

## Implementation

### 1. Animated theme toggle (T1)
- Slider under the Settings button in the sidebar
- Deep = stars + moon; light = sun + cloud (icon swap with animation)
- Use emilkowalski `animate` skill: CSS transition (crossfade), ease-out curve (`cubic-bezier(0.23,1,0.32,1)`), duration 150-250ms, respect `prefers-reduced-motion`
- Wire to existing theme store

### 2. Taste-skill frontend audit (T2)
- Run `redesign-existing-projects` / `design-taste-frontend` (leonxlnx/taste-skill) across the whole frontend (Chat panel, Workbench, Uploads, Wiki, Knowledge, sidebar)
- Collect findings (layout/typography/spacing/hierarchy/anti-slop)
- Implement prioritized improvements

## Reference

- `docs/kanban/G3/Goal.md`
- `docs/g3-requirements.md` (UI: global chat, workbench, uploads, sidebar)
- Skills: emilkowalski/skills (`animate`, `emil-design-eng`), leonxlnx/taste-skill (`design-taste-frontend`, `redesign-existing-projects`)
- CALEO brand: primary orange #ff6633, dark blue #2d3142, light #bfc0c0, sky #69b3e7, white

## Dependencies

- Theme store (existing), Skills (installed), G3.S3 global chat (theme reflected)

## Log
