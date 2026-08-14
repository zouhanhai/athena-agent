import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTicketRef } from "../src/ticket-ref.js";

test("parses the ref from a structured dispatch prompt (TICKET: line)", () => {
  const text = `TICKET: G4.S3.T12
PATH: docs/kanban/G4/S3/T12.md

Implement the thing.`;
  assert.equal(parseTicketRef(text), "G4.S3.T12");
});

test("parses the ref from the PATH line when TICKET: is absent", () => {
  const text = `PATH: docs/kanban/G4/S4/T1.md`;
  assert.equal(parseTicketRef(text), "G4.S4.T1");
});

test("parses a bare ref anywhere in the text", () => {
  assert.equal(parseTicketRef("go claim G2.S1.T7 now"), "G2.S1.T7");
});

test("parses a ref from a full markdown ticket body", () => {
  const text = `# G4.S4.T1 — OpenCode plugin
See Spec docs/kanban/G4/S4/Spec.md for context.`;
  assert.equal(parseTicketRef(text), "G4.S4.T1");
});

test("returns null when there is no ticket ref", () => {
  assert.equal(parseTicketRef("no ticket here"), null);
  assert.equal(parseTicketRef("G4.S4 has no ticket"), null);
  assert.equal(parseTicketRef(""), null);
  assert.equal(parseTicketRef(undefined as unknown as string), null);
});

test("rejects non-ticket refs (goal/spec only)", () => {
  assert.equal(parseTicketRef("TICKET: G4.S4"), null);
  assert.equal(parseTicketRef("G4"), null);
});
