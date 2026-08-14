/**
 * Optional athena employee-store credential fallback for GDD.
 *
 * GDD resolves GitHub credentials LOCALLY first (gh auth token → GITHUB_TOKEN),
 * so it runs standalone on the user's machine with no athena server/DB. The
 * athena Postgres employee store is an OPTIONAL last-resort fallback, only used
 * "when running inside athena" (DATABASE_URL set). To keep the gdd/ package
 * statically decoupled from athena, the athena employee module is loaded with a
 * lazy dynamic import guarded by try/catch — on a fresh machine (no athena
 * server code, no DATABASE_URL) this module is a no-op and GDD never touches
 * the employee store.
 */

import type { EmployeeCredentialReader } from "./credential.js";

/** True when the athena Postgres employee store looks reachable (running inside athena). */
export function employeeStoreAvailable(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Build the athena employee-store reader, or undefined when the store is not
 * available (standalone machine / no DATABASE_URL). The reader resolves the
 * employee's stored GitHub credential via athena's Postgres employee registry.
 */
export async function athenaEmployeeReader(): Promise<EmployeeCredentialReader | undefined> {
  if (!employeeStoreAvailable()) {
    return undefined;
  }
  try {
    const { defaultSecretCipher } = await import("../../server/src/employees/crypto.js");
    const { PostgresEmployeeRegistry } = await import("../../server/src/employees/employees.js");
    const connectionString = process.env.DATABASE_URL as string;
    const cipher = defaultSecretCipher();
    return async (email: string) => {
      const registry = new PostgresEmployeeRegistry({ connectionString, cipher });
      try {
        await registry.seed();
        const credential = await registry.getGithubCredential(email);
        return credential ? { type: "token" as const, value: credential.value } : null;
      } finally {
        await registry.close();
      }
    };
  } catch {
    // athena's employee module is not resolvable from this layout — no fallback.
    return undefined;
  }
}
