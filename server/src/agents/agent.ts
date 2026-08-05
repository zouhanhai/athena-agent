import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  type AgentSession,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

export interface CreateAgentOptions {
  /** Provider id. Default: "deepseek" */
  providerId?: string;
  /** Model id within the provider. Default: "deepseek-v4-flash" */
  modelId?: string;
  /** Global Pi config dir. Default: ~/.pi/agent */
  agentDir?: string;
  /** Working directory for project-local discovery. Default: process.cwd() */
  cwd?: string;
  /** Pi SessionManager for conversation persistence / per-employee isolation. Default: new persistent session. */
  sessionManager?: SessionManager;
}

export interface Agent {
  session: AgentSession;
  /** "providerId/modelId" of the active model */
  model: string;
  /** Pi packages (extensions) loaded from ~/.pi/agent */
  packages: string[];
  /** Extension load errors, empty if all packages loaded cleanly */
  extensionErrors: string[];
  /** Send a prompt and resolve with the assistant's final text */
  prompt(text: string): Promise<string>;
  dispose(): void;
}

const DEFAULT_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-v4-flash";

/**
 * Create an AgentSession wrapping the Pi SDK (ModelRuntime + DeepSeek).
 * Reusable per-employee entry point for personal conversations.
 */
export async function createAgent(options: CreateAgentOptions = {}): Promise<Agent> {
  const providerId = options.providerId ?? DEFAULT_PROVIDER;
  const modelId = options.modelId ?? DEFAULT_MODEL;

  const modelRuntime = await ModelRuntime.create(
    options.agentDir
      ? {
          authPath: join(options.agentDir, "auth.json"),
          modelsPath: join(options.agentDir, "models.json"),
          modelsStorePath: join(options.agentDir, "models-store.json"),
        }
      : undefined,
  );
  const model = modelRuntime.getModel(providerId, modelId);
  if (!model) {
    throw new Error(
      `Model ${providerId}/${modelId} not found. Check ~/.pi/agent/auth.json and models.json.`,
    );
  }

  const { session, extensionsResult } = await createAgentSession({
    model,
    modelRuntime,
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: options.sessionManager,
  });

  const packages = extensionsResult.extensions.map((ext) =>
    ext.path.split("/").filter(Boolean).slice(-2).join("/"),
  );
  const extensionErrors = extensionsResult.errors.map((err) => `${err.path}: ${err.error}`);

  return {
    session,
    model: `${model.provider}/${model.id}`,
    packages,
    extensionErrors,
    async prompt(text: string): Promise<string> {
      await session.prompt(text);
      return session.getLastAssistantText() ?? "";
    },
    dispose(): void {
      session.dispose();
    },
  };
}
