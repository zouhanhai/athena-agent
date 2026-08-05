import Fastify, { type FastifyInstance } from "fastify";
import { AgentManager } from "./agents/manager.js";
import { registerChatRoutes } from "./routes/chat.js";

export interface BuildAppOptions {
  manager?: AgentManager;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const manager = options.manager ?? new AgentManager();

  app.get("/health", async () => {
    return { status: "ok" };
  });

  registerChatRoutes(app, { manager });

  return app;
}
