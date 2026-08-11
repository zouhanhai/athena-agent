/**
 * Incremental re-curation tool (G4.S3.T3).
 *
 * Once a topic dir grows (e.g. `wiki/internal/events/`), a curator re-topic a
 * wiki page into a deeper sub-topic dir (e.g. `wiki/internal/events/sommerseminar/`):
 *   - physically move the page file into `wiki/<newTopic>/<basename>.md`
 *   - update the frontmatter `topic` + append the old topic to `topic_history`
 *     (migration audit trail) + bump `last_reviewed` (+ `updated`)
 *   - rebuild wiki/index.md + trigger an llm_wiki rescan so the tree updates
 *
 * Re-curation is wiki-frontmatter + file-move ONLY: `isValidTopic` supports
 * arbitrary depth and topic filtering is wiki-frontmatter driven (G4.S3 core),
 * so there is **no Neo4j re-chunk / re-embed**. The frontmatter patch itself is
 * applied through the canonical `patchFrontmatter` (G4.S3.T1), keeping the wiki
 * md as the single source of truth; the Document node mirror is deliberately
 * NOT invoked — the re-topic leaves RAG chunk data untouched by design.
 */
import { readFile, writeFile, mkdir, rm, rmdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { isValidTopic, type LlmWikiProject } from "./llmwiki.js";
import { patchFrontmatter, parseTopicHistory, wikiLocalPath } from "./wiki-frontmatter.js";
import { rebuildWikiIndex, type WikiIndexEntry } from "./ingest.js";

/** File-system surface the re-curator needs (all injectable for tests). */
export interface ReCurateFs {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  /** Remove a file. */
  rm: (path: string) => Promise<void>;
  /** Remove an empty directory. */
  rmdir: (path: string) => Promise<void>;
  /** List a directory's immediate entries (for empty-parent cleanup + index rebuild). */
  readdir: (path: string) => Promise<WikiIndexEntry[]>;
}

export interface WikiReCuratorOptions {
  /** Local wiki pages dir (project.path/wiki). Resolved lazily via resolveWikiDir when absent. */
  wikiDir?: string;
  resolveWikiDir?: () => Promise<string>;
  /** Injectable file-system surface. Default: node fs/promises. */
  fs?: Partial<ReCurateFs>;
  /** llm_wiki client for the post-move rescan (tree update). Skipped when absent. */
  llmwiki?: { rescan(projectId: string): Promise<unknown>; listProjects(): Promise<{ projects: LlmWikiProject[]; currentProject: LlmWikiProject | null }> };
  /** llm_wiki project id for the rescan. Resolved from listProjects when absent. */
  projectId?: string;
  /** Override the wiki/index.md rebuild. Default scans the wiki dir + rewrites it. */
  rebuildIndex?: (wikiDir: string) => Promise<void>;
}

export interface ReTopicInput {
  /** Project-relative wiki page path, e.g. "wiki/internal/events/sommerseminar.md". */
  path: string;
  /** New (deeper) topic key, e.g. "internal/events/sommerseminar". */
  topic: string;
}

export interface ReTopicResult {
  oldPath: string;
  newPath: string;
  topic: string;
  topicHistory: string[];
  lastReviewed: string;
}

/** Today as YYYY-MM-DD (matching the frontmatter created/updated format). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const nodeFs: ReCurateFs = {
  readFile: async (path) => readFile(path, "utf8"),
  writeFile: async (path, content) => {
    await writeFile(path, content, "utf8");
  },
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  rm: async (path) => {
    await rm(path, { force: true });
  },
  rmdir: async (path) => {
    await rmdir(path);
  },
  readdir: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() })),
};

export class WikiReCurator {
  private readonly wikiDir?: string;
  private readonly resolveWikiDir?: () => Promise<string>;
  private readonly fs: ReCurateFs;
  private readonly llmwiki?: WikiReCuratorOptions["llmwiki"];
  private readonly projectId?: string;
  private readonly rebuildIndex: (wikiDir: string) => Promise<void>;

  constructor(options: WikiReCuratorOptions) {
    this.wikiDir = options.wikiDir;
    this.resolveWikiDir = options.resolveWikiDir;
    this.fs = { ...nodeFs, ...options.fs };
    this.llmwiki = options.llmwiki;
    this.projectId = options.projectId;
    this.rebuildIndex =
      options.rebuildIndex ?? ((dir: string) => this.rebuildIndexDefault(dir));
  }

  private async wikiRoot(): Promise<string> {
    const root = this.wikiDir ?? (await this.resolveWikiDir?.());
    if (!root) throw new Error("wiki dir could not be resolved");
    return root;
  }

  /**
   * Re-topic a wiki page into a deeper topic dir. Physically moves the file,
   * patches the frontmatter (topic + topic_history + last_reviewed + updated),
   * rebuilds wiki/index.md and rescans llm_wiki. No Neo4j re-chunk / re-embed.
   */
  async reTopic(input: ReTopicInput): Promise<ReTopicResult> {
    const topic = input.topic.trim();
    if (!isValidTopic(topic)) {
      throw new Error(`invalid topic: ${input.topic}`);
    }
    const wikiDir = await this.wikiRoot();
    const oldLocal = wikiLocalPath(wikiDir, input.path);
    if (!oldLocal.endsWith(".md")) {
      throw new Error(`invalid wiki page path (must end with .md): ${input.path}`);
    }

    const content = await this.fs.readFile(oldLocal);
    const fm = parseFrontmatter(content);
    const oldTopic = fm.topic?.trim() || undefined;
    if (oldTopic === topic) {
      throw new Error(`page already at topic "${topic}"`);
    }

    const basename = input.path.split("/").pop()!;
    const newPath = `wiki/${topic}/${basename}`;
    const newLocal = wikiLocalPath(wikiDir, newPath);

    // Migration audit trail: append the old topic (dedupe consecutive repeats).
    const history = parseTopicHistory(fm.topic_history);
    if (oldTopic && history[history.length - 1] !== oldTopic) {
      history.push(oldTopic);
    }

    const lastReviewed = today();
    const next = patchFrontmatter(content, {
      topic,
      ...(history.length > 0 ? { topic_history: history } : {}),
      last_reviewed: lastReviewed,
    });

    await this.fs.mkdir(dirname(newLocal));
    await this.fs.writeFile(newLocal, next);
    await this.fs.rm(oldLocal);
    await this.removeEmptyParents(wikiDir, dirname(oldLocal));

    // Rebuild wiki/index.md + llm_wiki rescan so the tree updates. Best-effort:
    // a failing rebuild/rescan never fails the (already-applied) re-topic.
    await this.rebuildIndex(wikiDir);
    await this.rescanWiki();

    return {
      oldPath: input.path,
      newPath,
      topic,
      topicHistory: history,
      lastReviewed,
    };
  }

  /** Walk up from a just-emptied dir, removing every empty parent (stops at the wiki root). */
  private async removeEmptyParents(wikiDir: string, startDir: string): Promise<void> {
    let current = startDir;
    while (current.startsWith(wikiDir) && current !== wikiDir) {
      const entries = await this.fs.readdir(current);
      if (entries.length > 0) break;
      try {
        await this.fs.rmdir(current);
      } catch {
        break;
      }
      current = dirname(current);
    }
  }

  /** Trigger an llm_wiki rescan (Source Watch re-indexes moved/removed pages). */
  private async rescanWiki(): Promise<void> {
    if (!this.llmwiki) return;
    try {
      const projectId = await this.resolveProjectId();
      if (projectId) await this.llmwiki.rescan(projectId);
    } catch {
      // best-effort — the file move + frontmatter already landed.
    }
  }

  private async resolveProjectId(): Promise<string | undefined> {
    if (this.projectId) return this.projectId;
    const { projects, currentProject } = await this.llmwiki!.listProjects();
    return currentProject?.id ?? projects[0]?.id;
  }

  /** Best-effort wiki/index.md rebuild (scan + rewrite grouped by frontmatter type). */
  private async rebuildIndexDefault(wikiDir: string): Promise<void> {
    try {
      await rebuildWikiIndex(wikiDir, {
        readDir: this.fs.readdir,
        readFile: this.fs.readFile,
        writeFile: this.fs.writeFile,
      });
    } catch {
      // index.md is derived data; a scan failure must not fail the re-topic.
    }
  }
}
