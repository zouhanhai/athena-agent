import { readdir, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { defaultRefinementOutputDir } from "../agents/refine-document.js";
import type { ReviewReport } from "./review.js";
import type { KbCommunityQuality } from "./community-maintenance.js";
import type {
  KbAuditFileCheck,
  KbAuditOrphanSweep,
  KbAuditRunRecord,
  KbAuditRunsStore,
  KbAuditTrigger,
} from "./audit-runs.js";

/** A week — the audit cadence window (restart dedup + missed-window catch-up). */
export const WEEK_MS = 7 * 86_400_000;

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// --- env parsing -------------------------------------------------------------

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** KB_AUDIT_DAY → 0 (sunday) .. 6 (saturday); name or number, garbage → 0. */
export function parseDayOfWeek(raw: string | undefined): number {
  if (!raw) return 0;
  const trimmed = raw.trim().toLowerCase();
  const byName = DAY_NAMES.findIndex((name) => name === trimmed || name.slice(0, 3) === trimmed);
  if (byName >= 0) return byName;
  const numeric = Number(trimmed);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 6 ? numeric : 0;
}

/** KB_AUDIT_HOUR → 0..23 local time; invalid/garbage → 3. */
export function parseHour(raw: string | undefined): number {
  if (!raw) return 3;
  const numeric = Number(raw.trim());
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 23 ? numeric : 3;
}

/**
 * The next occurrence of the configured weekday + hour STRICTLY after `now`
 * (local time). Same-day-after-the-hour rolls to next week so a run never
 * duplicates within its own window.
 */
export function computeNextRun(now: Date, schedule: { day: number; hour: number }): Date {
  const candidate = new Date(now);
  candidate.setHours(schedule.hour, 0, 0, 0);
  while (candidate.getDay() !== schedule.day || candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

// --- graph port --------------------------------------------------------------

/** Result shape of the T14 cascade primitive (`Neo4jDeleteDocumentsResult`). */
export interface KbAuditCascadeResult {
  documentsRemoved: number;
  chunksRemoved: number;
  sectionsRemoved: number;
  entitiesRemoved: number;
  entitiesRetained: number;
  mdRefs: string[];
}

/**
 * The graph surface the audit needs. `Neo4jIngestService` satisfies it
 * structurally (T14 cascade + two read-only listing helpers).
 */
export interface KbAuditGraphPort {
  /** Distinct wiki-page paths known to the graph (WikiPage nodes). */
  listWikiPagePaths(): Promise<string[]>;
  /** All Document.md_ref values currently referenced by graph documents. */
  listMdRefs(): Promise<string[]>;
  /** T14 cascade: remove the stale subtree behind a wiki page path. */
  deleteDocumentsForWikiPage(input: { wikiPath: string; stem: string }): Promise<KbAuditCascadeResult>;
}

// --- service -----------------------------------------------------------------

export class KbAuditAlreadyRunningError extends Error {
  constructor() {
    super("a knowledge-base audit is already running");
    this.name = "KbAuditAlreadyRunningError";
  }
}

export interface KbAuditServiceOptions {
  /** Stage-1 review pass — the existing G4.S3.T2 reviewAll service. */
  review: Pick<import("./review.js").KbReviewService, "reviewAll">;
  /** Report persistence (also feeds the scheduler's last-run state). */
  runsStore: KbAuditRunsStore;
  /** Graph store for stage-2 repairs + stage-3 md_ref protection. Optional —
   *  without it stage 2 reports a skip note and stage 3 never deletes. */
  graph?: KbAuditGraphPort;
  /** Local wiki pages dir (the `wiki/` root). */
  wikiDir?: string;
  /** Refinement output root. Default: REFINEMENT_OUTPUT_DIR / ~/athena-data/refinement. */
  refinementRoot?: string;
  /** Orphan grace period in hours. Default: KB_ORPHAN_GRACE_HOURS or 48. */
  graceHours?: number;
  /** G4.S9.T4 community-quality snapshot source (KbCommunityMaintenanceService).
   *  Optional — without it the report simply has no communities block. */
  communities?: { quality(): Promise<KbCommunityQuality> };
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable recursive-remove (tests). */
  rmDir?: (path: string) => Promise<void>;
}

interface WikiWalkResult {
  /** Project-relative page paths ("wiki/<rel>.md"). */
  paths: Set<string>;
  error?: string;
}

/**
 * The weekly knowledge-base audit pipeline (G4.S8.T15):
 *
 * 1. Review/confidence — the existing reviewAll over every wiki page.
 * 2. File re-check — WikiPage nodes vs disk *.md, both directions; stale
 *    graph subtrees repaired via the T14 cascade, missing graph records only
 *    reported (never auto-ingested).
 * 3. Orphan refinement sweep — dirs older than the grace period that no
 *    Document.md_ref references and that have no same-stem live wiki page.
 *
 * One run = one persisted report row. Concurrent invocations are rejected.
 */
export class KbAuditService {
  private readonly review: KbAuditServiceOptions["review"];
  private readonly runsStore: KbAuditRunsStore;
  private readonly graph?: KbAuditGraphPort;
  private readonly communities?: KbAuditServiceOptions["communities"];
  private readonly wikiDir?: string;
  private readonly refinementRoot: string;
  private readonly graceHours: number;
  private readonly nowImpl: () => Date;
  private readonly rmDirImpl: (path: string) => Promise<void>;
  private running = false;

  constructor(options: KbAuditServiceOptions) {
    this.review = options.review;
    this.runsStore = options.runsStore;
    this.graph = options.graph;
    this.communities = options.communities;
    this.wikiDir = options.wikiDir;
    this.refinementRoot = resolve(
      options.refinementRoot ?? process.env.REFINEMENT_OUTPUT_DIR ?? defaultRefinementOutputDir(),
    );
    const envGrace = Number(process.env.KB_ORPHAN_GRACE_HOURS);
    this.graceHours =
      options.graceHours ??
      (Number.isFinite(envGrace) && envGrace > 0 ? envGrace : 48);
    this.nowImpl = options.now ?? (() => new Date());
    this.rmDirImpl =
      options.rmDir ?? ((path: string) => rm(path, { recursive: true, force: true }));
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Run all three stages once and persist the report row. */
  async run(trigger: KbAuditTrigger): Promise<KbAuditRunRecord> {
    if (this.running) throw new KbAuditAlreadyRunningError();
    this.running = true;
    const startedAt = this.nowImpl();
    try {
      const review = await this.review.reviewAll({});
      const fileCheck = await this.checkFiles();
      const orphans = await this.sweepOrphans(fileCheck.details);
      // G4.S9.T4 stage 4 — community-quality snapshot, reported alongside the
      // orphan checks. Read-only; a failing read degrades to a details line.
      let communities: KbCommunityQuality | undefined;
      if (this.communities) {
        try {
          communities = await this.communities.quality();
        } catch (err) {
          fileCheck.details.push(
            `community-quality section skipped: ${messageOf(err)}`,
          );
        }
      }
      const end = this.nowImpl();
      const record: KbAuditRunRecord = {
        id: `kbaudit-${startedAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
        trigger,
        startedAt: startedAt.toISOString(),
        durationMs: Math.max(0, end.getTime() - startedAt.getTime()),
        review,
        fileCheck,
        orphans,
        ...(communities ? { communities } : {}),
      };
      await this.runsStore.insert(record);
      return record;
    } finally {
      this.running = false;
    }
  }

  /**
   * Stage 2 — every WikiPage node's path must exist on disk and every wiki
   * *.md file must have a WikiPage node. Stale graph subtree → T14 cascade
   * repair. Missing graph record → report line only (no auto-ingest).
   */
  private async checkFiles(): Promise<KbAuditFileCheck> {
    const details: string[] = [];
    let repaired = 0;

    const disk = await this.walkWikiPages();
    if (disk.error) details.push(`disk wiki scan skipped: ${disk.error}`);
    let graphPaths: Set<string> | undefined;
    if (this.graph) {
      try {
        graphPaths = new Set(await this.graph.listWikiPagePaths());
      } catch (err) {
        details.push(`graph listing failed: ${messageOf(err)}`);
      }
    } else {
      details.push("graph store unavailable — file re-check limited to reporting");
    }

    // Stale graph nodes: the page is gone from disk → remove the subtree.
    if (graphPaths && !disk.error) {
      for (const path of graphPaths) {
        if (disk.paths.has(path)) continue;
        if (!path.startsWith("wiki/") || !path.endsWith(".md")) continue;
        try {
          const cascade = await this.graph!.deleteDocumentsForWikiPage({
            wikiPath: path,
            stem: basename(path).replace(/\.md$/i, ""),
          });
          repaired += 1;
          details.push(
            `stale graph subtree removed: ${path} ` +
              `(documents=${cascade.documentsRemoved}, chunks=${cascade.chunksRemoved}, ` +
              `sections=${cascade.sectionsRemoved})`,
          );
        } catch (err) {
          details.push(`stale graph repair FAILED: ${path}: ${messageOf(err)}`);
        }
      }

      // Missing graph records: on disk but not in the graph — report only.
      for (const path of disk.paths) {
        if (graphPaths.has(path)) continue;
        details.push(`missing graph record (not auto-ingested): ${path}`);
      }
    }

    return { repaired, details };
  }

  /**
   * Stage 3 — delete a refinement dir iff age > grace AND no Document.md_ref
   * references inside it AND no live wiki page shares its stem. Without a
   * graph source the reference check cannot run, so nothing is ever deleted
   * (in-flight ingests stay protected by construction).
   */
  private async sweepOrphans(details: string[]): Promise<KbAuditOrphanSweep> {
    const out: KbAuditOrphanSweep = { scannedDirs: 0, removed: [], kept: [] };
    let entries: Dirent[];
    try {
      entries = await readdir(this.refinementRoot, { withFileTypes: true });
    } catch {
      out.kept.push("(refinement output root missing or unreadable)");
      return out;
    }
    const dirs = entries.filter((entry) => entry.isDirectory());
    out.scannedDirs = dirs.length;
    if (dirs.length === 0) return out;

    if (!this.graph) {
      details.push("orphan sweep skipped: no graph source to confirm md_ref references");
      for (const dir of dirs) out.kept.push(join(this.refinementRoot, dir.name));
      return out;
    }

    let mdRefs: string[];
    try {
      mdRefs = await this.graph.listMdRefs();
    } catch (err) {
      details.push(`orphan sweep skipped: md_ref lookup failed: ${messageOf(err)}`);
      for (const dir of dirs) out.kept.push(join(this.refinementRoot, dir.name));
      return out;
    }

    const disk = await this.walkWikiPages();
    const liveStems = new Set(
      [...disk.paths].map((path) => basename(path).replace(/\.md$/i, "")),
    );
    const nowMs = this.nowImpl().getTime();
    const graceMs = this.graceHours * 3_600_000;

    for (const entry of dirs) {
      const dirPath = join(this.refinementRoot, entry.name);
      const referenced = mdRefs.some((mdRef) => {
        if (!mdRef) return false;
        const refDir = resolve(dirname(mdRef));
        return refDir === dirPath || refDir.startsWith(dirPath + sep);
      });
      if (referenced) {
        out.kept.push(dirPath);
        continue;
      }
      if (liveStems.has(entry.name)) {
        out.kept.push(dirPath);
        continue;
      }
      let ageMs = Infinity;
      try {
        const info = await stat(dirPath);
        ageMs = Math.max(0, nowMs - info.mtimeMs);
      } catch {
        // unreadable stat — treat as infinitely old is WRONG here; keep instead.
        out.kept.push(dirPath);
        continue;
      }
      if (ageMs <= graceMs) {
        out.kept.push(dirPath);
        continue;
      }
      try {
        await this.rmDirImpl(dirPath);
        out.removed.push(dirPath);
        details.push(`orphan refinement dir removed: ${dirPath}`);
      } catch (err) {
        out.kept.push(dirPath);
        details.push(`orphan refinement dir removal failed: ${dirPath}: ${messageOf(err)}`);
      }
    }
    return out;
  }

  /** Recursively list the wiki *.md files as project-relative "wiki/..." paths. */
  private async walkWikiPages(): Promise<WikiWalkResult> {
    const out = new Set<string>();
    if (!this.wikiDir) return { paths: out, error: "wiki dir not configured" };
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (out.size === 0 && dir === resolve(this.wikiDir!)) throw err;
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          const rel = relative(resolve(this.wikiDir!), full).split(sep).join("/");
          out.add(`wiki/${rel}`);
        }
      }
    };
    try {
      await walk(resolve(this.wikiDir));
    } catch (err) {
      return { paths: out, error: messageOf(err) };
    }
    return { paths: out };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- scheduler ---------------------------------------------------------------

export interface KbAuditSchedulerOptions {
  service: Pick<KbAuditService, "run">;
  runsStore: Pick<KbAuditRunsStore, "latestByTrigger">;
  /** Default: KB_AUDIT_ENABLED !== "false". */
  enabled?: boolean;
  /** Day of week 0 (sunday) .. 6. Default: KB_AUDIT_DAY or sunday. */
  day?: number;
  /** Local hour 0..23. Default: KB_AUDIT_HOUR or 3. */
  hour?: number;
  now?: () => Date;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

/**
 * In-server weekly scheduler (no external cron): computes the next occurrence
 * of the configured day+hour, runs the audit, and recomputes after each run.
 * The last SCHEDULED run start is read back from the runs store, so a restart
 * mid-week never double-runs; a window missed while the server was down gets
 * exactly one catch-up run at startup. Manual runs never reset the cadence.
 */
export class KbAuditScheduler {
  private readonly service: KbAuditSchedulerOptions["service"];
  private readonly runsStore: KbAuditSchedulerOptions["runsStore"];
  private readonly enabled: boolean;
  private readonly schedule: { day: number; hour: number };
  private readonly nowImpl: () => Date;
  private readonly setTimeoutFn: NonNullable<KbAuditSchedulerOptions["setTimeoutImpl"]>;
  private readonly clearTimeoutFn: NonNullable<KbAuditSchedulerOptions["clearTimeoutImpl"]>;
  private timer: unknown;

  constructor(options: KbAuditSchedulerOptions) {
    this.service = options.service;
    this.runsStore = options.runsStore;
    this.enabled =
      options.enabled ?? process.env.KB_AUDIT_ENABLED !== "false";
    this.schedule = {
      day:
        options.day ??
        parseDayOfWeek(process.env.KB_AUDIT_DAY),
      hour: options.hour ?? parseHour(process.env.KB_AUDIT_HOUR),
    };
    this.nowImpl = options.now ?? (() => new Date());
    this.setTimeoutFn = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutFn =
      options.clearTimeoutImpl ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Startup: one catch-up run when the weekly window was missed, then arm. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    if (await this.windowMissed()) {
      await this.runScheduled();
    }
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer !== undefined) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
  }

  /** Next armed occurrence (observability/tests), or null while disarmed. */
  async nextRunAt(): Promise<Date | null> {
    return computeNextRun(this.nowImpl(), this.schedule);
  }

  private async windowMissed(): Promise<boolean> {
    let last: Awaited<ReturnType<KbAuditSchedulerOptions["runsStore"]["latestByTrigger"]>>;
    try {
      last = await this.runsStore.latestByTrigger("scheduled");
    } catch {
      return true; // persistence unavailable → assume never ran
    }
    if (!last) return true;
    return this.nowImpl().getTime() - Date.parse(last.startedAt) >= WEEK_MS;
  }

  private async runScheduled(): Promise<void> {
    try {
      await this.service.run("scheduled");
    } catch (err) {
      console.error("[kb-audit] scheduled audit failed:", messageOf(err));
    }
  }

  private scheduleNext(): void {
    const delay = Math.max(
      0,
      computeNextRun(this.nowImpl(), this.schedule).getTime() - this.nowImpl().getTime(),
    );
    this.timer = this.setTimeoutFn(() => {
      void this.runScheduled().then(() => this.scheduleNext());
    }, Math.min(delay, MAX_TIMEOUT_MS));
  }
}

/** Re-export so route/app wiring has one import site for the record types. */
export type { KbAuditFileCheck, KbAuditOrphanSweep, KbAuditRunRecord, KbAuditTrigger };
