/**
 * Neo4j driver factory for the lean RAG store (G4.S2.T4, ADR-0008).
 *
 * Reads connection config from env (NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD) and
 * returns a real neo4j-driver instance. The store's `Neo4jDriverLike` seam makes
 * the driver interchangeable with test doubles.
 */
import neo4j from "neo4j-driver";
import type { Neo4jDriverLike } from "./schema.js";

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

/** Resolve Neo4j connection config from env. Returns undefined when unset (store not wired). */
export function neo4jConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Neo4jConfig | undefined {
  const password = env.NEO4J_PASSWORD;
  if (!password) return undefined;
  return {
    uri: env.NEO4J_URI ?? "bolt://localhost:7687",
    user: env.NEO4J_USER ?? "neo4j",
    password,
  };
}

/** Create a real neo4j-driver session-like wrapper (bolt:// URI). */
export function createNeo4jDriver(config: Neo4jConfig): Neo4jDriverLike {
  const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
  return {
    session() {
      const session = driver.session();
      return {
        run: async (query: string, params?: Record<string, unknown>) => session.run(query, params),
        close: async () => session.close(),
      };
    },
  };
}
