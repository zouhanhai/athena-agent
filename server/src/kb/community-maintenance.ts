/**
 * G4.S9.T4 — Admin knowledge-graph community maintenance.
 *
 * One service, two surfaces over the SAME T1/T2 machinery:
 * - `recompute()`: the manual full re-run behind POST
 *   /api/kb/admin/communities/recompute. Snapshots `e.community_id` before and
 *   after the clustering to count `changedSinceLast`, then refreshes summaries
 *   through T2's sync (hash-diff → only changed communities cost tokens).
 * - `quality()`: a read-only snapshot for the weekly audit's community-quality
 *   section — no refresh, no writes, safe next to the audit's own repairs.
 *
 * Concurrency mirrors KbAuditService: one recompute at a time, a second call
 * rejects with KbCommunityRecomputeAlreadyRunningError (the route maps it 409).
 */

import {
  ENTITY_LABEL,
  COMMUNITY_LABEL,
  type Neo4jDriverLike,
} from "./store/schema.js";
import type {
  Neo4jCommunityService,
} from "./store/community.js";
import type { Neo4jCommunitySummaryService } from "./store/community-summary.js";

export interface KbCommunityQuality {
  /** Distinct communities present on Entity nodes. */
  communities: number;
  /** Per-community member counts, largest first (ties: ascending id). */
  entitiesPerCommunity: Array<{ id: string; size: number }>;
  /** The biggest community, or null when no memberships exist. */
  largestCommunity: { id: string; size: number } | null;
  /** Entities with no `community_id` (should trend to zero post-S9). */
  entitiesWithoutCommunity: number;
  /** Community nodes carrying a summary / all Community nodes (T2). */
  summariesPresent: number;
  summariesTotal: number;
}

export interface KbCommunityRecomputeReport extends KbCommunityQuality {
  /** Entities whose membership differs from the pre-recompute partition. */
  changedSinceLast: number;
  /** Clustering outcome ("full" expected; "skipped" on detector failure). */
  strategy: "full" | "local" | "skipped";
  /** Communities re-summarized in this run (T2 refreshes CHANGED ones only). */
  summariesRefreshed: number;
  summariesUnchanged: number;
  /** Detector / summarizer failures — a broken part never fails the report. */
  errors: string[];
}

/** Raised on a second concurrent recompute; the route maps this to HTTP 409. */
export class KbCommunityRecomputeAlreadyRunningError extends Error {
  constructor() {
    super("a community recompute is already running");
    this.name = "KbCommunityRecomputeAlreadyRunningError";
  }
}

const READ_ASSIGNMENTS_CYPHER =
  `MATCH (e:${ENTITY_LABEL})\n` +
  `RETURN e.nameUpper AS id, e.community_id AS communityId`;

const READ_SUMMARIES_CYPHER =
  `MATCH (c:${COMMUNITY_LABEL})\n` +
  `RETURN c.summary IS NOT NULL AS hasSummary`;

function recordGet(record: unknown, key: string): unknown {
  return (record as { get?: (key: string) => unknown }).get?.(key);
}

function recordsOf(result: unknown): Array<Record<string, unknown>> {
  return ((result as { records?: unknown[] }).records ?? []) as Array<
    Record<string, unknown>
  >;
}

function buildQuality(
  assignments: Map<string, string | null>,
  summariesPresent: number,
  summariesTotal: number,
): KbCommunityQuality {
  const sizes = new Map<string, number>();
  let without = 0;
  for (const communityId of assignments.values()) {
    if (!communityId) {
      without += 1;
      continue;
    }
    sizes.set(communityId, (sizes.get(communityId) ?? 0) + 1);
  }
  const entitiesPerCommunity = [...sizes.entries()]
    .map(([id, size]) => ({ id, size }))
    .sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
  const top = entitiesPerCommunity[0];
  return {
    communities: sizes.size,
    entitiesPerCommunity,
    largestCommunity: top ? { ...top } : null,
    entitiesWithoutCommunity: without,
    summariesPresent,
    summariesTotal,
  };
}

export class KbCommunityMaintenanceService {
  private readonly driver: Neo4jDriverLike;
  private readonly community?: Pick<Neo4jCommunityService, "refresh">;
  private readonly communitySummaries?: Pick<Neo4jCommunitySummaryService, "sync">;
  private running = false;

  constructor(options: {
    driver: Neo4jDriverLike;
    community?: Pick<Neo4jCommunityService, "refresh">;
    communitySummaries?: Pick<Neo4jCommunitySummaryService, "sync">;
  }) {
    this.driver = options.driver;
    this.community = options.community;
    this.communitySummaries = options.communitySummaries;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Full re-run (T1 machinery, forced via the manual trigger) + summary refresh
   * (T2, changed communities only). Resolves even when parts fail — failures
   * land in `report.errors`.
   */
  async recompute(): Promise<KbCommunityRecomputeReport> {
    if (this.running) throw new KbCommunityRecomputeAlreadyRunningError();
    this.running = true;
    try {
      const before = await this.readAssignments();

      // { kind: "manual" } always resolves to the FULL strategy in T1's policy.
      const run = this.community
        ? await this.community.refresh({ kind: "manual" })
        : undefined;

      const after = await this.readAssignments();
      const changedSinceLast = [...after.entries()].filter(([id, communityId]) =>
        before.get(id) !== communityId,
      ).length;

      const summaries = await this.readSummaryCounts();
      const quality = buildQuality(after, summaries.present, summaries.total);

      let refreshed = 0;
      let unchanged = 0;
      const errors: string[] = [];
      if (run?.error) errors.push(run.error);
      if (this.communitySummaries) {
        const synced = await this.communitySummaries.sync();
        refreshed = synced.summarized.length;
        unchanged = synced.unchanged;
        errors.push(...synced.errors);
      }

      return {
        ...quality,
        changedSinceLast,
        strategy: run?.strategy ?? "skipped",
        summariesRefreshed: refreshed,
        summariesUnchanged: unchanged,
        errors,
      };
    } finally {
      this.running = false;
    }
  }

  /** Read-only snapshot for the weekly audit's community-quality section. */
  async quality(): Promise<KbCommunityQuality> {
    const assignments = await this.readAssignments();
    const summaries = await this.readSummaryCounts();
    return buildQuality(assignments, summaries.present, summaries.total);
  }

  private async readAssignments(): Promise<Map<string, string | null>> {
    const session = this.driver.session();
    try {
      const assignments = new Map<string, string | null>();
      for (const record of recordsOf(await session.run(READ_ASSIGNMENTS_CYPHER))) {
        const id = recordGet(record, "id");
        if (!id) continue;
        const raw = recordGet(record, "communityId");
        assignments.set(String(id), raw === null || raw === undefined ? null : String(raw));
      }
      return assignments;
    } finally {
      await session.close();
    }
  }

  private async readSummaryCounts(): Promise<{ present: number; total: number }> {
    const session = this.driver.session();
    try {
      let present = 0;
      let total = 0;
      for (const record of recordsOf(await session.run(READ_SUMMARIES_CYPHER))) {
        total += 1;
        if (recordGet(record, "hasSummary") === true) present += 1;
      }
      return { present, total };
    } finally {
      await session.close();
    }
  }
}
