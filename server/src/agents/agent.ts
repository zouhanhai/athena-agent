import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  type AgentSession,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createKnowledgeTools, type KnowledgeToolServices } from "../kb/tools.js";
import { LightRagClient } from "../kb/lightrag.js";
import { LlmWikiClient } from "../kb/llmwiki.js";
import { createRefineDocumentTool } from "./refine-document.js";

export interface CreateAgentOptions {
  /** Provider id. Default: "openrouter" */
  providerId?: string;
  /** Model id within the provider. Default: "~deepseek/deepseek-v4-flash-latest" */
  modelId?: string;
  /** Global Pi config dir. Default: ~/.pi/agent */
  agentDir?: string;
  /** Working directory for project-local discovery. Default: process.cwd() */
  cwd?: string;
  /** Pi SessionManager for conversation persistence / per-employee isolation. Default: new persistent session. */
  sessionManager?: SessionManager;
  /** Register the 5 knowledge tools (Agentic RAG routing). Default: true. */
  knowledgeTools?: boolean;
  /** Register the `refine_document` Athena refinement tool. Default: true. */
  refineDocumentTool?: boolean;
  /** Services backing the knowledge tools. Default: live LightRAG + llm_wiki clients. */
  knowledgeToolServices?: KnowledgeToolServices;
  /** Additional custom tools registered on the session. */
  customTools?: ToolDefinition[];
  /** Allowlist of active tool names; when provided only these tools are exposed. */
  tools?: string[];
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

const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MODEL = "~deepseek/deepseek-v4-flash-latest";

/**
 * Create an AgentSession wrapping the Pi SDK (ModelRuntime + OpenRouter).
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

  const customTools: ToolDefinition[] = [];
  if (options.knowledgeTools !== false) {
    customTools.push(
      ...createKnowledgeTools(
        options.knowledgeToolServices ?? {
          lightrag: new LightRagClient(),
          llmwiki: new LlmWikiClient(),
        },
      ),
    );
  }
  customTools.push(...(options.customTools ?? []));

  if (options.refineDocumentTool !== false) {
    customTools.push(createRefineDocumentTool(modelRuntime));
  }

  const { session, extensionsResult } = await createAgentSession({
    model,
    modelRuntime,
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: options.sessionManager,
    customTools,
    tools: options.tools,
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
