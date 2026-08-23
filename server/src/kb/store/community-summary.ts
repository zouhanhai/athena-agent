/**
 * G4.S9.T2 — Community nodes + per-community LLM summaries.
 *
 * Consumes T1's stable memberships (`e.community_id`, id = `c_` + sha256 over
 * the sorted member ids) and materializes one `:Community {id, summary, theme,
 * members_hash, member_count, updated_at}` node per community with
 * -[:MEMBER]-> edges to every member entity.
 *
 * Refresh policy (no token burn): each community's membership is fingerprinted
 * with `members_hash` (full sha256 over the SAME canonical form the community
 * id uses). A sync re-summarizes a community ONLY when its node is missing, its
 * hash differs from the persisted grouping, or it has no summary yet (a failed
 * LLM pass is retried on the next run). Communities whose id no longer appears
 * on any entity (dissolved / zero members) are DETACH DELETEd together with
 * their MEMBER edges, keeping the store orphan-less: every entity belongs to
 * exactly one community and carries exactly one MEMBER edge.
 *
 * Summarization: ONE extraction-class LLM call per changed community through
 * the refine toolchain's direct-OpenRouter caller (`callOpenRouter`, reasoning
 * OFF via `refineReasoningFor("extraction")`, json_schema-constrained output of
 * {summary, theme}, ~200-500 token answers). No new provider wiring.
 *
 * Wiring decision (documented in the ticket): `sync()` runs chained AFTER the
 * T1 clustering refresh resolves inside the same fire-and-forget hooks
 * (IngestTaskQueue.refreshCommunities for ingest/wiki-edit; the delete cascade
 * in kb/ingest.ts) — post-finalize, never blocking online retrieval. It is NOT
 * an HTTP endpoint: summaries only make sense after clustering finished, and
 * chaining keeps the trigger surface unchanged from T1.
 */

import { createHash } from "node:crypto";
import { callOpenRouter } from "../../agents/llm-direct.js";
import { refineReasoningFor } from "../../agents/refine-reasoning.js";
import {
  canonicalMembershipKey,
} from "./community.js";
import {
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  COMMUNITY_LABEL,
  MEMBER_TYPE,
  type Neo4jDriverLike,
} from "./schema.js";

/** Max output tokens for one summary call (~200-500 token answer + JSON headroom). */
export const COMMUNITY_SUMMARY_MAX_TOKENS = 1200;

export interface CommunityMemberInfo {
  name: string;
  type: string | null;
  description: string | null;
}

export interface CommunityRelationInfo {
  source: string;
  target: string;
  keywords: string[];
  description: string | null;
}

export interface CommunitySummaryInput {
  communityId: string;
  members: CommunityMemberInfo[];
  relations: CommunityRelationInfo[];
}

/** One summarization pass for one community (mocked in tests). */
export type CommunitySummarizer = (
  input: CommunitySummaryInput,
) => Promise<{ summary: string; theme: string }>;

/** Full sha256 hex over the same canonical form the stable community id uses. */
export function membershipHashFor(members: string[]): string {
  return createHash("sha256").update(canonicalMembershipKey(members)).digest("hex");
}

// ---------------------------------------------------------------------------
// Prompt + output contract (extraction class, mirrors the refine tooling)
// ---------------------------------------------------------------------------

const DESCRIPTION_MAX_CHARS = 160;

export const COMMUNITY_SUMMARY_SYSTEM_PROMPT =
  "You are a knowledge-graph analyst. You get the member entities and the intra-community " +
  "relations of ONE detected community of a corporate knowledge graph. Write a compact " +
  "summary that names the theme, the core members and their key relations, in the dominant " +
  "language of the input data.\n" +
  'Respond ONLY as JSON matching {"summary": string, "theme": string}: ' +
  '"summary" is 2-5 sentences (~200-500 tokens total for both fields); ' +
  '"theme" is a 2-6 word label for the community topic.';

/** TypeBox-style schema handed to OpenRouter's json_schema constrained sampling. */
export const COMMUNITY_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "theme"],
  properties: {
    summary: { type: "string", description: "2-5 sentences naming core members and key relations." },
    theme: { type: "string", description: "2-6 word topical label." },
  },
} as const;

export interface CommunityPromptCaps {
  maxMembers?: number;
  maxRelations?: number;
}

export function buildCommunitySummaryPrompt(
  input: CommunitySummaryInput,
  caps: CommunityPromptCaps = {},
): string {
  const maxMembers = caps.maxMembers ?? 60;
  const maxRelations = caps.maxRelations ?? 80;

  const lines: string[] = [`COMMUNITY ${input.communityId}`, "", "MEMBERS:"];
  const shownMembers = input.members.slice(0, maxMembers);
  for (const member of shownMembers) {
    const type = member.type ? ` (${member.type})` : "";
    const description = member.description ? `: ${member.description.slice(0, DESCRIPTION_MAX_CHARS)}` : "";
    lines.push(`- ${member.name}${type}${description}`);
  }
  if (input.members.length > shownMembers.length) {
    lines.push(`(+${input.members.length - shownMembers.length} more members omitted)`);
  }

  lines.push("", "RELATIONS:");
  if (input.relations.length === 0) {
    lines.push("(none recorded)");
  } else {
    const shownRelations = input.relations.slice(0, maxRelations);
    for (const relation of shownRelations) {
      const keywords = relation.keywords.length > 0 ? ` [${relation.keywords.join(", ")}]` : "";
      const description = relation.description
        ? `: ${relation.description.slice(0, DESCRIPTION_MAX_CHARS)}`
        : "";
      lines.push(`- ${relation.source} -> ${relation.target}${keywords}${description}`);
    }
    if (input.relations.length > shownRelations.length) {
      lines.push(`(+${input.relations.length - shownRelations.length} more relations omitted)`);
    }
  }
  return lines.join("\n");
}

/** Parse + validate the LLM JSON answer ({summary, theme}); throws on any deviation. */
export function parseCommunitySummaryText(text: string): { summary: string; theme: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`community summary: invalid JSON from LLM: ${text.slice(0, 120)}`);
  }
  const record = parsed as { summary?: unknown; theme?: unknown };
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const theme = typeof record.theme === "string" ? record.theme.trim() : "";
  if (!summary) throw new Error("community summary: LLM returned an empty/missing summary field");
  if (!theme) throw new Error("community summary: LLM returned an empty/missing theme field");
  return { summary, theme };
}

export interface DefaultCommunitySummarizerOptions {
  /** Injectable fetch (tests). Default: globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** OpenRouter key. Default: readAthenaOpenRouterKey()'s three-level lookup. */
  apiKey?: string;
  /** Model id override. Default: env ATHENA_REFINE_MODEL / deepseek default. */
  model?: string;
  maxTokens?: number;
}

/**
 * Production summarizer: the refine extraction-class caller (`callOpenRouter`)
 * with reasoning OFF and json_schema-constrained {summary, theme} output.
 */
export function defaultCommunitySummarizer(
  options: DefaultCommunitySummarizerOptions = {},
): CommunitySummarizer {
  return async (input) => {
    const { text } = await callOpenRouter(
      {
        systemPrompt: COMMUNITY_SUMMARY_SYSTEM_PROMPT,
        userContent: buildCommunitySummaryPrompt(input),
        schema: COMMUNITY_SUMMARY_SCHEMA,
        maxTokens: options.maxTokens ?? COMMUNITY_SUMMARY_MAX_TOKENS,
        model: options.model,
        // Extraction-class call → unified strategy keeps thinking OFF (G4.S8.T16).
        reasoningEffort: refineReasoningFor("extraction").effort,
      },
      {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      },
    );
    return parseCommunitySummaryText(text);
  };
}

// ---------------------------------------------------------------------------
// Neo4j-backed sync service
// ---------------------------------------------------------------------------

export interface CommunitySummaryRunResult {
  /** Distinct communities currently present on Entity nodes. */
  communities: number;
  /** Community ids summarized in THIS run (created or membership-changed or retry). */
  summarized: string[];
  /** Communities left untouched (hash unchanged, summary present) — zero tokens. */
  unchanged: number;
  /** Stale community ids removed (zero members / dissolved composition). */
  removed: string[];
  /** Per-community failures — sync NEVER throws into callers. */
  errors: string[];
}

const WRITE_BATCH_SIZE = 500;

const READ_GROUPED_ENTITIES_CYPHER =
  `MATCH (e:${ENTITY_LABEL})\n` +
  `WHERE e.community_id IS NOT NULL\n` +
  `RETURN e.community_id AS communityId, e.nameUpper AS id, e.name AS name,\n` +
  `       e.type AS type, e.description AS description`;

const READ_INTRA_RELATIONS_CYPHER =
  `MATCH (a:${ENTITY_LABEL})-[r:${ENTITY_RELATION_TYPE}]->(b:${ENTITY_LABEL})\n` +
  `WHERE a.community_id IS NOT NULL AND a.community_id = b.community_id\n` +
  `RETURN DISTINCT a.community_id AS communityId, a.nameUpper AS source, b.nameUpper AS target,\n` +
  `       r.keywords AS keywords, r.description AS description`;

const READ_EXISTING_COMMUNITIES_CYPHER =
  `MATCH (c:${COMMUNITY_LABEL})\n` +
  `RETURN c.id AS id, c.members_hash AS membersHash, c.summary IS NOT NULL AS hasSummary`;

const UPSERT_NODES_CYPHER =
  `UNWIND $nodes AS n\n` +
  `MERGE (c:${COMMUNITY_LABEL} {id: n.id})\n` +
  `SET c.members_hash = n.membersHash, c.member_count = n.memberCount`;

const MERGE_MEMBER_EDGES_CYPHER =
  `UNWIND $edges AS e\n` +
  `MATCH (c:${COMMUNITY_LABEL} {id: e.communityId})\n` +
  `MATCH (en:${ENTITY_LABEL} {nameUpper: e.memberId})\n` +
  `MERGE (c)-[:${MEMBER_TYPE}]->(en)`;

const PRUNE_MEMBER_EDGES_CYPHER =
  `UNWIND $prune AS p\n` +
  `MATCH (c:${COMMUNITY_LABEL} {id: p.id})-[m:${MEMBER_TYPE}]->(en:${ENTITY_LABEL})\n` +
  `WHERE NOT en.nameUpper IN p.keepIds\n` +
  `DELETE m`;

const DELETE_STALE_CYPHER =
  `UNWIND $staleIds AS id\n` +
  `MATCH (c:${COMMUNITY_LABEL} {id})\n` +
  `DETACH DELETE c`;

const WRITE_SUMMARY_CYPHER =
  `MATCH (c:${COMMUNITY_LABEL} {id: $id})\n` +
  `SET c.summary = $summary, c.theme = $theme, c.updated_at = $updatedAt`;

function recordGet(record: unknown, key: string): unknown {
  return (record as { get?: (key: string) => unknown }).get?.(key);
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function recordsOf(result: unknown): Array<Record<string, unknown>> {
  return ((result as { records?: unknown[] }).records ?? []) as Array<Record<string, unknown>>;
}

interface MemberRow extends CommunityMemberInfo {
  id: string;
}

interface ExistingCommunity {
  membersHash: string | null;
  hasSummary: boolean;
}

interface SyncPlan {
  id: string;
  membersHash: string;
  memberIds: string[];
  needsSummary: boolean;
}

/**
 * Mirrors the current `e.community_id` grouping onto :Community nodes and keeps
 * their summaries fresh. Like the T1 refresh it never throws: failures land in
 * the result's `errors` so the fire-and-forget chain stays non-blocking.
 */
export class Neo4jCommunitySummaryService {
  private readonly driver: Neo4jDriverLike;
  private readonly summarizer: CommunitySummarizer;
  private readonly promptCaps: Required<CommunityPromptCaps>;

  constructor(options: {
    driver: Neo4jDriverLike;
    /** Default: the direct-OpenRouter extraction-class caller. */
    summarizer?: CommunitySummarizer;
    /** Context caps for huge communities (prompt truncation, not data loss). */
    maxMembersInPrompt?: number;
    maxRelationsInPrompt?: number;
  }) {
    this.driver = options.driver;
    this.summarizer = options.summarizer ?? defaultCommunitySummarizer();
    this.promptCaps = {
      maxMembers: options.maxMembersInPrompt ?? 60,
      maxRelations: options.maxRelationsInPrompt ?? 80,
    };
  }

  /** One refresh pass. Resolves even when individual LLM calls fail. */
  async sync(): Promise<CommunitySummaryRunResult> {
    const result: CommunitySummaryRunResult = {
      communities: 0,
      summarized: [],
      unchanged: 0,
      removed: [],
      errors: [],
    };
    try {
      const groups = await this.loadGroups();
      const relationsByCommunity = await this.loadRelations(groups);
      const existing = await this.loadExistingCommunities();

      result.communities = groups.size;
      const staleIds = [...existing.keys()].filter((id) => !groups.has(id));

      // Plan: hash every current group, diff against the persisted nodes.
      const plans: SyncPlan[] = [];
      for (const [id, group] of groups) {
        const memberIds = group.map((m) => m.id);
        const membersHash = membershipHashFor(memberIds);
        const prev = existing.get(id);
        plans.push({
          id,
          membersHash,
          memberIds,
          // Re-summarize on new node, changed membership, or a missing summary
          // (covers failed LLM passes → automatic retry on the next run).
          needsSummary: !prev || prev.membersHash !== membersHash || !prev.hasSummary,
        });
      }

      await this.upsertNodes(plans);
      await this.mergeMemberEdges(plans);
      await this.pruneMemberEdges(plans);

      // Summaries sequentially: gentle on rate limits, deterministic ordering.
      for (const plan of plans.filter((p) => p.needsSummary)) {
        try {
          const { summary, theme } = await this.summarizer({
            communityId: plan.id,
            members: groups.get(plan.id)!,
            relations: relationsByCommunity.get(plan.id) ?? [],
          });
          await this.writeSummary(plan.id, summary, theme);
          result.summarized.push(plan.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[kb:community-summary] summarize ${plan.id} failed: ${message}`);
          result.errors.push(`${plan.id}: ${message}`);
        }
      }
      result.unchanged = plans.length - plans.filter((p) => p.needsSummary).length;

      if (staleIds.length > 0) {
        await this.deleteStale(staleIds);
        result.removed.push(...staleIds.sort());
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[kb:community-summary] sync failed: ${message}`);
      result.errors.push(message);
      return result;
    }
  }

  /** Current grouping: entities folded by community_id, sorted deterministically. */
  private async loadGroups(): Promise<Map<string, MemberRow[]>> {
    const session = this.driver.session();
    try {
      const grouped = new Map<string, MemberRow[]>();
      for (const record of recordsOf(await session.run(READ_GROUPED_ENTITIES_CYPHER))) {
        const communityId = str(recordGet(record, "communityId"));
        const id = str(recordGet(record, "id"))?.toUpperCase();
        if (!communityId || !id) continue;
        const list = grouped.get(communityId) ?? [];
        list.push({
          id,
          name: str(recordGet(record, "name")) ?? id,
          type: str(recordGet(record, "type")),
          description: str(recordGet(record, "description")),
        });
        grouped.set(communityId, list);
      }
      for (const [, list] of grouped) list.sort((a, b) => a.id.localeCompare(b.id));
      return grouped;
    } finally {
      await session.close();
    }
  }

  /** Intra-community RELATION edges (both endpoints share the community). */
  private async loadRelations(groups: Map<string, MemberRow[]>): Promise<Map<string, CommunityRelationInfo[]>> {
    const session = this.driver.session();
    try {
      const byCommunity = new Map<string, CommunityRelationInfo[]>();
      for (const record of recordsOf(await session.run(READ_INTRA_RELATIONS_CYPHER))) {
        const communityId = str(recordGet(record, "communityId"));
        const source = str(recordGet(record, "source"));
        const target = str(recordGet(record, "target"));
        if (!communityId || !source || !target || !groups.has(communityId)) continue;
        const rawKeywords = recordGet(record, "keywords");
        const keywords = Array.isArray(rawKeywords) ? rawKeywords.map(String) : [];
        const list = byCommunity.get(communityId) ?? [];
        list.push({
          source,
          target,
          keywords,
          description: str(recordGet(record, "description")),
        });
        byCommunity.set(communityId, list);
      }
      return byCommunity;
    } finally {
      await session.close();
    }
  }

  private async loadExistingCommunities(): Promise<Map<string, ExistingCommunity>> {
    const session = this.driver.session();
    try {
      const existing = new Map<string, ExistingCommunity>();
      for (const record of recordsOf(await session.run(READ_EXISTING_COMMUNITIES_CYPHER))) {
        const id = str(recordGet(record, "id"));
        if (!id) continue;
        existing.set(id, {
          membersHash: str(recordGet(record, "membersHash")),
          hasSummary: recordGet(record, "hasSummary") === true,
        });
      }
      return existing;
    } finally {
      await session.close();
    }
  }

  private async upsertNodes(plans: SyncPlan[]): Promise<void> {
    const session = this.driver.session();
    try {
      const nodes = plans.map((p) => ({
        id: p.id,
        membersHash: p.membersHash,
        memberCount: p.memberIds.length,
      }));
      for (let start = 0; start < nodes.length; start += WRITE_BATCH_SIZE) {
        await session.run(UPSERT_NODES_CYPHER, { nodes: nodes.slice(start, start + WRITE_BATCH_SIZE) });
      }
    } finally {
      await session.close();
    }
  }

  private async mergeMemberEdges(plans: SyncPlan[]): Promise<void> {
    const session = this.driver.session();
    try {
      const edges = plans.flatMap((p) =>
        p.memberIds.map((memberId) => ({ communityId: p.id, memberId })),
      );
      for (let start = 0; start < edges.length; start += WRITE_BATCH_SIZE) {
        await session.run(MERGE_MEMBER_EDGES_CYPHER, { edges: edges.slice(start, start + WRITE_BATCH_SIZE) });
      }
    } finally {
      await session.close();
    }
  }

  /** Drop MEMBER edges of communities whose membership changed under a surviving id. */
  private async pruneMemberEdges(plans: SyncPlan[]): Promise<void> {
    const session = this.driver.session();
    try {
      const prune = plans.map((p) => ({ id: p.id, keepIds: p.memberIds }));
      for (let start = 0; start < prune.length; start += WRITE_BATCH_SIZE) {
        await session.run(PRUNE_MEMBER_EDGES_CYPHER, { prune: prune.slice(start, start + WRITE_BATCH_SIZE) });
      }
    } finally {
      await session.close();
    }
  }

  private async deleteStale(ids: string[]): Promise<void> {
    const session = this.driver.session();
    try {
      for (let start = 0; start < ids.length; start += WRITE_BATCH_SIZE) {
        await session.run(DELETE_STALE_CYPHER, { staleIds: ids.slice(start, start + WRITE_BATCH_SIZE) });
      }
    } finally {
      await session.close();
    }
  }

  private async writeSummary(id: string, summary: string, theme: string): Promise<void> {
    const session = this.driver.session();
    try {
      await session.run(WRITE_SUMMARY_CYPHER, { id, summary, theme, updatedAt: new Date().toISOString() });
    } finally {
      await session.close();
    }
  }
}
