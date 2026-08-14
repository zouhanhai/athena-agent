/**
 * gdd — Git-Driven Development, the generic agent-agnostic dev-flow protocol.
 *
 * Runs on the USER's local machine (plan/code agents): kanban protocol/sync
 * modules, the sync-github CLI, git hooks, opencode plugins and GST templates.
 * athena is only an OPTIONAL viewer — it never imports this package's sync
 * internals; the shared github-sync was split (G4.S6.T3) so GDD owns the sync
 * half and athena owns the read half (buildGithubProjectBoard).
 */

export * from "./credential.js";
export { athenaEmployeeReader, employeeStoreAvailable } from "./athena-employee.js";
export * from "./github/types.js";
export { GithubClient, GithubAuthError, GithubCredentialUnsupportedError } from "./github/client.js";
export * from "./kanban/index.js";
