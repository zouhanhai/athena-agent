/**
 * Neo4j ingest — Athena refinement output → Neo4j (G4.S2.T4).
 *
 * Pure embed + index, NO LLM extraction: the RAG store receives G4.S1's refined
 * output (chunks/entities/relations/keywords/topic from `RefineOutputRef`) and
 * only embeds chunks (via the injectable `TextEmbedder`) + writes nodes/edges
 * with the T3 schema module (`store/schema.ts`).
 *
 * Idempotent-safe: chunks/entities/document are MERGE'd on their unique ids
 * (Chunk.id namespaced by documentId), and relations are MERGE'd between the
 * folded (case-insensitive) entity endpoints — re-ingest updates, never dupes.
 *
 * The driver/embedder are injected through the minimal `Neo4jDriverLike` seam so
 * tests use doubles and production uses the real neo4j-driver.
 */
import { readFile } from "node:fs/promises";
import type { RefineOutputRef } from "../../agents/refine-output.js";
import type { RefinementChunk, RefinementEntity } from "../../agents/refine-document.js";
import type { TextEmbedder } from "../embedding.js";
import {
  CHUNK_LABEL,
  DOCUMENT_LABEL,
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  HAS_SECTION_TYPE,
  HAS_SUBSECTION_TYPE,
  IS_DOCUMENT_TYPE,
  MENTIONED_IN_TYPE,
  PART_OF_TYPE,
  SECTION_LABEL,
  WIKIPAGE_LABEL,
  applyNeo4jSchema,
  entityNodeProps,
  relationEdgeProps,
  type Neo4jDriverLike,
  type Neo4jSessionLike,
} from "./schema.js";

export interface Neo4jIngestOptions {
  driver: Neo4jDriverLike;
  embedder: TextEmbedder;
  /** Read the chunks JSON at a chunks_ref. Injectable for tests. */
  readChunks?: (chunksRef: string) => Promise<RefinementChunk[]>;
  /** Apply the store schema (constraints + indexes) before ingesting. Default true. */
  applySchema?: boolean;
  /** Chunks embedded + written per batch (G4.S3.T8). Default 64 (the embedder's
   *  internal batch size), so one batch = one embed request + write-through. */
  batchSize?: number;
}

export interface Neo4jIngestProgress {
  /** Chunks embedded + written so far (cumulative across batches). */
  chunksStored: number;
  /** Total chunks to embed + write. */
  chunksTotal: number;
  /** Fraction 0..1 of chunks done. */
  progress: number;
}

export interface Neo4jIngestInput {
  /** Athena refinement output (G4.S1.T2 contract): chunks_ref + entities + relations + frontmatter. */
  ref: RefineOutputRef;
  /** Document node id (also namespaces chunk ids so they stay unique across docs). */
  documentId: string;
  /** Document title (llm_wiki display / Document.title). */
  title: string;
  /** The llm_wiki page path written for this doc (e.g. "wiki/events/doc.md"). When
   *  present, a WikiPage node is created and bridged to the Document (G4.S2.T11). */
  wikiPath?: string;
  /** Called after each chunk is MERGE'd + section-linked with cumulative chunk
   *  progress (G4.S3.T8/T9). Per-chunk granularity (not per-batch) so a caller
   *  can show a live elapsed vs chunk-rate ETA. Optional — ingest still reports
   *  the final result on completion. */
  onProgress?: (progress: Neo4jIngestProgress) => void;
}

export interface Neo4jIngestResult {
  chunksStored: number;
  entitiesStored: number;
  relationsStored: number;
}

export interface Neo4jOverwriteResult extends Neo4jIngestResult {
  /** The resolved Document id — via the wikiPath → WikiPage → Document bridge when
   *  present, else the caller-provided `documentId` (G4.S3.T10). Chunk ids are
   *  namespaced by this id, so re-ingest targets the SAME nodes the old version used. */
  documentId: string;
}

const DEFAULT_READ_CHUNKS: (chunksRef: string) => Promise<RefinementChunk[]> = async (chunksRef) => {
  const raw = await readFile(chunksRef, "utf8");
  return JSON.parse(raw) as RefinementChunk[];
};

/**
 * Parse a chunk's `heading_path` into its heading segments (G4.S2.T11). The path
 * format is the refinement's heading chain, e.g. "Sommerseminar / Workshops" (or
 * legacy "# Alpha"); each segment is trimmed and any markdown heading markers
 * ("#") are stripped. Empty paths yield no sections.
 */
export function parseHeadingPath(headingPath: string): string[] {
  return headingPath
    .split("/")
    .map((segment) => segment.trim().replace(/^#+\s*/, ""))
    .filter((segment) => segment.length > 0);
}

/**
 * Compute the Entity → Chunk mention links (G4.S2.T14): an entity is linked to every
 * chunk whose text mentions its canonical name or any alias (case-insensitive
 * substring match). Idempotent by design — the ingest MERGEs these as
 * `(:Entity)-[:MENTIONED_IN]->(:Chunk)` edges. Chunk ids are namespaced by documentId.
 */
export function mentionPairs(
  entities: RefinementEntity[],
  chunks: RefinementChunk[],
  documentId: string,
): Array<{ entityName: string; chunkId: string }> {
  const pairs: Array<{ entityName: string; chunkId: string }> = [];
  for (const entity of entities) {
    const terms = [entity.name, ...(entity.aliases ?? [])]
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length > 0);
    for (const chunk of chunks) {
      const text = chunk.text.toLowerCase();
      if (terms.some((term) => text.includes(term))) {
        pairs.push({ entityName: entity.name, chunkId: `${documentId}:${chunk.id}` });
      }
    }
  }
  return pairs;
}

/**
 * Build the Section chain for a chunk's heading path: one node per heading level
 * with a stable id (`<documentId>:<accumulated path>`), `title` = its own heading
 * text and `path` = the accumulated heading chain (used as the sectionPath at
 * retrieval). Ordered H1 → H2 → … → deepest.
 */
export function sectionChain(documentId: string, headingPath: string): Array<{ id: string; title: string; path: string; documentId: string }> {
  let accumulated = "";
  return parseHeadingPath(headingPath).map((segment) => {
    accumulated = accumulated ? `${accumulated} / ${segment}` : segment;
    return { id: `${documentId}:${accumulated}`, title: segment, path: accumulated, documentId };
  });
}

export class Neo4jIngestService {
  private readonly driver: Neo4jDriverLike;
  private readonly embedder: TextEmbedder;
  private readonly readChunks: (chunksRef: string) => Promise<RefinementChunk[]>;
  private readonly applySchema: boolean;
  private readonly batchSize: number;

  constructor(options: Neo4jIngestOptions) {
    this.driver = options.driver;
    this.embedder = options.embedder;
    this.readChunks = options.readChunks ?? DEFAULT_READ_CHUNKS;
    this.applySchema = options.applySchema !== false;
    this.batchSize = options.batchSize ?? 64;
  }

  /**
   * Embed Athena's chunks + store Document/Chunk/Entity/Relation into Neo4j.
   * Idempotent-safe (MERGE + IF NOT EXISTS schema). No LLM extraction.
   *
   * Chunks are embedded in `batchSize` slices (G4.S3.T8) but written one at a
   * time; the `onProgress` callback fires after EACH chunk's MERGE + section-link
   * with cumulative {chunksStored, chunksTotal, progress} (G4.S3.T9) — so callers
   * stream X/Y live instead of waiting for one big embed.
   */
  async ingest(input: Neo4jIngestInput): Promise<Neo4jIngestResult> {
    if (this.applySchema) {
      await applyNeo4jSchema(this.driver);
    }

    const chunks = await this.readChunks(input.ref.chunks_ref);
    const total = chunks.length;

    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (d:${DOCUMENT_LABEL} {id: $id})
         SET d.topic = $topic, d.type = $type, d.md_ref = $mdRef, d.title = $title,
             d.keywords = $keywords, d.summary = $summary,
             d.read_count = COALESCE(d.read_count, 0), d.confidence = COALESCE(d.confidence, 1.0)`,
        {
          id: input.documentId,
          topic: input.ref.frontmatter?.topic ?? "",
          type: input.ref.frontmatter?.type ?? "",
          mdRef: input.ref.md_ref,
          title: input.title,
          keywords: input.ref.keywords ?? [],
          summary: input.ref.summary ?? "",
        },
      );

      // RAG↔Wiki fusion bridge (G4.S2.T11): a WikiPage node per llm_wiki page,
      // Document -[:IS_DOCUMENT]-> WikiPage. Skipped when no wiki path is known
      // (legacy direct ingest).
      if (input.wikiPath) {
        await session.run(
          `MATCH (d:${DOCUMENT_LABEL} {id: $documentId})
           MERGE (wp:${WIKIPAGE_LABEL} {id: $wikiPath})
           SET wp.path = $wikiPath, wp.topic = $topic, wp.title = $title
           MERGE (d)-[:${IS_DOCUMENT_TYPE}]->(wp)`,
          {
            documentId: input.documentId,
            wikiPath: input.wikiPath,
            topic: input.ref.frontmatter?.topic ?? "",
            title: input.title,
          },
        );
      }

      const report = (stored: number): void => {
        input.onProgress?.({
          chunksStored: stored,
          chunksTotal: total,
          progress: total > 0 ? stored / total : 1,
        });
      };

      // Embed + write chunks in batches so writes stream through (G4.S3.T8).
      // `report` fires PER CHUNK, right after the chunk's MERGE + section-link
      // (G4.S3.T9), so the frontend's elapsed-vs-chunk-rate ETA stays live.
      for (let start = 0; start < chunks.length; start += this.batchSize) {
        const slice = chunks.slice(start, start + this.batchSize);
        const embeddings =
          slice.length > 0 ? await this.embedder.embed(slice.map((c) => c.text)) : [];

        for (let i = 0; i < slice.length; i += 1) {
          const chunk = slice[i]!;
          const chunkId = `${input.documentId}:${chunk.id}`;
          await session.run(
            `MERGE (c:${CHUNK_LABEL} {id: $id})
             SET c.text = $text, c.embedding = $embedding, c.topic = $topic, c.heading_path = $heading_path,
                 c.documentId = $documentId`,
            {
              id: chunkId,
              text: chunk.text,
              embedding: embeddings[i] ?? [],
              topic: input.ref.frontmatter?.topic ?? "",
              heading_path: chunk.heading_path,
              documentId: input.documentId,
            },
          );

          // Section chain (H1 → H2 → … → deepest): Document -[:HAS_SECTION]-> H1,
          // Section -[:HAS_SUBSECTION]-> child, Chunk -[:PART_OF]-> deepest. MERGE
          // everywhere = idempotent on re-ingest. The Document/Chunk are MATCHed
          // (already created by the queries above) — MERGE-ing them inside a
          // multi-node pattern would trip the unique-constraint conflict when the
          // node exists but the pattern doesn't yet. A chunk with no heading
          // segments simply keeps no PART_OF edge (matches pre-T11 behavior).
          const sections = sectionChain(input.documentId, chunk.heading_path ?? "");
          if (sections.length > 0) {
            await session.run(
              `MATCH (d:${DOCUMENT_LABEL} {id: $documentId})
               UNWIND $sections AS s
               MERGE (sec:${SECTION_LABEL} {id: s.id})
               SET sec.title = s.title, sec.path = s.path, sec.documentId = s.documentId
               WITH d, collect(sec) AS chain
               WITH d, chain, chain[0] AS first, chain[size(chain) - 1] AS deepest
               MATCH (c:${CHUNK_LABEL} {id: $chunkId})
               MERGE (d)-[:${HAS_SECTION_TYPE}]->(first)
               MERGE (c)-[:${PART_OF_TYPE}]->(deepest)
               WITH c, chain
               UNWIND [i IN range(0, size(chain) - 2)] AS i
               WITH c, chain[i] AS parent, chain[i + 1] AS child
               MERGE (parent)-[:${HAS_SUBSECTION_TYPE}]->(child)`,
              { documentId: input.documentId, sections, chunkId },
            );
          }
          report(Math.min(start + i + 1, total));
        }
      }

      // Layered summaries (G4.S2.T13): set each section summary on its matching Section node
      // (matched by title, case-insensitive, within this document). The Section nodes above are
      // keyed by `documentId` so nested sections are covered too. Skipped when the ref has none.
      if ((input.ref.sections ?? []).length > 0) {
        await session.run(
          `UNWIND $sectionSummaries AS ss
           MATCH (d:${DOCUMENT_LABEL} {id: $documentId})
           MATCH (sec:${SECTION_LABEL} {documentId: d.id})
           WHERE toLower(trim(sec.title)) = toLower(trim(ss.title))
           SET sec.summary = ss.summary`,
          { sectionSummaries: input.ref.sections ?? [], documentId: input.documentId },
        );
      }

      for (const entity of input.ref.entities ?? []) {
        await session.run(
          `MERGE (e:${ENTITY_LABEL} {name: $name})
           SET e.aliases = $aliases, e.type = $type, e.description = $description, e.nameUpper = $nameUpper`,
          entityNodeProps(entity),
        );
      }

      // Entity → Chunk mention links (G4.S2.T14): each Entity is MERGE'd to every Chunk
      // whose text mentions its name/alias, so the graph retriever can fall through from
      // a matched entity to the chunks that actually answer a query. Skipped when no
      // entity is mentioned in any chunk.
      const mentions = mentionPairs(input.ref.entities ?? [], chunks, input.documentId);
      if (mentions.length > 0) {
        await session.run(
          `UNWIND $mentions AS m
           MATCH (e:${ENTITY_LABEL} {name: m.entityName})
           MATCH (c:${CHUNK_LABEL} {id: m.chunkId})
           MERGE (e)-[:${MENTIONED_IN_TYPE}]->(c)`,
          { mentions },
        );
      }

      for (const relation of input.ref.relations ?? []) {
        await session.run(
          `MATCH (a:${ENTITY_LABEL} {nameUpper: $sourceUpper})
           MATCH (b:${ENTITY_LABEL} {nameUpper: $targetUpper})
           MERGE (a)-[r:${ENTITY_RELATION_TYPE}]->(b)
           SET r.keywords = $keywords, r.description = $description`,
          relationEdgeProps(relation),
        );
      }
    } finally {
      await session.close();
    }

    return {
      chunksStored: chunks.length,
      entitiesStored: (input.ref.entities ?? []).length,
      relationsStored: (input.ref.relations ?? []).length,
    };
  }

  /**
   * Overwrite a previously-ingested document in place (G4.S3.T10), located via
   * its `wikiPath` (WikiPage → IS_DOCUMENT → Document):
   *   1. Resolve the existing Document id (keeps chunk-id namespacing stable).
   *   2. Delete the old version's stale Chunk/Section nodes (DETACH DELETE also
   *      removes their MENTIONED_IN / PART_OF / HAS_SECTION edges).
   *   3. Embed + MERGE the corrected chunks — UNCHANGED chunks (same id + text +
   *      existing embedding) are NOT re-embedded, so a localized edit avoids a
   *      full re-chunk/re-embed (the diff-aware refinement's promise).
   *   4. MERGE the corrected entities/relations/mentions; then drop stale
   *      RELATION edges between entities no longer mentioned anywhere and
   *      orphaned Entity nodes.
   * Idempotent: a doc with no prior version behaves exactly like `ingest`.
   */
  async overwrite(input: Neo4jIngestInput): Promise<Neo4jOverwriteResult> {
    if (this.applySchema) {
      await applyNeo4jSchema(this.driver);
    }

    const chunks = await this.readChunks(input.ref.chunks_ref);
    const total = chunks.length;

    const session = this.driver.session();
    try {
      const documentId = await this.resolveDocumentId(session, input.wikiPath, input.documentId);

      await session.run(
        `MERGE (d:${DOCUMENT_LABEL} {id: $id})
         SET d.topic = $topic, d.type = $type, d.md_ref = $mdRef, d.title = $title,
             d.keywords = $keywords, d.summary = $summary,
             d.read_count = COALESCE(d.read_count, 0), d.confidence = COALESCE(d.confidence, 1.0)`,
        {
          id: documentId,
          topic: input.ref.frontmatter?.topic ?? "",
          type: input.ref.frontmatter?.type ?? "",
          mdRef: input.ref.md_ref,
          title: input.title,
          keywords: input.ref.keywords ?? [],
          summary: input.ref.summary ?? "",
        },
      );

      if (input.wikiPath) {
        await session.run(
          `MATCH (d:${DOCUMENT_LABEL} {id: $documentId})
           MERGE (wp:${WIKIPAGE_LABEL} {id: $wikiPath})
           SET wp.path = $wikiPath, wp.topic = $topic, wp.title = $title
           MERGE (d)-[:${IS_DOCUMENT_TYPE}]->(wp)`,
          {
            documentId,
            wikiPath: input.wikiPath,
            topic: input.ref.frontmatter?.topic ?? "",
            title: input.title,
          },
        );
      }

      // Snapshot the current chunk texts/embeddings so unchanged chunks are NOT re-embedded.
      const existing = await this.loadExistingChunks(session, documentId);

      // Delete the OLD version's chunks not in the new set (DETACH DELETE drops
      // MENTIONED_IN edges) and its sections (DETACH DELETE drops PART_OF/HAS_SECTION).
      const newIds = chunks.map((chunk) => `${documentId}:${chunk.id}`);
      await session.run(
        `MATCH (c:${CHUNK_LABEL} {documentId: $documentId})
         WHERE NOT c.id IN $ids
         DETACH DELETE c`,
        { documentId, ids: newIds },
      );
      await session.run(
        `MATCH (s:${SECTION_LABEL} {documentId: $documentId}) DETACH DELETE s`,
        { documentId },
      );

      // Classify chunks: unchanged (same text + existing embedding) keep their
      // embedding; changed/new chunks are embedded (batched) + written.
      const changed: Array<{ index: number; chunk: RefinementChunk; id: string }> = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]!;
        const id = `${documentId}:${chunk.id}`;
        const prev = existing.get(id);
        if (!prev || prev.text !== chunk.text || !prev.hasEmbedding) {
          changed.push({ index: i, chunk, id });
        }
      }
      const embeddingsByIndex = new Map<number, number[]>();
      for (let start = 0; start < changed.length; start += this.batchSize) {
        const slice = changed.slice(start, start + this.batchSize);
        if (slice.length === 0) continue;
        const embeddings = await this.embedder.embed(slice.map((c) => c.chunk.text));
        slice.forEach((entry, k) => embeddingsByIndex.set(entry.index, embeddings[k] ?? []));
      }

      const report = (stored: number): void => {
        input.onProgress?.({
          chunksStored: stored,
          chunksTotal: total,
          progress: total > 0 ? stored / total : 1,
        });
      };

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]!;
        const id = `${documentId}:${chunk.id}`;
        const embedding = embeddingsByIndex.get(i);
        const write = embedding !== undefined;
        await session.run(
          write
            ? `MERGE (c:${CHUNK_LABEL} {id: $id})
               SET c.text = $text, c.embedding = $embedding, c.topic = $topic,
                   c.heading_path = $heading_path, c.documentId = $documentId`
            : `MERGE (c:${CHUNK_LABEL} {id: $id})
               SET c.text = $text, c.topic = $topic, c.heading_path = $heading_path,
                   c.documentId = $documentId`,
          {
            id,
            text: chunk.text,
            ...(write ? { embedding } : {}),
            topic: input.ref.frontmatter?.topic ?? "",
            heading_path: chunk.heading_path,
            documentId,
          },
        );

        // Rebuild the Section chain from the corrected chunk's heading path.
        const sections = sectionChain(documentId, chunk.heading_path ?? "");
        if (sections.length > 0) {
          await session.run(
            `MATCH (d:${DOCUMENT_LABEL} {id: $documentId})
             UNWIND $sections AS s
             MERGE (sec:${SECTION_LABEL} {id: s.id})
             SET sec.title = s.title, sec.path = s.path, sec.documentId = s.documentId
             WITH d, collect(sec) AS chain
             WITH d, chain, chain[0] AS first, chain[size(chain) - 1] AS deepest
             MATCH (c:${CHUNK_LABEL} {id: $chunkId})
             MERGE (d)-[:${HAS_SECTION_TYPE}]->(first)
             MERGE (c)-[:${PART_OF_TYPE}]->(deepest)
             WITH c, chain
             UNWIND [i IN range(0, size(chain) - 2)] AS i
             WITH c, chain[i] AS parent, chain[i + 1] AS child
             MERGE (parent)-[:${HAS_SUBSECTION_TYPE}]->(child)`,
            { documentId, sections, chunkId: id },
          );
        }
        report(Math.min(i + 1, total));
      }

      if ((input.ref.sections ?? []).length > 0) {
        await session.run(
          `UNWIND $sectionSummaries AS ss
           MATCH (d:${DOCUMENT_LABEL} {id: $documentId})
           MATCH (sec:${SECTION_LABEL} {documentId: d.id})
           WHERE toLower(trim(sec.title)) = toLower(trim(ss.title))
           SET sec.summary = ss.summary`,
          { sectionSummaries: input.ref.sections ?? [], documentId },
        );
      }

      for (const entity of input.ref.entities ?? []) {
        await session.run(
          `MERGE (e:${ENTITY_LABEL} {name: $name})
           SET e.aliases = $aliases, e.type = $type, e.description = $description, e.nameUpper = $nameUpper`,
          entityNodeProps(entity),
        );
      }

      const mentions = mentionPairs(input.ref.entities ?? [], chunks, documentId);
      if (mentions.length > 0) {
        await session.run(
          `UNWIND $mentions AS m
           MATCH (e:${ENTITY_LABEL} {name: m.entityName})
           MATCH (c:${CHUNK_LABEL} {id: m.chunkId})
           MERGE (e)-[:${MENTIONED_IN_TYPE}]->(c)`,
          { mentions },
        );
      }

      for (const relation of input.ref.relations ?? []) {
        await session.run(
          `MATCH (a:${ENTITY_LABEL} {nameUpper: $sourceUpper})
           MATCH (b:${ENTITY_LABEL} {nameUpper: $targetUpper})
           MERGE (a)-[r:${ENTITY_RELATION_TYPE}]->(b)
           SET r.keywords = $keywords, r.description = $description`,
          relationEdgeProps(relation),
        );
      }

      // Stale graph cleanup: relations between entities that the (corrected)
      // corpus no longer mentions anywhere, and fully orphaned Entity nodes.
      await session.run(
        `MATCH (a:${ENTITY_LABEL})-[r:${ENTITY_RELATION_TYPE}]->(b:${ENTITY_LABEL})
         WHERE NOT (a)-[:${MENTIONED_IN_TYPE}]->(:${CHUNK_LABEL})
           AND NOT (b)-[:${MENTIONED_IN_TYPE}]->(:${CHUNK_LABEL})
         DELETE r`,
      );
      await session.run(
        `MATCH (e:${ENTITY_LABEL}) WHERE NOT (e)--() DELETE e`,
      );

      return {
        chunksStored: chunks.length,
        entitiesStored: (input.ref.entities ?? []).length,
        relationsStored: (input.ref.relations ?? []).length,
        documentId,
      };
    } finally {
      await session.close();
    }
  }

  /** Resolve the real Document id via the wikiPath bridge, falling back to the
   *  caller-provided id (no prior version → behaves like a fresh ingest). */
  private async resolveDocumentId(
    session: Neo4jSessionLike,
    wikiPath: string | undefined,
    fallback: string,
  ): Promise<string> {
    if (!wikiPath) return fallback;
    const result = (await session.run(
      `MATCH (wp:${WIKIPAGE_LABEL} {id: $wikiPath})<-[:${IS_DOCUMENT_TYPE}]-(d:${DOCUMENT_LABEL})
       RETURN d.id AS id`,
      { wikiPath },
    )) as { records?: Array<{ get(key: string): unknown }> };
    const id = result?.records?.[0]?.get?.("id");
    return id === undefined || id === null ? fallback : String(id);
  }

  /** Load the current chunk texts + embedding presence for a document (id → {text, hasEmbedding}). */
  private async loadExistingChunks(
    session: Neo4jSessionLike,
    documentId: string,
  ): Promise<Map<string, { text: string; hasEmbedding: boolean }>> {
    const result = (await session.run(
      `MATCH (c:${CHUNK_LABEL} {documentId: $documentId})
       RETURN c.id AS id, c.text AS text, c.embedding IS NOT NULL AS hasEmbedding`,
      { documentId },
    )) as { records?: Array<{ get(key: string): unknown }> };
    const out = new Map<string, { text: string; hasEmbedding: boolean }>();
    for (const record of result?.records ?? []) {
      const id = record.get?.("id");
      if (id === undefined || id === null) continue;
      out.set(String(id), {
        text: String(record.get?.("text") ?? ""),
        hasEmbedding: record.get?.("hasEmbedding") === true,
      });
    }
    return out;
  }
}
