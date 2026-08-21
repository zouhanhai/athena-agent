/**
 * Single source of truth for the KB code-intake channels (G4.S8.T10).
 *
 * Both the WS `registered` handshake contract (server/src/ws/agent.ts) and the
 * ingestion route validation (server/src/routes/kb.ts) derive from this ONE
 * constant, so adding a future channel kind (e.g. a new narrow-domain intake)
 * automatically updates the handshake contract the remote agent learns from the
 * wire — no protocol guessing, no drift between what the agent is told and what
 * the server accepts.
 */

/** HTTP endpoint every code channel posts to. */
export const INTAKE_ENDPOINT = "/api/kb/ingest";

export interface IntakeChannel {
  /** Channel/kind discriminator — maps to `kind` in the POST /api/kb/ingest body. */
  kind: "cds" | "abap" | "ui5" | "ddic";
  method: "POST";
  /** HTTP endpoint to POST the source to (with `kind` in the JSON body). */
  endpoint: string;
  /** Body fields the server rejects the request without (400 when missing). */
  requiredFields: string[];
  /** Optional body fields folded into the wiki frontmatter (provenance). */
  optionalFields: string[];
  /** What the 202 response carries (an async ingest task id to poll). */
  returns: Record<string, string>;
}

export const INTAKE_CHANNELS: readonly IntakeChannel[] = [
  {
    kind: "cds",
    method: "POST",
    endpoint: INTAKE_ENDPOINT,
    requiredFields: ["content"],
    optionalFields: ["filename", "system", "devclass", "transport"],
    returns: { taskId: "async ingest task id; poll GET /api/kb/task/:id" },
  },
  {
    kind: "abap",
    method: "POST",
    endpoint: INTAKE_ENDPOINT,
    requiredFields: ["content"],
    optionalFields: ["filename", "system", "devclass", "transport"],
    returns: { taskId: "async ingest task id; poll GET /api/kb/task/:id" },
  },
  {
    kind: "ui5",
    method: "POST",
    endpoint: INTAKE_ENDPOINT,
    requiredFields: ["files"],
    optionalFields: ["filename", "component", "system", "devclass", "transport"],
    returns: { taskId: "async ingest task id; poll GET /api/kb/task/:id" },
  },
  {
    kind: "ddic",
    method: "POST",
    endpoint: INTAKE_ENDPOINT,
    requiredFields: ["content"],
    optionalFields: ["filename", "system", "devclass", "transport"],
    returns: { taskId: "async ingest task id; poll GET /api/kb/task/:id" },
  },
];
