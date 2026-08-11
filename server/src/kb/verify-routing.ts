/**
 * End-to-end retrieval verification (G2.S3.T4).
 *
 * 1. Ingest of a rich sample doc (process + facts + architecture).
 * 2. Confirm it landed in llm_wiki (wiki page + search).
 * 3. Drive Pi AgentSession with intent questions and record which knowledge
 *    tools it calls, verifying intent→tool routing per knowledge-rag-design.md §4.
 *
 * Run: node --import tsx src/kb/verify-routing.ts
 */
import { KnowledgeIngestService } from "./ingest.js";
import { LlmWikiClient } from "./llmwiki.js";
import { createAgent } from "../agents/agent.js";

const tag = `s3rt-${Date.now()}`;
const content = `# ${tag} Engineering Manual

## Incident Response Process (Standard)
Step 1: Acknowledge the alert within 5 minutes.
Step 2: Classify severity into P0/P1/P2.
Step 3: Open a tracking ticket and assign an owner.
Step 4: Post-incident review within 72 hours.

## Fact Sheet
The ${tag} feature flag default value is FAB-${tag}.
The ${tag} subsystem stores its state in Postgres with pgvector.
The ${tag} team owns the ${tag}-frontend repository.

## Architecture
The ${tag} subsystem depends on the ${tag}-core component.
The ${tag}-gateway routes requests to the ${tag} subsystem.
The ${tag}-frontend consumes the ${tag}-gateway API.
`;

async function poll<T>(what: string, fn: () => Promise<T>, check: (v: T) => boolean, timeoutMs = 180000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 8000));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const llmwiki = new LlmWikiClient();
const ingest = new KnowledgeIngestService({ llmwiki });

const { projects } = await llmwiki.listProjects();
const projectId = projects[0]?.id ?? "athena-wiki";

console.log("=== 1. Ingest ===");
const ingestResult = await ingest.ingestMarkdown({
  title: `${tag} Engineering Manual`,
  content,
  source: `${tag}.md`,
});
console.log(JSON.stringify(ingestResult, null, 2));
if (!ingestResult.systems.llmwiki.ok) {
  console.error("FATAL: sample did not ingest into llm_wiki");
  process.exit(1);
}

console.log("\n=== 2. Confirm presence ===");
const wikiFile = await poll("llm_wiki to index the wiki page", () => llmwiki.getFileTree(projectId, { root: "wiki" }), (t) => t.files.some((f) => f.path.includes(tag)));
console.log("llm_wiki wiki file:", wikiFile.files.map((f) => f.path).find((p) => p.includes(tag)));

const wikiSearch = await poll("llm_wiki search index", () => llmwiki.search(projectId, `${tag} Incident Response Process`, { topK: 5 }), (s) => s.results.length > 0);
console.log("llm_wiki search:", wikiSearch.results.map((r) => `${r.path} (${r.score})`).join(", "));

console.log("\n=== 3. Pi intent routing ===");
console.log("(fresh agent per case, restricted to the knowledge tools)");

interface IntentCase {
  label: string;
  question: string;
  expectedTools: string[];
  minTools?: number;
}

const cases: IntentCase[] = [
  {
    label: "process/standard → wiki_search",
    question: `According to the knowledge base, what is Step 1 of the ${tag} Incident Response Process?`,
    expectedTools: ["wiki_search", "wiki_read_page"],
  },
  {
    label: "page/topic links → wiki_graph",
    question: `In the ${tag} architecture, which component does the ${tag} subsystem depend on? Use the wiki graph.`,
    expectedTools: ["wiki_graph"],
  },
];

const results: { label: string; question: string; called: string[]; pass: boolean; reply: string }[] = [];
const knowledgeOnly = ["wiki_search", "wiki_read_page", "wiki_graph"];

for (const c of cases) {
  const agent = await createAgent({ tools: knowledgeOnly });
  const called: string[] = [];
  const unsubscribe = agent.session.subscribe((e) => {
    if (e.type === "tool_execution_start") {
      called.push(e.toolName);
    }
  });
  let reply = "";
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        reply = await agent.prompt(c.question);
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        console.log(`  retry after error (${err instanceof Error ? err.message : String(err)}): ${attempt}/3`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  } finally {
    unsubscribe();
    agent.dispose();
  }
  const uniqueCalled = [...new Set(called)];
  const matched = c.expectedTools.some((t) => uniqueCalled.includes(t));
  const enough = (c.minTools ?? 1) <= uniqueCalled.length;
  const pass = matched && enough;
  results.push({ label: c.label, question: c.question, called: uniqueCalled, pass, reply });
  console.log(`\n[${pass ? "PASS" : "FAIL"}] ${c.label}`);
  console.log(`  tools called: ${uniqueCalled.join(", ") || "(none)"}`);
  console.log(`  reply: ${reply.slice(0, 220)}`);
}

console.log("\n=== 4. Summary ===");
const passed = results.filter((r) => r.pass).length;
for (const r of results) {
  console.log(`  ${r.pass ? "PASS" : "FAIL"}: ${r.label} -> ${r.called.join(", ") || "(no tools)"}`);
}
console.log(`${passed}/${results.length} intent-routing cases passed`);
process.exit(passed === results.length ? 0 : 2);
