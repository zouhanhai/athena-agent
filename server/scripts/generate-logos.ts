/**
 * Generate the consistent-style animal logo set (G3.S1.T3).
 *
 * Uses the existing owl logo (web/public/athena-logo-ai.png) as a style
 * reference via OpenRouter image-gen (/api/v1/images). Idempotent: only
 * animals missing from web/public/logos/index.json are regenerated.
 *
 * Usage: npm run logos:generate
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FileLogoStore, OpenRouterLogoClient } from "../src/agents/logos.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const store = new FileLogoStore({
  dir: path.join(repoRoot, "web", "public", "logos"),
  client: new OpenRouterLogoClient(),
  referenceImage: readFileSync(path.join(repoRoot, "web", "public", "athena-logo-ai.png")),
});

const logos = await store.ensureGeneratedSet();
console.log(`logo set (${logos.length}):`);
for (const logo of logos) {
  console.log(`  ${logo.animal ?? logo.name} (${logo.color ?? "upload"}) -> ${logo.url}`);
}
await store.close();
