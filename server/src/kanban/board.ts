/**
 * G.S.T board helpers — path resolution + read/write for the git-driven kanban
 * md files under docs/kanban/.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseBoardMd, renderBoardMd } from "./frontmatter.js";
import {
  parseBoardFrontmatter,
  type BoardFrontmatter,
  type TicketFrontmatter,
} from "./schema.js";

/** A parsed G.S.T reference: G3 → goal, G3.S6 → spec, G3.S6.T1 → ticket. */
export interface BoardRef {
  g: string;
  s?: string;
  t?: string;
}

const G = /^G(\d+)$/;
const S = /^S(\d+)$/;
const T = /^T(\d+)$/;

/** Split "G3.S6.T1" into { g, s, t }. Throws on malformed refs. */
export function parseRef(ref: string): BoardRef {
  const parts = ref.split(".");
  if (parts.length < 1 || parts.length > 3 || !G.test(parts[0])) {
    throw new Error(`invalid board ref "${ref}": expected G1, G1.S1 or G1.S1.T1`);
  }
  const out: BoardRef = { g: parts[0] };
  if (parts.length >= 2) {
    if (!S.test(parts[1])) {
      throw new Error(`invalid board ref "${ref}": expected S1 as the second part`);
    }
    out.s = parts[1];
  }
  if (parts.length === 3) {
    if (!T.test(parts[2])) {
      throw new Error(`invalid board ref "${ref}": expected T1 as the third part`);
    }
    out.t = parts[2];
  }
  return out;
}

const DEFAULT_BOARD_ROOT = "docs/kanban";

/**
 * Map a ref to its board file path. Goal → `G{N}/Goal.md`, Spec →
 * `G{N}/S{N}/Spec.md`, Ticket → `G{N}/S{N}/T{N}.md`.
 */
export function refToPath(ref: string, root: string = DEFAULT_BOARD_ROOT): string {
  const parsed = parseRef(ref);
  const goalDir = path.join(root, parsed.g);
  if (!parsed.s) return path.join(goalDir, "Goal.md");
  const specDir = path.join(goalDir, parsed.s);
  if (!parsed.t) return path.join(specDir, "Spec.md");
  return path.join(specDir, `${parsed.t}.md`);
}

/** A board md file: typed frontmatter + markdown body, plus its ref/path. */
export interface BoardFileBase {
  ref: string;
  frontmatter: BoardFrontmatter;
  body: string;
}

/** A board file resolved to its on-disk path. */
export interface BoardFile extends BoardFileBase {
  path: string;
}

/** A parsed board document without path resolution (in-memory). */
export interface ParsedBoardFile {
  frontmatter: BoardFrontmatter;
  body: string;
}

/** Parse board md content into typed frontmatter + body. */
export function parseBoardFile(content: string): ParsedBoardFile {
  const { frontmatter, body } = parseBoardMd(content);
  return { frontmatter: parseBoardFrontmatter(frontmatter), body };
}

/** Read + parse a board file by ref from the given board root. */
export async function readBoardFile(root: string, ref: string): Promise<BoardFile> {
  const filePath = refToPath(ref, root);
  const content = await readFile(filePath, "utf8");
  const { frontmatter, body } = parseBoardFile(content);
  return { ref, path: filePath, frontmatter, body };
}

/** A ticket document ready to be written (frontmatter + body). */
export interface TicketDocument {
  ref: string;
  frontmatter: TicketFrontmatter;
  body: string;
}

/**
 * Write a board file, creating parent directories as needed. Accepts a full
 * BoardFile (with a path) or a TicketDocument (path derived from ref).
 */
export async function writeBoardFile(root: string, doc: BoardFileBase | TicketDocument): Promise<string> {
  const filePath =
    "path" in doc && typeof doc.path === "string" && doc.path ? doc.path : refToPath(doc.ref, root);
  const rendered = renderBoardMd({ ...doc.frontmatter }, doc.body);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, rendered, "utf8");
  return filePath;
}

/** Write a ticket document to its ref-derived path. */
export async function writeTicketFile(root: string, doc: TicketDocument): Promise<string> {
  return writeBoardFile(root, doc);
}
