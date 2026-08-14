/**
 * G.S.T board scanner — walks docs/kanban/*.md and constructs the board
 * (Goals → Specs → Tickets, each with typed frontmatter + status).
 */

import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBoardFile } from "./board.js";
import type { GoalFrontmatter, SpecFrontmatter, TicketFrontmatter } from "./schema.js";

/** A scanned ticket node. */
export interface BoardTicket {
  ref: string; // "G1.S1.T1"
  ticket: TicketFrontmatter;
  /** The ticket body (after frontmatter) when the scan asked for it — e.g. for Progress Log parsing. */
  body?: string;
}

/** A scanned spec node, with its child tickets. */
export interface BoardSpec {
  ref: string; // "G1.S1"
  spec: SpecFrontmatter;
  /** The spec body (after frontmatter) when the scan asked for it (G4.S5 projection). */
  body?: string;
  tickets: BoardTicket[];
}

/** A scanned goal node, with its child specs. */
export interface BoardGoal {
  ref: string; // "G1"
  goal: GoalFrontmatter;
  specs: BoardSpec[];
}

/** A board file that could not be parsed; the rest of the board still loads. */
export interface BoardError {
  file: string;
  error: string;
}

/** The constructed kanban board. */
export interface KanbanBoard {
  goals: BoardGoal[];
  errors: BoardError[];
}

const G_DIR = /^G(\d+)$/;
const S_DIR = /^S(\d+)$/;
const T_DIR = /^T(\d+)$/;
const T_FILE = /^T(\d+)\.md$/;

/** Extract the numeric part of G1/S1/T1 names for natural ordering. */
function numericOrder(name: string): number {
  const match = /^([A-Za-z]*)(\d+)$/.exec(name.replace(/\.md$/, ""));
  return match ? Number(match[2]) : 0;
}

/** List entries in a directory, filtered by a predicate; [] when the dir is unreadable. */
async function listEntries(dir: string, test: (entry: Dirent) => boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
  return entries
    .filter(test)
    .map((entry) => entry.name)
    .sort((a, b) => numericOrder(a) - numericOrder(b));
}

/** True for a goal directory name like G3. */
function isGoalDir(entry: Dirent): boolean {
  return entry.isDirectory() && G_DIR.test(entry.name);
}

/** True for a spec directory name like S6. */
function isSpecDir(entry: Dirent): boolean {
  return entry.isDirectory() && S_DIR.test(entry.name);
}

/** True for a ticket file name like T1.md. */
function isTicketFile(entry: Dirent): boolean {
  return entry.isFile() && T_FILE.test(entry.name);
}

/** True for a ticket directory name like T1 (nested T1/T1.md layout). */
function isTicketDir(entry: Dirent): boolean {
  return entry.isDirectory() && T_DIR.test(entry.name);
}

/**
 * List a spec dir's ticket markdown files as absolute paths. Supports both the
 * flat layout (`G/S/T1.md`) and the nested layout (`G/S/T1/T1.md`).
 */
async function listTicketPaths(dir: string): Promise<string[]> {
  const flat = await listEntries(dir, isTicketFile);
  const paths = flat.map((name) => path.join(dir, name));
  const nestedDirs = await listEntries(dir, isTicketDir);
  for (const sub of nestedDirs) {
    const candidate = path.join(dir, sub, `${sub}.md`);
    if (await exists(candidate)) paths.push(candidate);
  }
  return paths.sort((a, b) => numericOrder(path.basename(a)) - numericOrder(path.basename(b)));
}

/** Async existence check (avoids readdir of a whole dir just to test one file). */
async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Return the numeric board root pointing at the repo's docs/kanban. */
export function defaultBoardRoot(): string {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  return path.join(repoRoot, "docs", "kanban");
}

export interface ScanOptions {
  /** Include each ticket's markdown body (e.g. for Progress Log parsing). */
  includeBody?: boolean;
}

/**
 * Walk a board root directory and construct the board. Files that exist but
 * fail to parse are collected in `errors`; the rest of the board still loads.
 */
export async function scanBoard(root: string, options: ScanOptions = {}): Promise<KanbanBoard> {
  const errors: BoardError[] = [];
  const goals: BoardGoal[] = [];

  const goalDirs = await listEntries(root, isGoalDir);

  for (const goalDir of goalDirs) {
    const goalPath = path.join(root, goalDir, "Goal.md");
    let goal: GoalFrontmatter;
    try {
      const content = await readFile(goalPath, "utf8");
      const parsed = parseBoardFile(content);
      if (parsed.frontmatter.layer !== "G") {
        throw new Error(`expected layer: G`);
      }
      goal = parsed.frontmatter as GoalFrontmatter;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // no Goal.md → not a goal
      errors.push({ file: goalPath, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const specs: BoardSpec[] = [];
    const specDirPath = path.join(root, goalDir);
    const specNames = await listEntries(specDirPath, isSpecDir);

    for (const specDir of specNames) {
      const specPath = path.join(root, goalDir, specDir, "Spec.md");
      let spec: SpecFrontmatter;
      let specBody: string | undefined;
      try {
        const content = await readFile(specPath, "utf8");
        const parsed = parseBoardFile(content);
        if (parsed.frontmatter.layer !== "S") {
          throw new Error(`expected layer: S`);
        }
        spec = parsed.frontmatter as SpecFrontmatter;
        specBody = options.includeBody ? parsed.body : undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // no Spec.md → not a spec
        errors.push({ file: specPath, error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      const tickets: BoardTicket[] = [];
      const ticketsPath = path.join(root, goalDir, specDir);
      const ticketPaths = await listTicketPaths(ticketsPath);

      for (const ticketPath of ticketPaths) {
        try {
          const content = await readFile(ticketPath, "utf8");
          const parsed = parseBoardFile(content);
          if (parsed.frontmatter.layer !== "T") {
            throw new Error(`expected layer: T`);
          }
          const ticketName = path.basename(ticketPath, ".md");
          tickets.push({
            ref: `${goalDir}.${specDir}.${ticketName}`,
            ticket: parsed.frontmatter as TicketFrontmatter,
            ...(options.includeBody ? { body: parsed.body } : {}),
          });
        } catch (err) {
          errors.push({ file: ticketPath, error: err instanceof Error ? err.message : String(err) });
        }
      }

      specs.push({
        ref: `${goalDir}.${specDir}`,
        spec,
        ...(specBody !== undefined ? { body: specBody } : {}),
        tickets,
      });
    }

    goals.push({ ref: goalDir, goal, specs });
  }

  return { goals, errors };
}
