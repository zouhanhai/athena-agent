/**
 * athena worker OpenCode plugin — G4.S4.T1/T3 (auto-claim + Progress Log +
 * done double-commit).
 *
 * Loaded at opencode serve startup from the global plugin dir
 * (`~/.config/opencode/plugins/`, G4.S4.T3) and the repo-local
 * `.opencode/plugins/` (git-kanban-design.md §18). This is a THIN deployment
 * wrapper: the entire worker logic lives in the GDD package
 * (`gdd/plugin/src/index.ts`, G4.S6.T3) and is imported by ABSOLUTE path, so
 * fixes land in one place and every project/serve cwd gets the current behavior.
 *
 * Classic V1 plugin module: `export default { id, server }`.
 */

const CORE = "/home/hh/athena-agent/gdd/plugin/src/index.js";

export default {
  id: "athena.worker",

  server: async (
    ctx: {
      project: { id: string };
      directory: string;
      worktree: string;
      client: { app: { log: (args: unknown) => Promise<unknown> } };
    },
    options: { assignee?: string; repoDir?: string; minIntervalMs?: number; now?: () => Date } = {},
  ) => {
    const mod = (await import(CORE)) as {
      createWorkerHooks: (
        ctx: unknown,
        options: unknown,
      ) => Promise<Record<string, unknown>>;
    };
    return mod.createWorkerHooks(ctx, options);
  },
};
