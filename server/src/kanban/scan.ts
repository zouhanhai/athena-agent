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
import type { GithubCredential } from "../employees/employees.js";
import type { GithubFileContent, GithubTreeEntry } from "../github/client.js";

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

/** Abstraction the kanban route consumes, so it can be faked in tests. */
export interface BoardScanner {
  scan(): Promise<KanbanBoard>;
}

const G_DIR = /^G(\d+)$/;
const S_DIR = /^S(\d+)$/;
const T_FILE = /^T(\d+)\.md$/;

/** Board files live under docs/kanban/ in a repo. */
const BOARD_ROOT = "docs/kanban/";

/** Extract the numeric part of G1/S1/T1 names for natural ordering. */
function numericOrder(name: string): number {
  const match = /^([A-Za-z]*)(\d+)$/.exec(name.replace(/\.md$/, ""));
  return match ? Number(match[2]) : 0;
}

/** GitHub read access a remote board scan needs (structurally satisfied by GitHubApi). */
export interface RemoteBoardSource {
  listTree(
    credential: GithubCredential,
    owner: string,
    repo: string,
    ref?: string,
  ): Promise<GithubTreeEntry[]>;
  getFileContent(
    credential: GithubCredential,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GithubFileContent>;
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
      try {
        const content = await readFile(specPath, "utf8");
        const parsed = parseBoardFile(content);
        if (parsed.frontmatter.layer !== "S") {
          throw new Error(`expected layer: S`);
        }
        spec = parsed.frontmatter as SpecFrontmatter;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // no Spec.md → not a spec
        errors.push({ file: specPath, error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      const tickets: BoardTicket[] = [];
      const ticketsPath = path.join(root, goalDir, specDir);
      const ticketNames = await listEntries(ticketsPath, isTicketFile);

      for (const ticketFile of ticketNames) {
        const ticketPath = path.join(root, goalDir, specDir, ticketFile);
        try {
          const content = await readFile(ticketPath, "utf8");
          const parsed = parseBoardFile(content);
          if (parsed.frontmatter.layer !== "T") {
            throw new Error(`expected layer: T`);
          }
          tickets.push({
            ref: `${goalDir}.${specDir}.${ticketFile.slice(0, -3)}`,
            ticket: parsed.frontmatter as TicketFrontmatter,
            ...(options.includeBody ? { body: parsed.body } : {}),
          });
        } catch (err) {
          errors.push({ file: ticketPath, error: err instanceof Error ? err.message : String(err) });
        }
      }

      specs.push({ ref: `${goalDir}.${specDir}`, spec, tickets });
    }

    goals.push({ ref: goalDir, goal, specs });
  }

  return { goals, errors };
}

/** File-backed scanner rooted at a board directory (default: repo docs/kanban). */
export class FileBoardScanner implements BoardScanner {
  constructor(private readonly root: string) {}
  scan(): Promise<KanbanBoard> {
    return scanBoard(this.root);
  }
}

/**
 * Scan a remote repo's docs/kanban via the employee's GitHub credential.
 * Mirrors scanBoard but walks the GitHub recursive tree and reads each board
 * file through getFileContent, reusing the same parsing. The ticket status /
 * assignee / session_id come straight from each file's frontmatter.
 */
export async function scanRemoteBoard(
  github: RemoteBoardSource,
  credential: GithubCredential,
  owner: string,
  repo: string,
  ref?: string,
  options: ScanOptions = {},
): Promise<KanbanBoard> {
  const tree = await github.listTree(credential, owner, repo, ref);
  const entries = new Map<string, GithubTreeEntry>();
  for (const entry of tree) {
    if (entry.path.startsWith(BOARD_ROOT)) {
      entries.set(entry.path, entry);
    }
  }

  const errors: BoardError[] = [];
  const goals: BoardGoal[] = [];

  const goalNames = [...entries.values()]
    .filter((e) => e.type === "tree")
    .map((e) => e.path.slice(BOARD_ROOT.length))
    .filter((rel) => G_DIR.test(rel) && !rel.includes("/"))
    .sort((a, b) => numericOrder(a) - numericOrder(b));

  for (const goalName of goalNames) {
    const goalPath = `${BOARD_ROOT}${goalName}/Goal.md`;
    if (!entries.has(goalPath)) continue; // no Goal.md → not a goal
    let goal: GoalFrontmatter;
    try {
      const file = await github.getFileContent(credential, owner, repo, goalPath, ref);
      const parsed = parseBoardFile(file.content);
      if (parsed.frontmatter.layer !== "G") {
        throw new Error("expected layer: G");
      }
      goal = parsed.frontmatter as GoalFrontmatter;
    } catch (err) {
      errors.push({ file: goalPath, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const specs: BoardSpec[] = [];
    const specNames = [...entries.values()]
      .filter((e) => e.type === "tree")
      .map((e) => e.path.slice(BOARD_ROOT.length))
      .filter((rel) => {
        const parts = rel.split("/");
        return parts.length === 2 && parts[0] === goalName && S_DIR.test(parts[1]);
      })
      .map((rel) => rel.split("/")[1])
      .sort((a, b) => numericOrder(a) - numericOrder(b));

    for (const specName of specNames) {
      const specPath = `${BOARD_ROOT}${goalName}/${specName}/Spec.md`;
      if (!entries.has(specPath)) continue; // no Spec.md → not a spec
      let spec: SpecFrontmatter;
      try {
        const file = await github.getFileContent(credential, owner, repo, specPath, ref);
        const parsed = parseBoardFile(file.content);
        if (parsed.frontmatter.layer !== "S") {
          throw new Error("expected layer: S");
        }
        spec = parsed.frontmatter as SpecFrontmatter;
      } catch (err) {
        errors.push({ file: specPath, error: err instanceof Error ? err.message : String(err) });
        continue;
      }

      const tickets: BoardTicket[] = [];
      const ticketPaths = [...entries.keys()]
        .filter((entryPath) => {
          const rel = entryPath.slice(BOARD_ROOT.length);
          const parts = rel.split("/");
          return parts.length === 3 && parts[0] === goalName && parts[1] === specName && T_FILE.test(parts[2]);
        })
        .sort((a, b) => numericOrder(a.split("/").pop() ?? "") - numericOrder(b.split("/").pop() ?? ""));

      for (const ticketPath of ticketPaths) {
        try {
          const file = await github.getFileContent(credential, owner, repo, ticketPath, ref);
          const parsed = parseBoardFile(file.content);
          if (parsed.frontmatter.layer !== "T") {
            throw new Error("expected layer: T");
          }
          const rel = ticketPath.slice(BOARD_ROOT.length);
          const parts = rel.split("/");
          tickets.push({
            ref: `${parts[0]}.${parts[1]}.${parts[2].slice(0, -3)}`,
            ticket: parsed.frontmatter as TicketFrontmatter,
            ...(options.includeBody ? { body: parsed.body } : {}),
          });
        } catch (err) {
          errors.push({ file: ticketPath, error: err instanceof Error ? err.message : String(err) });
        }
      }

      specs.push({ ref: `${goalName}.${specName}`, spec, tickets });
    }

    goals.push({ ref: goalName, goal, specs });
  }

  return { goals, errors };
}
