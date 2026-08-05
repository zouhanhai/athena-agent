import { join } from "node:path";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAgent, type Agent, type CreateAgentOptions } from "./agent.js";

export interface AgentManagerOptions extends CreateAgentOptions {
  /** Base dir holding one sub-dir per employee's persistent sessions. Default: <agentDir>/sessions/employees */
  sessionDir?: string;
  /** Keep sessions in memory only (no file persistence). Default: false */
  inMemory?: boolean;
}

export type AgentFactory = (userId: string, options: AgentManagerOptions) => Promise<Agent>;

/** Encode an arbitrary userId into a filesystem-safe directory name. */
function encodeUserId(userId: string): string {
  return Buffer.from(userId).toString("base64url");
}

/**
 * Build the persistent (or in-memory) Pi SessionManager for one employee.
 * Each employee gets their own session sub-dir, so restarts resume the same
 * conversation while different employees stay fully isolated.
 */
export function createEmployeeSessionManager(
  userId: string,
  options: AgentManagerOptions = {},
): SessionManager {
  if (options.inMemory) {
    return SessionManager.inMemory(options.cwd);
  }
  const baseDir =
    options.sessionDir ?? join(options.agentDir ?? getAgentDir(), "sessions", "employees");
  return SessionManager.continueRecent(options.cwd ?? process.cwd(), join(baseDir, encodeUserId(userId)));
}

async function defaultAgentFactory(userId: string, options: AgentManagerOptions): Promise<Agent> {
  const sessionManager = createEmployeeSessionManager(userId, options);
  return createAgent({ ...options, sessionManager });
}

/**
 * Multi-employee session management: each employee gets an independent, reusable AgentSession.
 * Map<userId, Promise<Agent>> ensures concurrent/duplicate requests for the same employee create only once.
 */
export class AgentManager {
  private readonly agents = new Map<string, Promise<Agent>>();
  private readonly options: AgentManagerOptions;
  private readonly factory: AgentFactory;

  constructor(options: AgentManagerOptions = {}, factory: AgentFactory = defaultAgentFactory) {
    this.options = options;
    this.factory = factory;
  }

  /** Get or create the AgentSession for a user. Concurrent/duplicate requests for the same employee reuse one instance. */
  getAgent(userId: string): Promise<Agent> {
    const existing = this.agents.get(userId);
    if (existing) {
      return existing;
    }
    const creating = this.factory(userId, this.options);
    creating.catch(() => {
      if (this.agents.get(userId) === creating) {
        this.agents.delete(userId);
      }
    });
    this.agents.set(userId, creating);
    return creating;
  }

  /** Dispose the AgentSession for a user. If still creating, wait for completion before disposing. */
  async removeAgent(userId: string): Promise<void> {
    const pending = this.agents.get(userId);
    if (!pending) {
      return;
    }
    this.agents.delete(userId);
    try {
      (await pending).dispose();
    } catch {
      // No need to dispose if creation failed
    }
  }

  get size(): number {
    return this.agents.size;
  }

  /**
   * Read the conversation history of the current session for an employee (for tests/audit).
   * Returns an empty array when the session has not been created or creation failed.
   */
  async getSessionMessages(
    userId: string,
  ): Promise<Array<{ role: string; content: string }>> {
    const pending = this.agents.get(userId);
    if (!pending) {
      return [];
    }
    try {
      const agent = await pending;
      const { messages } = agent.session.sessionManager.buildSessionContext();
      return messages.map((m) => {
        const content = (m as { content?: unknown }).content;
        return {
          role: m.role,
          content: typeof content === "string" ? content : JSON.stringify(m),
        };
      });
    } catch {
      return [];
    }
  }

  /** Dispose all sessions. */
  async dispose(): Promise<void> {
    const pending = [...this.agents.values()];
    this.agents.clear();
    await Promise.allSettled(
      pending.map(async (agentPromise) => {
        try {
          (await agentPromise).dispose();
        } catch {
          // No need to dispose if creation failed
        }
      }),
    );
  }
}
