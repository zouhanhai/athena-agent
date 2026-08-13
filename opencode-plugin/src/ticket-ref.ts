/**
 * Ticket-ref parsing for the OpenCode worker plugin (G4.S4.T1).
 *
 * The plugin parses the ticket ref from the first dispatch message (the
 * structured dispatch prompt, git-kanban-design.md §13):
 *
 * ```
 * TICKET: G4.S3.T12
 * PATH: docs/kanban/G4/S3/T12.md
 * ```
 *
 * The ref identifies which ticket a worker session is handling, so the plugin
 * can auto-claim it (git lock) and append Progress Log rows to its md file.
 */

const TICKET_REF = /\bG(\d+)\.S(\d+)\.T(\d+)\b/;
const PATH_REF = /\bG(\d+)\/S(\d+)\/T(\d+)\.md\b/;

/**
 * Extract the ticket ref from arbitrary text (a dispatch message, a PATH line,
 * a ticket body). Accepts both the dot form (`G4.S3.T12`) and the file-path
 * form (`docs/kanban/G4/S3/T12.md`). Returns null when there is no ticket
 * ref — goal/spec refs (G1, G1.S1) are deliberately NOT matches.
 */
export function parseTicketRef(text: string | undefined | null): string | null {
  if (!text) return null;
  const pathHit = text.match(PATH_REF);
  if (pathHit) {
    return `G${pathHit[1]}.S${pathHit[2]}.T${pathHit[3]}`;
  }
  const hit = text.match(TICKET_REF);
  return hit ? `G${hit[1]}.S${hit[2]}.T${hit[3]}` : null;
}
