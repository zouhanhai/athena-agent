/**
 * ContentDedupStore + normalization helpers (G2.S5.T14).
 *
 * Two-layer content dedup so identical content is stored once:
 *  - Layer 1 (exact): normalize markdown → plain text → sha256. Normalization
 *    strips format artifacts (PDF "## headings" vs DOCX "**bold**" headings both
 *    become "headings") so the SAME content from DIFFERENT formats hashes equal.
 *  - Layer 1b (long docs): chunk-hash sequence comparison. Long documents are
 *    split into word-bounded chunks (~1000 tokens); a doc whose chunk-hash
 *    sequence matches an existing doc is a duplicate.
 */
import { createHash } from "node:crypto";

/** sha256 hex digest of a string. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Normalize parsed markdown into comparable plain text: strip YAML frontmatter,
 * HTML comments, image/media placeholders, emphasis/heading/list/table/code
 * markers, then collapse whitespace + lowercase. The result is stable across
 * docling renderings of the same source content (PDF vs DOCX vs image OCR).
 */
export function normalizeMarkdown(text: string): string {
  return text
    // yaml frontmatter block at the very start
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    // html comments
    .replace(/<!--[\s\S]*?-->/g, " ")
    // images / media placeholders ![alt](src)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    // links [label](url) → keep label only
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // fenced code blocks
    .replace(/```[\s\S]*?```/g, " ")
    // inline code
    .replace(/`([^`]*)`/g, " $1 ")
    // emphasis / bold markers
    .replace(/\*+/g, "")
    .replace(/_+/g, "")
    // ATX headings (#, ##, ...)
    .replace(/^\s*#{1,6}\s+/gm, "")
    // blockquotes
    .replace(/^\s*>\s?/gm, "")
    // unordered list markers
    .replace(/^\s*[-*+]\s+/gm, "")
    // ordered list markers
    .replace(/^\s*\d+[.)]\s+/gm, "")
    // table pipe separators
    .replace(/\|/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Split normalized text into word-bounded chunks (~chunkWords tokens each) and
 * return the sha256 of every chunk. A single chunk (short doc) yields one hash.
 */
export function hashChunks(normalizedText: string, chunkWords = 1000): string[] {
  const words = normalizedText.split(" ");
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += chunkWords) {
    chunks.push(words.slice(i, i + chunkWords).join(" "));
  }
  return chunks.map(sha256Hex);
}

/** True when two chunk-hash sequences are identical (order + count). */
export function compareChunkHashes(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((hash, i) => hash === b[i]);
}

export interface ExistingPage {
  /** Source label / wiki path of the page. */
  path: string;
  /** Raw page content (frontmatter + body). */
  content: string;
}

export interface DedupCheckResult {
  duplicate: boolean;
  /** Which layer flagged the duplicate. */
  method?: "hash" | "chunks";
  /** Source label of the previously stored document. */
  existingSource?: string;
}

interface StoredDoc {
  source: string;
  fullHash: string;
  chunkHashes: string[];
}

export interface ContentDedupStoreOptions {
  /**
   * Load existing stored content (e.g. all llm_wiki pages) so a fresh server
   * can still detect duplicates ingested in a previous session. Called once,
   * lazily, and the in-memory index is then updated by record().
   */
  loadExisting: () => Promise<ExistingPage[]>;
  /** Chunk size in words for long-doc hashing. Default: 1000. */
  chunkWords?: number;
}

export class ContentDedupStore {
  private readonly loadExisting: () => Promise<ExistingPage[]>;
  private readonly chunkWords: number;
  private docs: StoredDoc[] = [];
  private readonly byFullHash = new Map<string, StoredDoc>();
  private readonly byChunkSeq = new Map<string, StoredDoc>();
  private seeded = false;
  private seedPromise?: Promise<void>;

  constructor(options: ContentDedupStoreOptions) {
    this.loadExisting = options.loadExisting;
    this.chunkWords = options.chunkWords ?? 1000;
  }

  /** Lazy, once-only seed from the configured source. */
  private async ensureSeeded(): Promise<void> {
    if (this.seeded) return;
    if (!this.seedPromise) {
      this.seedPromise = (async () => {
        try {
          for (const page of await this.loadExisting()) {
            this.recordInternal(page.content, page.path);
          }
        } finally {
          this.seeded = true;
        }
      })();
    }
    return this.seedPromise;
  }

  private recordInternal(content: string, source: string): void {
    const normalized = normalizeMarkdown(content);
    const fullHash = sha256Hex(normalized);
    if (this.byFullHash.has(fullHash)) return;
    const chunkHashes = hashChunks(normalized, this.chunkWords);
    const doc: StoredDoc = { source, fullHash, chunkHashes };
    this.docs.push(doc);
    this.byFullHash.set(fullHash, doc);
    if (chunkHashes.length > 1) {
      this.byChunkSeq.set(chunkHashes.join(","), doc);
    }
  }

  /** Check whether content already exists (exact hash, then chunk sequence). */
  async check(content: string): Promise<DedupCheckResult> {
    await this.ensureSeeded();
    const normalized = normalizeMarkdown(content);
    const fullHash = sha256Hex(normalized);

    const fullHit = this.byFullHash.get(fullHash);
    if (fullHit) {
      return { duplicate: true, method: "hash", existingSource: fullHit.source };
    }

    const chunks = hashChunks(normalized, this.chunkWords);
    if (chunks.length > 1) {
      const seqHit = this.byChunkSeq.get(chunks.join(","));
      if (seqHit) {
        return { duplicate: true, method: "chunks", existingSource: seqHit.source };
      }
    }

    return { duplicate: false };
  }

  /** Record newly stored content so future uploads of it are detected. */
  async record(content: string, source: string): Promise<void> {
    await this.ensureSeeded();
    this.recordInternal(content, source);
  }

  /** Number of indexed documents (for diagnostics). */
  size(): number {
    return this.docs.length;
  }
}
