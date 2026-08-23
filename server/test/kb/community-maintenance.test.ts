import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Neo4jDriverLike } from "../../src/kb/store/schema.js";
import {
  KbCommunityMaintenanceService,
  KbCommunityRecomputeAlreadyRunningError,
  type KbCommunityQuality,
  type KbCommunityRecomputeReport,
} from "../../src/kb/community-maintenance.js";

// --- fakes -------------------------------------------------------------------

function record(obj: Record<string, unknown>): { get: (k: string) => unknown } {
  return { get: (k) => obj[k] };
}

const ASSIGNMENTS_QUERY_FRAGMENT = "e.community_id AS communityId";
const SUMMARIES_QUERY_FRAGMENT = "c.summary IS NOT NULL AS hasSummary";

interface AssignmentRow {
  id: string;
  communityId: string | null;
}

/**
 * Driver double serving a DIFFERENT partition snapshot per read: the first
 * assignments query is the pre-recompute partition, later ones the fresh one.
 */
function makeDriver(
  before: AssignmentRow[],
  after: AssignmentRow[],
  summaries: Array<Record<string, unknown>> = [{ hasSummary: true }, { hasSummary: false }],
): { driver: Neo4jDriverLike; queries: string[] } {
  const queries: string[] = [];
  let assignmentReads = 0;
  const driver: Neo4jDriverLike = {
    session() {
      return {
        run: async (query: string) => {
          queries.push(query);
          if (query.includes(ASSIGNMENTS_QUERY_FRAGMENT)) {
            assignmentReads += 1;
            return { records: (assignmentReads === 1 ? before : after).map(record) };
          }
          if (query.includes(SUMMARIES_QUERY_FRAGMENT)) {
            return { records: summaries.map(record) };
          }
          return { records: [] };
        },
        close: async () => {},
      };
    },
  };
  return { driver, queries };
}

/** CALEO+ZOB join a community, LUESEN switches, STRAY stays unassigned. */
const BEFORE_ROWS: AssignmentRow[] = [
  { id: "CALEO", communityId: null },
  { id: "ZOB MUENCHEN", communityId: null },
  { id: "BCS", communityId: "c_bcs" },
  { id: "LUESEN", communityId: "c_old" },
  { id: "STRAY", communityId: null },
];

const AFTER_ROWS: AssignmentRow[] = [
  { id: "CALEO", communityId: "c_caleo" },
  { id: "ZOB MUENCHEN", communityId: "c_caleo" },
  { id: "BCS", communityId: "c_bcs" },
  { id: "LUESEN", communityId: "c_bcs" },
  { id: "STRAY", communityId: null },
];

interface FakeCommunityOptions {
  result?: {
    strategy: "full" | "local" | "skipped";
    entitiesAssigned: number;
    communities?: number;
    error?: string;
  };
}

function fakeCommunity(options: FakeCommunityOptions = {}) {
  const calls: Array<{ kind: string }> = [];
  return {
    calls,
    async refresh(trigger: { kind: string }) {
      calls.push({ kind: trigger.kind });
      return options.result ?? { strategy: "full" as const, entitiesAssigned: 4, communities: 2 };
    },
  };
}

interface FakeSummariesOptions {
  result?: {
    communities: number;
    summarized: string[];
    unchanged: number;
    removed: string[];
    errors: string[];
  };
}

function fakeSummaries(options: FakeSummariesOptions = {}) {
  const calls: number[] = [];
  return {
    calls,
    async sync() {
      calls.push(1);
      return options.result ?? {
        communities: 2,
        summarized: ["c_aaa"],
        unchanged: 1,
        removed: [],
        errors: [],
      };
    },
  };
}

function makeService(
  overrides: {
    before?: AssignmentRow[];
    after?: AssignmentRow[];
    summaries?: Array<Record<string, unknown>>;
    community?: ReturnType<typeof fakeCommunity>;
    /** Default: a wired fake summaries service. False = none (production may
     *  run without T2). */
    wireSummaries?: boolean;
  } = {},
): {
  service: KbCommunityMaintenanceService;
  community: ReturnType<typeof fakeCommunity>;
  communitySummaries: ReturnType<typeof fakeSummaries> | undefined;
  queries: string[];
} {
  const community = overrides.community ?? fakeCommunity();
  const { driver, queries } = makeDriver(
    overrides.before ?? BEFORE_ROWS,
    overrides.after ?? AFTER_ROWS,
    overrides.summaries,
  );
  const wire = overrides.wireSummaries ?? true;
  const communitySummaries =
    overrides.communitySummaries ?? (wire ? fakeSummaries() : undefined);
  const service = new KbCommunityMaintenanceService({
    driver,
    community,
    ...(communitySummaries ? { communitySummaries } : {}),
  });
  return { service, community, communitySummaries, queries };
}

let serviceHarness: ReturnType<typeof makeService>;

beforeEach(() => {
  serviceHarness = makeService();
});

// --- recompute ---------------------------------------------------------------

test("recompute runs the FULL clustering via a manual trigger and returns the report", async () => {
  const { service, community } = serviceHarness;
  const report = await service.recompute();

  assert.deepEqual(community.calls, [{ kind: "manual" }]);
  assert.equal(report.communities, 2);
  assert.equal(report.strategy, "full");
  assert.equal(report.entitiesWithoutCommunity, 1);
});

test("entitiesPerCommunity is largest-first with a stable tie-break", async () => {
  const { service } = serviceHarness;
  const report = await service.recompute();

  assert.equal(report.entitiesPerCommunity.length, 2);
  for (const entry of report.entitiesPerCommunity) {
    assert.equal(entry.size, 2);
  }
  // Equal sizes → ascending id order keeps the report deterministic.
  assert.ok(
    report.entitiesPerCommunity[0]!.id < report.entitiesPerCommunity[1]!.id,
    `expected stable ordering, got ${JSON.stringify(report.entitiesPerCommunity)}`,
  );
});

test("recompute names the largest community", async () => {
  const { service } = serviceHarness;
  const report = await service.recompute();

  assert.ok(report.largestCommunity);
  assert.equal(report.largestCommunity!.size, 2);
});

test("changedSinceLast counts entities whose membership differs from the pre-run partition", async () => {
  const { service } = serviceHarness;
  const report = await service.recompute();

  // CALEO + ZOB newly assigned, LUESEN moved c_old → c_bcs; STRAY stayed null.
  assert.equal(report.changedSinceLast, 3);
});

test("summary refresh reuses T2's sync and surfaces only-changed counts", async () => {
  const { service, communitySummaries } = serviceHarness;
  const report = await service.recompute();

  assert.ok(communitySummaries);
  assert.equal(communitySummaries.calls.length, 1);
  assert.equal(report.summariesRefreshed, 1);
  assert.equal(report.summariesUnchanged, 1);
  assert.deepEqual(report.errors, []);
});

test("the recompute works without a wired summarizer (zeros, no errors)", async () => {
  const { service } = makeService({ wireSummaries: false });
  const report = await service.recompute();

  assert.equal(report.summariesRefreshed, 0);
  assert.equal(report.summariesUnchanged, 0);
  assert.deepEqual(report.errors, []);
});

test("summary-sync failures land in report.errors without failing the recompute", async () => {
  const failing = fakeSummaries({
    result: { communities: 1, summarized: [], unchanged: 0, removed: [], errors: ["c_x: boom"] },
  });
  const { service } = makeService({ communitySummaries: failing });
  const report = await service.recompute();

  assert.deepEqual(report.errors, ["c_x: boom"]);
});

test("a detector failure degrades to a skipped strategy report instead of throwing", async () => {
  const broken = fakeCommunity({
    result: { strategy: "skipped", entitiesAssigned: 0, error: "driver dead" },
  });
  const { service } = makeService({ community: broken });
  const report = await service.recompute();

  assert.equal(report.strategy, "skipped");
  assert.deepEqual(report.errors, ["driver dead"]);
});

test("concurrent recomputes are rejected", async () => {
  const { driver } = makeDriver(BEFORE_ROWS, AFTER_ROWS);
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const slowCommunity = {
    async refresh() {
      await gate;
      return { strategy: "full" as const, entitiesAssigned: 1, communities: 1 };
    },
  };
  const service = new KbCommunityMaintenanceService({ driver, community: slowCommunity });
  const first = service.recompute();
  await assert.rejects(() => service.recompute(), KbCommunityRecomputeAlreadyRunningError);
  release();
  await first;
});

// --- quality snapshot (weekly-audit section) ---------------------------------

test("quality returns the read-only community-quality block without any refresh", async () => {
  // A standalone snapshot read sees ONE partition — hand the same rows to both
  // slots so the driver double doesn't flip snapshots mid-read.
  const { service, community } = makeService({ before: AFTER_ROWS });
  const quality: KbCommunityQuality = await service.quality();

  assert.equal(community.calls.length, 0);
  assert.equal(quality.communities, 2);
  assert.equal(quality.entitiesWithoutCommunity, 1);
  assert.equal(quality.summariesPresent, 1);
  assert.equal(quality.summariesTotal, 2);
  assert.ok(quality.largestCommunity);
});

// --- full recompute report type sanity ----------------------------------------

test("the recompute report is a superset of the weekly quality block", async () => {
  const { service } = serviceHarness;
  const report: KbCommunityRecomputeReport = await service.recompute();
  const quality: KbCommunityQuality = report;

  assert.equal(quality.communities, report.communities);
  assert.equal(typeof report.changedSinceLast, "number");
});
