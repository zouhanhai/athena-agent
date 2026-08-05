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
 * 多员工会话管理：每个员工一个独立、可复用的 AgentSession。
 * Map<userId, Promise<Agent>> 保证同一员工并发/重复请求只创建一次。
 */
export class AgentManager {
  private readonly agents = new Map<string, Promise<Agent>>();
  private readonly options: AgentManagerOptions;
  private readonly factory: AgentFactory;

  constructor(options: AgentManagerOptions = {}, factory: AgentFactory = defaultAgentFactory) {
    this.options = options;
    this.factory = factory;
  }

  /** 获取或创建该用户的 AgentSession。同员工并发/重复请求复用同一实例。 */
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

  /** 销毁该用户的 AgentSession。若仍在创建中则等待完成后销毁。 */
  async removeAgent(userId: string): Promise<void> {
    const pending = this.agents.get(userId);
    if (!pending) {
      return;
    }
    this.agents.delete(userId);
    try {
      (await pending).dispose();
    } catch {
      // 创建失败则无需销毁
    }
  }

  get size(): number {
    return this.agents.size;
  }

  /** 销毁全部会话。 */
  async dispose(): Promise<void> {
    const pending = [...this.agents.values()];
    this.agents.clear();
    await Promise.allSettled(
      pending.map(async (agentPromise) => {
        try {
          (await agentPromise).dispose();
        } catch {
          // 创建失败则无需销毁
        }
      }),
    );
  }
}
