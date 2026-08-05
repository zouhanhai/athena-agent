/**
 * Verify Pi AgentSession uses OpenRouter + registers the 5 knowledge tools (G2.S3.T3).
 * Run: node --import tsx src/kb/verify-pi-tools.ts
 */
import { createAgent } from "../agents/agent.js";

const agent = await createAgent();
try {
  console.log("model:", agent.model);

  const allTools = agent.session.getAllTools();
  const knowledgeTools = [
    "knowledge_search",
    "query_graph",
    "wiki_search",
    "wiki_read_page",
    "wiki_graph",
  ];
  const registered = allTools.map((t) => t.name);
  console.log("knowledge tools registered:", knowledgeTools.filter((n) => registered.includes(n)).join(", "));
  const missing = knowledgeTools.filter((n) => !registered.includes(n));
  if (missing.length > 0) {
    console.error("MISSING tools:", missing.join(", "));
    process.exit(1);
  }

  const active = agent.session.getActiveToolNames();
  console.log("active knowledge tools:", knowledgeTools.filter((n) => active.includes(n)).join(", ") || "(none)");
  const activeMissing = knowledgeTools.filter((n) => !active.includes(n));
  if (activeMissing.length > 0) {
    console.error("NOT ACTIVE:", activeMissing.join(", "));
    process.exit(1);
  }

  if (!agent.model.startsWith("openrouter")) {
    console.error("FAIL: agent model is not OpenRouter:", agent.model);
    process.exit(1);
  }
  console.log("OK: Pi uses OpenRouter and all 5 knowledge tools are registered + active");
} finally {
  agent.dispose();
  process.exit(0);
}
