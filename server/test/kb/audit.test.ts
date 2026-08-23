import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryKbAuditRunsStore,
  type KbAuditRunRecord,
} from "../../src/kb/audit-runs.js";
import {
  KbAuditAlreadyRunningError,
  KbAuditScheduler,
  KbAuditService,
  WEEK_MS,
  computeNextRun,
  parseDayOfWeek,
  parseHour,
} from "../../src/kb/audit.js";

// --- fakes -------------------------------------------------------------------

interface FakeGraphOptions {
  wikiPagePaths?: string[];
  mdRefs?: string[];
}

function fakeGraph(options: FakeGraphOptions = {}) {
  const deletes: { wikiPath: string; stem: string }[] = [];
  return {
    wikiPagePaths: options.wikiPagePaths ?? [],
    mdRefs: options.mdRefs ?? [],
    deletes,
    async listWikiPagePaths() {
      return this.wikiPagePaths;
    },
    async listMdRefs() {
      return this.mdRefs;
    },
    async deleteDocumentsForWikiPage(input: { wikiPath: string; stem: string }) {
      this.deletes.push(input);
      return {
        documentsRemoved: 1,
        chunksRemoved: 2,
        sectionsRemoved: 0,
        entitiesRemoved: 1,
        entitiesRetained: 0,
        mdRefs: [`${input.stem}/markdown.md`],
      };
    },
  };
}

function fakeReview(scanned = 1) {
  return {
    reviewAll: async () => ({
      runAt: "2026-08-21",
      scanned,
      changed: 0,
      archive: [],
      results: [],
    }),
  };
}

async function makeRefinementRoot(dirs: Record<string, number>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "athena-audit-refinement-"));
  for (const [name, ageDays] of Object.entries(dirs)) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "markdown.md"), "# x\n");
    const stamp = new Date(Date.now() - ageDays * 86_400_000);
    await utimes(dir, stamp, stamp);
  }
  return root;
}

function makeService(
  options: Partial<ConstructorParameters<typeof KbAuditService>[0]> = {},
): KbAuditService {
  return new KbAuditService({
    review: fakeReview(),
    runsStore: new MemoryKbAuditRunsStore(),
    ...options,
  });
}

function makePersistedRecord(
  trigger: "scheduled" | "manual",
  startedAt: Date = new Date(),
): KbAuditRunRecord {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    trigger,
    startedAt: startedAt.toISOString(),
    durationMs: 5,
    review: { runAt: "2026-08-21", scanned: 0, changed: 0, archive: [], results: [] },
    fileCheck: { repaired: 0, details: [] },
    orphans: { scannedDirs: 0, removed: [], kept: [] },
  };
}

// --- computeNextRun ----------------------------------------------------------

test("computeNextRun returns the upcoming configured day+hour strictly after now", () => {
  const now = new Date(2026, 7, 21, 12, 0, 0); // Friday
  const next = computeNextRun(now, { day: 0, hour: 3 }); // Sunday 03:00
  assert.equal(next.getDay(), 0);
  assert.equal(next.getHours(), 3);
  assert.deepEqual(
    [next.getMonth(), next.getDate()],
    [7, 23],
  );
  assert.ok(next.getTime() > now.getTime());
});

test("computeNextRun rolls a week when the same-day hour already passed", () => {
  const now = new Date(2026, 7, 23, 5, 0, 0); // Sunday 05:00, 03:00 gone
  const next = computeNextRun(now, { day: 0, hour: 3 });
  assert.deepEqual([next.getMonth(), next.getDate()], [7, 30]);
});

test("parseDayOfWeek/parseHour defaults + parsing", () => {
  assert.equal(parseDayOfWeek(undefined), 0);
  assert.equal(parseHour(undefined), 3);
  assert.equal(parseDayOfWeek("SATURDAY"), 6);
  assert.equal(parseDayOfWeek("wed"), 3);
  assert.equal(parseHour("22"), 22);
  assert.equal(parseDayOfWeek("nonsense"), 0);
  assert.equal(parseHour("99"), 3);
  assert.equal(parseHour("abc"), 3);
});

test("WEEK_MS is seven days", () => {
  assert.equal(WEEK_MS, 7 * 86_400_000);
});

// --- scheduler restart persistence -------------------------------------------

interface ArmedTimer {
  fn: () => void;
  ms: number;
}

let timers: ArmedTimer[];
const setTimeoutImpl = (fn: () => void, ms: number) => {
  timers.push({ fn, ms });
  return timers.length;
};

beforeEach(() => {
  timers = [];
});

function makeScheduler(
  runsStore: MemoryKbAuditRunsStore,
  service: { run(trigger: "scheduled" | "manual"): Promise<unknown> },
): KbAuditScheduler {
  return new KbAuditScheduler({
    service,
    runsStore,
    setTimeoutImpl,
    clearTimeoutImpl: () => {},
  });
}

test("scheduler catches up a missed window exactly once at startup", async () => {
  const runs = new MemoryKbAuditRunsStore();
  let runs_ = 0;
  const scheduler = makeScheduler(runs, {
    run: async () => {
      runs_ += 1;
      const record = makePersistedRecord("scheduled");
      await runs.insert(record);
      return record;
    },
  });
  await scheduler.start();
  scheduler.stop();
  assert.equal(runs_, 1, "missed window → one immediate catch-up run");
  assert.equal(timers.length, 1, "then arms the next weekly occurrence");
});

test("scheduler does NOT duplicate a run within the same week across a restart", async () => {
  const runs = new MemoryKbAuditRunsStore();
  await runs.insert(makePersistedRecord("scheduled", new Date(Date.now() - 2 * 86_400_000)));
  let runs_ = 0;
  const scheduler = makeScheduler(runs, {
    run: async () => {
      runs_ += 1;
      throw new Error("must not run within the same week");
    },
  });
  await scheduler.start();
  scheduler.stop();
  assert.equal(runs_, 0, "recent scheduled run suppresses the catch-up");
  assert.equal(timers.length, 1);
});

test("scheduler runs when the last scheduled run is older than a week", async () => {
  const runs = new MemoryKbAuditRunsStore();
  await runs.insert(makePersistedRecord("scheduled", new Date(Date.now() - 8 * 86_400_000)));
  let runs_ = 0;
  const scheduler = makeScheduler(runs, {
    run: async () => {
      runs_ += 1;
      return makePersistedRecord("scheduled");
    },
  });
  await scheduler.start();
  scheduler.stop();
  assert.equal(runs_, 1);
});

test("scheduler ignores manual runs for the weekly catch-up decision", async () => {
  const runs = new MemoryKbAuditRunsStore();
  await runs.insert(makePersistedRecord("manual"));
  let runs_ = 0;
  const scheduler = makeScheduler(runs, {
    run: async () => {
      runs_ += 1;
      return makePersistedRecord("scheduled");
    },
  });
  await scheduler.start();
  scheduler.stop();
  assert.equal(runs_, 1, "a manual run does not replace the weekly cadence");
});

test("scheduler is inert when disabled", async () => {
  const runs = new MemoryKbAuditRunsStore();
  let runs_ = 0;
  const scheduler = new KbAuditScheduler({
    service: {
      run: async () => {
        runs_ += 1;
        throw new Error("disabled scheduler must not run");
      },
    },
    runsStore: runs,
    enabled: false,
  });
  await scheduler.start();
  scheduler.stop();
  assert.equal(runs_, 0);
  assert.equal(timers.length, 0);
});

test("scheduler arms the next occurrence after a fired run (no duplicate arm)", async () => {
  const runs = new MemoryKbAuditRunsStore();
  let runs_ = 0;
  const scheduler = makeScheduler(runs, {
    run: async () => {
      runs_ += 1;
      const record = makePersistedRecord("scheduled");
      await runs.insert(record);
      return record;
    },
  });
  await scheduler.start();
  assert.equal(timers.length, 1);
  timers[0]!.fn(); // simulate the timer firing → run + re-arm
  await new Promise((r) => setTimeout(r, 0));
  scheduler.stop();
  assert.equal(runs_, 2, "fired run executed");
  assert.equal(timers.length, 2, "exactly one new timer armed per fire");
});

// --- pipeline ----------------------------------------------------------------

test("stage 1 runs the existing reviewAll over every page", async () => {
  const service = makeService({ review: fakeReview(7) });
  const report = await service.run("manual");
  assert.equal(report.review.scanned, 7);
  assert.equal(report.trigger, "manual");
  assert.ok(report.durationMs >= 0);
});

test("stage 2 removes stale graph subtrees via the T14 cascade and reports missing records only", async () => {
  const root = await mkdtemp(join(tmpdir(), "athena-audit-wiki-"));
  try {
    await mkdir(join(root, "concepts"), { recursive: true });
    await writeFile(join(root, "concepts", "live.md"), "---\ntitle: Live\n---\nbody");
    await writeFile(join(root, "concepts", "orphan-disk.md"), "---\ntitle: D\n---\nbody");

    const graph = fakeGraph({
      wikiPagePaths: ["wiki/concepts/live.md", "wiki/concepts/deleted-from-disk.md"],
    });
    const service = makeService({ graph, wikiDir: root });
    const report = await service.run("manual");

    assert.equal(report.fileCheck.repaired, 1);
    assert.deepEqual(
      graph.deletes.map((d) => d.wikiPath),
      ["wiki/concepts/deleted-from-disk.md"],
    );
    assert.equal(graph.deletes[0]?.stem, "deleted-from-disk");
    const missing = report.fileCheck.details.filter((d) => d.includes("orphan-disk.md"));
    assert.equal(missing.length, 1, "missing graph record is reported");
    assert.match(missing[0]!, /not auto-ingested/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stage 3 sweep keeps referenced dirs, fresh dirs and same-stem live pages; removes only qualifying orphans", async () => {
  const refinementRoot = await makeRefinementRoot({
    "referenced-old": 10, // old BUT referenced via Document.md_ref → kept
    "unreferenced-fresh": 0.25, // newer than the grace period → kept
    "unreferenced-stale": 5, // unreferenced + older than grace → REMOVED
    "live-page": 5, // same stem as a live wiki page → kept
  });
  try {
    const wikiRoot = await mkdtemp(join(tmpdir(), "athena-audit-wiki2-"));
    await writeFile(join(wikiRoot, "live-page.md"), "x");
    const graph = fakeGraph({
      mdRefs: [join(refinementRoot, "referenced-old", "markdown.md")],
    });
    const service = makeService({
      graph,
      wikiDir: wikiRoot,
      refinementRoot,
      graceHours: 48,
    });
    const report = await service.run("scheduled");

    assert.equal(report.orphans.scannedDirs, 4);
    assert.equal(report.orphans.removed.length, 1);
    assert.ok(report.orphans.removed[0]!.endsWith("unreferenced-stale"));
    assert.equal(report.trigger, "scheduled");
    assert.equal(report.orphans.kept.length, 3);
    await rm(wikiRoot, { recursive: true, force: true });
  } finally {
    await rm(refinementRoot, { recursive: true, force: true });
  }
});

test("sweep never deletes refinement dirs when no graph source can confirm references", async () => {
  const refinementRoot = await makeRefinementRoot({ "ancient-orphan": 30 });
  try {
    const service = makeService({ refinementRoot, graceHours: 48 });
    const report = await service.run("manual");
    assert.equal(report.orphans.removed.length, 0, "uncertain references → keep everything");
    assert.equal(report.orphans.scannedDirs, 1);
    assert.ok(report.fileCheck.details.some((d) => d.includes("graph")));
  } finally {
    await rm(refinementRoot, { recursive: true, force: true });
  }
});

test("one report row is persisted per run for BOTH triggers", async () => {
  const runs = new MemoryKbAuditRunsStore();
  const service = makeService({ runsStore: runs });
  await service.run("scheduled");
  await service.run("manual");
  assert.equal((await runs.list()).length, 2);
  assert.equal((await runs.latestByTrigger("scheduled"))?.trigger, "scheduled");
  assert.equal((await runs.latest())?.trigger, "manual");
});

test("rejects a concurrent second run with KbAuditAlreadyRunningError", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const slowReview = {
    reviewAll: async () => {
      await gate;
      return { runAt: "2026-08-21", scanned: 0, changed: 0, archive: [], results: [] };
    },
  };
  const service = makeService({ review: slowReview });
  const first = service.run("scheduled");
  await assert.rejects(() => service.run("manual"), KbAuditAlreadyRunningError);
  release();
  await first;
});

// --- community-quality section (G4.S9.T4) --------------------------------------

function fakeCommunitiesPort(overrides: { quality?: () => Promise<unknown> } = {}) {
  return {
    quality: overrides.quality ?? (async () => qualityBlock()),
  };
}

function qualityBlock() {
  return {
    communities: 2,
    entitiesPerCommunity: [
      { id: "c_caleo", size: 3 },
      { id: "c_bcs", size: 1 },
    ],
    largestCommunity: { id: "c_caleo", size: 3 },
    entitiesWithoutCommunity: 1,
    summariesPresent: 1,
    summariesTotal: 2,
  };
}

test("the weekly audit carries a community-quality section alongside the orphan checks", async () => {
  const runs = new MemoryKbAuditRunsStore();
  const service = makeService({ runsStore: runs, communities: fakeCommunitiesPort() });
  const report = await service.run("scheduled");

  assert.ok(report.communities, "communities block present on the record");
  assert.equal(report.communities!.communities, 2);
  assert.equal(report.communities!.entitiesWithoutCommunity, 1);
  assert.equal(report.communities!.summariesPresent, 1);
  assert.equal(report.communities!.summariesTotal, 2);
  // Persisted row keeps the section — the Admin history renders it later.
  assert.equal((await runs.latestByTrigger("scheduled"))?.communities?.communities, 2);
});

test("a failing community read degrades to a details line without failing the audit", async () => {
  const service = makeService({
    communities: fakeCommunitiesPort({
      quality: async () => {
        throw new Error("neo4j down");
      },
    }),
  });
  const report = await service.run("scheduled");

  assert.equal(report.communities, undefined);
  assert.ok(
    report.fileCheck.details.some((d) => d.includes("community") && d.includes("neo4j down")),
  );
});

test("audits run fine without a communities port (section stays absent)", async () => {
  const service = makeService({});
  const report = await service.run("scheduled");
  assert.equal(report.communities, undefined);
});
