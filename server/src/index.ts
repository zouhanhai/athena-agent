import { buildApp } from "./app.js";

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
