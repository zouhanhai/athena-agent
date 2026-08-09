/**
 * Build the kanban root index (G3.S4.T7) — scan docs/kanban/*.md and write
 * docs/kanban/kanban-index.json so GET /api/kanban can serve the whole board
 * from a single file without re-scanning on each refresh.
 *
 * The runtime trigger is rescan-on-refresh (`GET /api/kanban?rescan=1`); this
 * script is the explicit build/index step (e.g. before committing a fresh index).
 *
 * Usage: npm run kanban:index
 */
import { defaultBoardRoot } from "../src/kanban/scan.js";
import { buildIndexFile, indexFilePath } from "../src/kanban/index-file.js";

const root = defaultBoardRoot();
const index = await buildIndexFile(root);
const goals = index.goals.length;
const tickets = index.goals.reduce(
  (n, goal) => n + goal.specs.reduce((m, spec) => m + spec.tickets.length, 0),
  0,
);
console.log(`kanban index written: ${indexFilePath(root)}`);
console.log(`  version ${index.version} · ${goals} goals · ${tickets} tickets · generated ${index.generated_at}`);
