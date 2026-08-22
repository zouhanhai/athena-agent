import { buildApp } from "./app.js";

// G4.S8.T19 pipeline review: a server started OUTSIDE scripts/start-all.sh
// silently ran without the Neo4j store (env unset → driver undefined) — every
// ingest marked the graph stage done as a no-op and the graph stayed EMPTY.
// Shed light on that configuration at boot; tolerance itself is by design.
if (!process.env.NEO4J_PASSWORD) {
  console.warn(
    "[neo4j] NEO4J_PASSWORD is NOT set — the Neo4j RAG store is NOT wired. " +
      "Ingests will mark the graph stage done WITHOUT writing Document/Chunk/Entity rows. " +
      "Start via scripts/start-all.sh (exports NEO4J_*) or export NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD.",
  );
}

// G4.S8.T15: auditScheduler opts the REAL server into the weekly KB audit
// (KB_AUDIT_ENABLED/DAY/HOUR env-configurable; catch-up run at startup when
// a window was missed). Test builds never pass this flag.
const app = buildApp({ auditScheduler: true });

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
