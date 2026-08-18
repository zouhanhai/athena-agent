import type { AgentWsGateway } from "../ws/agent.js";
import { buildPageInjection } from "./page-context.js";
import type { AgentRegistry } from "./registry.js";
import { buildTaskMessages, type ChatTurn, type Summarizer } from "./chat-context.js";

/** Handlers the SSE chat route attaches to a task pushed over the reverse tunnel. */
export interface RemoteChatStreamHandlers {
  onToolStarted?(tool: string, detail?: string): void;
  onToolCompleted?(tool: string, detail?: string, error?: string): void;
  onDelta?(text: string): void;
  /** Reasoning/thinking tokens, relayed separately from the final answer text. */
  onThinking?(text: string): void;
  onDone?(): void;
  onError?(message: string): void;
}

export interface RemoteChatResult {
  /** Assigned task id, or null when the agent is offline (no live reverse tunnel). */
  taskId: string | null;
}

/** Context-management knobs for building the task messages (G4.S7.T10). */
export interface RemoteChatContextOptions {
  /** Estimated-token threshold; history above it is summarized/truncated. */
  thresholdTokens: number;
  /** Number of most-recent turns always kept verbatim. */
  recentMaxTurns: number;
  /** LLM seam distilling the old turns; absent → truncation note fallback. */
  summarizer?: Summarizer;
}

/**
 * G4.S7.T4 chat routing: push a user prompt to a SELECTED remote agent over its
 * reverse WebSocket tunnel. The agent runs the task (Hermes `POST
 * /v1/chat/completions`, SSE) against its own LOCAL API server and streams
 * back tool.started / tool.completed + text deltas (+ optional thinking
 * tokens), which the relay forwards to the SSE consumer. The platform only
 * ever drives the agent through the established outbound connection — never by
 * connecting to its api_url.
 *
 * G4.S7.T10 context management: `history` (accumulated user/assistant turns) is
 * folded into the task messages via buildTaskMessages — passed through verbatim
 * below the token threshold, summarized/truncated above it (see chat-context.ts).
 *
 * Protocol boundary note (Q2): this WS frame format is the platform's private
 * reverse-tunnel protocol; A2A (JSON-RPC 2.0 task/statusUpdate/artifact) is
 * deferred to M6 (per the G4.S7 spec). When M6 lands, this mapping/adapter is
 * the single point to translate into A2A task frames — routes/store stay intact.
 *
 * Returns `{ taskId: null }` when the agent is not connected (behind NAT it
 * must first connect INTO the platform).
 */
export async function pushRemoteChatTask(
  hub: AgentWsGateway,
  registry: AgentRegistry | undefined,
  agentId: string,
  message: string,
  page: string | undefined,
  history: ChatTurn[],
  context: RemoteChatContextOptions,
  handlers: RemoteChatStreamHandlers,
): Promise<RemoteChatResult> {
  const agent = registry ? await registry.getByAgentId(agentId) : null;
  if (!agent) {
    throw new Error(`agent "${agentId}" is not registered`);
  }
  const injection = buildPageInjection(page);
  const messages = await buildTaskMessages(history, message, injection || undefined, {
    thresholdTokens: context.thresholdTokens,
    recentMaxTurns: context.recentMaxTurns,
    summarizer: context.summarizer,
  });

  const taskId = hub.sendTask(
    agentId,
    { type: "chat.completions", messages },
    {
      onToolStarted: (tool, detail) => handlers.onToolStarted?.(tool, detail),
      onToolCompleted: (tool, detail, error) => handlers.onToolCompleted?.(tool, detail, error),
      onDelta: (text) => handlers.onDelta?.(text),
      onThinking: (text) => handlers.onThinking?.(text),
      onComplete: () => handlers.onDone?.(),
      onError: (err) => handlers.onError?.(err),
    },
  );
  return { taskId };
}