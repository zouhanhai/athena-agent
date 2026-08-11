/**
 * Live verification for wiki-page ingestion (G2.S3.T2).
 * Ingests a unique sample Markdown through the real service and confirms it
 * lands in llm_wiki (file tree + search).
 *
 * Run: node --import tsx src/kb/verify-ingest.ts
 */
import { KnowledgeIngestService } from "./ingest.js";
import { LlmWikiClient } from "./llmwiki.js";

const tag = `s3-verify-${Date.now()}`;
const title = `S3 Ingest Verification ${tag}`;
const content = `# S3 Ingest Verification ${tag}

This is a unique sample document to verify the wiki-page ingestion path.
The magic marker phrase is ${tag}-marker. The subject is the ${tag} subsystem.
`;

const llmwiki = new LlmWikiClient();
const service = new KnowledgeIngestService({
  llmwiki,
  wikiDir: process.env.LLM_WIKI_WIKI_DIR ?? undefined,
  projectId: process.env.LLM_WIKI_PROJECT_ID ?? undefined,
});

const { projects } = await llmwiki.listProjects();
const projectId = projects[0]?.id ?? "athena-wiki";

const result = await service.ingestMarkdown({ title, content, source: `${tag}.md` });
console.log("ingest result:", JSON.stringify(result, null, 2));
if (!result.systems.llmwiki.ok) {
  console.error("FATAL: llm_wiki failed to ingest");
  process.exit(1);
}

async function poll<T>(what: string, fn: () => Promise<T>, check: (v: T) => boolean, timeoutMs = 120000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const tree = await poll(
  `llm_wiki to index wiki page for ${tag}.md`,
  () => llmwiki.getFileTree(projectId, { root: "wiki" }),
  (t) => t.files.some((f) => f.path.includes(tag)),
);
console.log("llm_wiki wiki file:", tree.files.map((f) => f.path).find((p) => p.includes(tag)));

const search = await poll(
  `llm_wiki search index to contain ${tag}`,
  () => llmwiki.search(projectId, `${tag}-marker`, { topK: 5 }),
  (s) => s.results.length > 0,
);
console.log("llm_wiki search:", search.results.map((r) => `${r.path} (${r.score})`).join(", "));

console.log("OK: sample document landed in llm_wiki");
process.exit(0);
