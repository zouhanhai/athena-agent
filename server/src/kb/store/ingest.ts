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
import type { RefinementChunk } from "../../agents/refine-document.js";
import type { TextEmbedder } from "../embedding.js";
import {
  CHUNK_LABEL,
  DOCUMENT_LABEL,
  ENTITY_LABEL,
  ENTITY_RELATION_TYPE,
  HAS_SECTION_TYPE,
  HAS_SUBSECTION_TYPE,
  IS_DOCUMENT_TYPE,
  PART_OF_TYPE,
  SECTION_LABEL,
  WIKIPAGE_LABEL,
  applyNeo4jSchema,
  entityNodeProps,
  relationEdgeProps,
  type Neo4jDriverLike,
} from "./schema.js";

export interface Neo4jIngestOptions {
  driver: Neo4jDriverLike;
  embedder: TextEmbedder;
  /** Read the chunks JSON at a chunks_ref. Injectable for tests. */
  readChunks?: (chunksRef: string) => Promise<RefinementChunk[]>;
  /** Apply the store schema (constraints + indexes) before ingesting. Default true. */
  applySchema?: boolean;
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
}

export interface Neo4jIngestResult {
  chunksStored: number;
  entitiesStored: number;
  relationsStored: number;
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

  constructor(options: Neo4jIngestOptions) {
    this.driver = options.driver;
    this.embedder = options.embedder;
    this.readChunks = options.readChunks ?? DEFAULT_READ_CHUNKS;
    this.applySchema = options.applySchema !== false;
  }

  /**
   * Embed Athena's chunks + store Document/Chunk/Entity/Relation into Neo4j.
   * Idempotent-safe (MERGE + IF NOT EXISTS schema). No LLM extraction.
   */
  async ingest(input: Neo4jIngestInput): Promise<Neo4jIngestResult> {
    if (this.applySchema) {
      await applyNeo4jSchema(this.driver);
    }

    const chunks = await this.readChunks(input.ref.chunks_ref);
    const embeddings = chunks.length > 0 ? await this.embedder.embed(chunks.map((c) => c.text)) : [];

    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (d:${DOCUMENT_LABEL} {id: $id})
         SET d.topic = $topic, d.type = $type, d.md_ref = $mdRef, d.title = $title,
             d.keywords = $keywords`,
        {
          id: input.documentId,
          topic: input.ref.frontmatter?.topic ?? "",
          type: input.ref.frontmatter?.type ?? "",
          mdRef: input.ref.md_ref,
          title: input.title,
          keywords: input.ref.keywords ?? [],
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

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i]!;
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
      }

      for (const entity of input.ref.entities ?? []) {
        await session.run(
          `MERGE (e:${ENTITY_LABEL} {name: $name})
           SET e.aliases = $aliases, e.type = $type, e.description = $description, e.nameUpper = $nameUpper`,
          entityNodeProps(entity),
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
}
