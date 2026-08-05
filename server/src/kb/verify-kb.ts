/**
 * Live verification for the kb service layer (G2.S3.T1).
 * Run: node --import tsx src/kb/verify-kb.ts
 */
import { LightRagClient } from "./lightrag.js";
import { LlmWikiClient } from "./llmwiki.js";

const lightrag = new LightRagClient();
const llmwiki = new LlmWikiClient();

const lightragHealth = await lightrag.getHealth();
console.log("LightRAG health:", lightragHealth.status);

const wikiHealth = await llmwiki.getHealth();
console.log("llm_wiki health:", wikiHealth.status, wikiHealth.version);

const { projects, currentProject } = await llmwiki.listProjects();
console.log("llm_wiki projects:", projects.map((p) => p.id).join(", "), "current:", currentProject?.id ?? "none");

const { files } = await llmwiki.getFileTree(projects[0].id, { root: "wiki" });
console.log("llm_wiki wiki files:", files.map((f) => f.path).join(", "));

const { results } = await llmwiki.search(projects[0].id, "athena", { topK: 3 });
console.log("llm_wiki search 'athena':", results.map((r) => `${r.path} (${r.score})`).join(", "));

const wikiGraph = await llmwiki.getGraph(projects[0].id);
console.log("llm_wiki graph:", wikiGraph.nodes.length, "nodes,", wikiGraph.edges.length, "edges");

const query = await lightrag.query("What is athena-agent?", { mode: "hybrid", topK: 3, includeChunkContent: true });
console.log("LightRAG query response:", query.response.slice(0, 120));
console.log("LightRAG references:", query.references?.map((r) => r.file_path).join(", "));

const graph = await lightrag.getGraph("Pi SDK");
console.log("LightRAG graph (Pi SDK):", graph.nodes.length, "nodes,", graph.edges.length, "edges");

process.exit(0);
