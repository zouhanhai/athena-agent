import { describe, expect, it } from "vitest";
import { parseTicketMd } from "@/kanban/ticket-md";

const MD = `---
id: G4.S5.T4
title: "G4.S5.T4: Workbench Kanban view toggle"
owner: eng-director
status: in_progress
assignee: opencode
blocked_by:
  - "G4.S5.T2"
---

# G4.S5.T4 — Workbench Kanban view toggle

## Context

S5 syncs md to GitHub. This ticket adds a view toggle.

## Task

1. Backend endpoint.
2. Frontend toggle.

## Acceptance

- Toggle works.

## Progress Log
| UTC timestamp | status | progress |
|---|---|---|
| 2026-08-13T14:21:04.639Z | in_progress | opencode claimed G4.S5.T4 |
| 2026-08-13T15:00:00.000Z | done | acceptance met |

## Log

[2026-08-13] opencode claimed G4.S5.T4
`;

describe("parseTicketMd", () => {
  it("parses the frontmatter key/value pairs", () => {
    const parsed = parseTicketMd(MD);
    expect(parsed.frontmatter.id).toBe("G4.S5.T4");
    expect(parsed.frontmatter.status).toBe("in_progress");
    expect(parsed.frontmatter.assignee).toBe("opencode");
    expect(parsed.frontmatter.owner).toBe("eng-director");
  });

  it("keeps the description (Context/Task/Acceptance) and drops the Progress Log / Log sections", () => {
    const parsed = parseTicketMd(MD);
    expect(parsed.description).toContain("## Context");
    expect(parsed.description).toContain("This ticket adds a view toggle.");
    expect(parsed.description).toContain("- Toggle works.");
    expect(parsed.description).not.toContain("## Progress Log");
    expect(parsed.description).not.toContain("## Log");
  });

  it("extracts the Progress Log rows newest-first and skips the header row", () => {
    const parsed = parseTicketMd(MD);
    expect(parsed.progressLog.length).toBe(2);
    expect(parsed.progressLog[0]).toEqual({
      timestamp: "2026-08-13T14:21:04.639Z",
      status: "in_progress",
      progress: "opencode claimed G4.S5.T4",
    });
    expect(parsed.progressLog[1].status).toBe("done");
  });

  it("handles an md without frontmatter or a Progress Log", () => {
    const parsed = parseTicketMd("# Just a body\n\nNo frontmatter here.");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.progressLog).toEqual([]);
    expect(parsed.description).toContain("No frontmatter here.");
  });

  it("handles empty input", () => {
    const parsed = parseTicketMd("");
    expect(parsed.frontmatter).toEqual({});
    expect(parsed.description).toBe("");
    expect(parsed.progressLog).toEqual([]);
  });
});
