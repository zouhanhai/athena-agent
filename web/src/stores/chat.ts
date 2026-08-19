import { defineStore } from "pinia";
import { streamChat, fetchChatHistory, type ChatHistoryTurn } from "@/api/chat";
import { sendFeedback, type FeedbackDirection } from "@/api/feedback";
import type { ChatClarification, ToolProgress } from "@/api/sse";

export type ChatSpeakerKind = "agent" | "employee";
export type ChatMessageRole = "user" | "assistant" | "system";

/** Who said a message — an agent (S1) or an employee (S2). */
export interface ChatSpeaker {
  id: string;
  kind: ChatSpeakerKind;
  name: string;
  logoUrl: string;
}

/**
 * A participant (agent/employee) in the shared conversation, shown as a card.
 */
export interface ChatParticipant extends ChatSpeaker {
  capabilities: string[];
  /** Speak permission: on = responds, off = reads context only. */
  speak: boolean;
  /** Page context injected when this participant joined (onAgentJoined). */
  joinedPage?: string;
  /** G4.S7.T4: registered identity of a remote agent — when set, messages route
   *  to that agent over its reverse WS tunnel instead of the local Athena session. */
  agentId?: string;
}

/** G4.S7.T4: one tool-progress row streamed by a remote agent (tool.started/completed). */
export interface ToolProgressRow {
  name: string;
  state: "started" | "completed" | "failed";
  detail?: string;
  error?: string;
  /** G4.S7.T11: the tool result content streamed back (optional). */
  output?: string;
}

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  speaker?: ChatSpeaker;
  /** G4.S3.T5: the user's thumbs up/down on this assistant answer (set via rateMessage). */
  feedback?: FeedbackDirection | null;
  /** G4.S3.T13: a real clarification follow-up (question + options) the user must answer. */
  clarification?: ChatClarification | null;
  /** G4.S3.T13: whether the clarification has been answered (options hidden once chosen). */
  clarificationAnswered?: boolean;
  /** G4.S7.T4: tool progress rows streamed alongside the answer (collapsed to a status pill). */
  progress?: ToolProgressRow[];
  /** G4.S7.T4: a remote agent's reasoning/thinking tokens, rendered separately from the answer. */
  thinking?: string;
}

interface ChatState {
  messages: ChatMessage[];
  loading: boolean;
  error: string;
  userId: string;
  /** Current route path — sent with each message so the server injects page-aware capabilities. */
  page: string;
  /** Participants (agent/employee cards) in the shared conversation. */
  participants: ChatParticipant[];
  /** The human behind the user bubbles (current employee, or a default fallback). */
  userSpeaker: ChatSpeaker;
}

/** Pages whose capabilities are injected into the chat context (server-side). */
export const PAGE_LABELS: Record<string, string> = {
  "/knowledge": "Knowledge",
  "/wiki": "Wiki",
  "/workbench": "Workbench",
  "/uploads": "Uploads",
};

/** Default local Athena agent (G3.S1) — the initial participant and assistant speaker. */
const DEFAULT_ATHENA_PARTICIPANT: ChatParticipant = {
  id: "athena",
  kind: "agent",
  name: "Athena",
  logoUrl: "/athena-logo-ai.png",
  capabilities: ["llm_wiki", "knowledge graph Q&A"],
  speak: true,
};

const DEFAULT_USER_SPEAKER: ChatSpeaker = {
  id: "hermes",
  kind: "employee",
  name: "Hermes",
  logoUrl: "",
};

export const useChatStore = defineStore("chat", {
  state: (): ChatState => ({
    messages: [],
    loading: false,
    error: "",
    userId: "hermes",
    page: "",
    participants: [{ ...DEFAULT_ATHENA_PARTICIPANT }],
    userSpeaker: { ...DEFAULT_USER_SPEAKER },
  }),
  actions: {
    /** Track the current page (route path). Switching tabs never resets the conversation. */
    setPage(page: string) {
      this.page = page;
    },
    /** Set the human behind user bubbles (the signed-in employee, G3.S2). */
    setUserSpeaker(speaker: ChatSpeaker) {
      this.userSpeaker = { ...speaker };
    },
    /**
     * G4.S7.T11-followup: restore this employee's persisted chat history (F5
     * persistence). Called once the signed-in employee is known. Server rows
     * are ordered oldest-first; system join/leave notices are not persisted.
     */
    async loadHistory() {
      if (!this.userId) return;
      try {
        const rows = await fetchChatHistory(this.userId, 200);
        const restored: ChatMessage[] = rows.map((row) => {
          if (row.role === "assistant") {
            const speaker =
              this.participants.find((p) => p.id === row.speaker_id) ??
              this.participants.find((p) => p.id === "athena");
            return {
              role: "assistant",
              content: row.content,
              speaker: speaker ?? {
                id: row.speaker_id || "athena",
                kind: "agent",
                name: row.speaker_name || "Athena",
                logoUrl: "",
              },
              thinking: row.thinking || undefined,
              progress: Array.isArray(row.progress) && row.progress.length > 0
                ? (row.progress as unknown as ToolProgressRow[])
                : undefined,
            };
          }
          return {
            role: "user" as const,
            content: row.content,
            speaker: this.userSpeaker,
          };
        });
        if (restored.length > 0) {
          this.messages = restored;
        }
      } catch (err) {
        // History restore is best-effort; a failed fetch must not block chat.
        console.warn("[chat] history restore failed:", err);
      }
    },
    /** The participant that speaks for the assistant bubbles — the last joined agent with speak on, else Athena. */
    speakingAgent(): ChatParticipant {
      const speaking = [...this.participants]
        .reverse()
        .find((p) => p.kind === "agent" && p.speak);
      return speaking ?? DEFAULT_ATHENA_PARTICIPANT;
    },
    /**
     * onAgentJoined hook: a user adds an agent/employee to the chat → inject the
     * current page context into that agent, notify other participants, and show the card.
     */
    onAgentJoined(input: Omit<ChatParticipant, "speak" | "joinedPage">): ChatParticipant {
      const existing = this.participants.find((p) => p.id === input.id);
      if (existing) return existing;
      const pageLabel = this.page ? PAGE_LABELS[this.page] ?? "" : "";
      const participant: ChatParticipant = {
        ...input,
        speak: true,
        joinedPage: pageLabel || undefined,
      };
      this.participants.push(participant);
      this.messages.push({
        role: "system",
        content: `${participant.name} joined the conversation${pageLabel ? ` (context: ${pageLabel})` : ""}.`,
      });
      return participant;
    },
    /** onSpeakToggleChanged hook: flip a card's speak-toggle → update the agent's speak permission. */
    onSpeakToggleChanged(id: string, speak: boolean): void {
      const participant = this.participants.find((p) => p.id === id);
      if (participant) {
        participant.speak = speak;
      }
    },
    /** onAgentLeft hook: X removes the agent card → clean up its context + notify participants. */
    onAgentLeft(id: string): void {
      const participant = this.participants.find((p) => p.id === id);
      if (!participant) return;
      this.participants = this.participants.filter((p) => p.id !== id);
      this.messages.push({
        role: "system",
        content: `${participant.name} left the conversation.`,
      });
    },
    /**
     * G4.S7.T10: the accumulated conversation sent as `history` with each chat
     * request so a remote agent keeps multi-turn context. Filters out system
     * notices and empty assistant placeholders; the server is the authority on
     * truncation/summarization above its token threshold.
     *
     * G4.S7.T11: each assistant turn carries its accumulated `thinking` and the
     * tool OUTPUT of its last completed tool (when present) so the prior
     * reasoning + tool results are replayed to the agent. The `output` is taken
     * from the completed/failed tool row (the first with an output); the
     * `toolName`/`toolCallId` identify the tool for the remote runtime.
     */
    historyForRequest(): ChatHistoryTurn[] {
      return this.messages
        .filter(
          (m) =>
            (m.role === "user" || m.role === "assistant") &&
            m.content.trim().length > 0,
        )
        .map((m) => {
          const turn: ChatHistoryTurn = { role: m.role, content: m.content };
          if (m.role === "assistant" && m.thinking && m.thinking.trim().length > 0) {
            turn.thinking = m.thinking;
          }
          if (m.role === "assistant" && m.progress) {
            const done = m.progress.find((r) => r.state !== "started" && r.output);
            if (done) {
              turn.toolOutput = done.output;
              turn.toolName = done.name;
            }
          }
          return turn;
        });
    },
    /**
     * Send a message: append a user bubble + empty assistant bubble,
     * stream the reply chunk by chunk into the assistant bubble. When the
     * stream relays a clarification (G4.S3.T13), the assistant bubble becomes
     * the question + options instead of a dead-end answer.
     */
    async send(message: string) {
      const text = message.trim();
      if (!text || this.loading) return;

      // Capture history BEFORE appending the current message so the request
      // carries prior turns only (the server appends `message` itself).
      const history = this.historyForRequest();

      this.messages.push({ role: "user", content: text, speaker: this.userSpeaker });
      this.loading = true;
      this.error = "";

      const agent = this.speakingAgent();
      const assistantIndex =
        this.messages.push({
          role: "assistant",
          content: "",
          speaker: agent,
        }) - 1;

      const onDelta = (delta: string): void => {
        this.messages[assistantIndex]!.content += delta;
      };
      const onTool = (tool: ToolProgress): void => {
        this.appendToolProgress(assistantIndex, tool);
      };
      const onThinking = (thinking: string): void => {
        const msg = this.messages[assistantIndex];
        if (msg) {
          msg.thinking = (msg.thinking ?? "") + thinking;
        }
      };
      const onClarify = (clarify: ChatClarification): void => {
        const msg = this.messages[assistantIndex];
        if (msg) {
          msg.clarification = clarify;
          msg.content = clarify.question;
        }
      };
      const onError = (errMessage: string): void => {
        this.error = errMessage;
        if (this.messages[assistantIndex]!.content === "") {
          this.messages.splice(assistantIndex, 1);
        }
      };

      try {
        // G4.S7.T4: a remote agent participant carries its registered identity →
        // route the message over its reverse WS tunnel; otherwise the local session.
        // G4.S7.T10: history rides along on BOTH paths — the server decides what
        // to do with it (local sessions keep their own history; remote tasks fold
        // it in / summarize it).
        if (agent.agentId) {
          await streamChat(this.userId, text, { onDelta, onTool, onThinking, onClarify, onError }, this.page, undefined, agent.agentId, history);
        } else {
          await streamChat(this.userId, text, { onDelta, onClarify, onThinking, onTool, onError }, this.page, undefined, undefined, history);
        }
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
      }
    },

    /** G4.S7.T4: apply a remote agent's tool-progress event to an assistant bubble. */
    appendToolProgress(messageIndex: number, tool: ToolProgress): void {
      const msg = this.messages[messageIndex];
      if (!msg) return;
      const rows = (msg.progress ?? []).slice();
      if (tool.state === "started") {
        rows.push({ name: tool.name, state: tool.state, detail: tool.detail, error: tool.error });
      } else {
        let idx = -1;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (rows[i]!.name === tool.name) {
            idx = i;
            break;
          }
        }
        const row = { name: tool.name, state: tool.state, detail: tool.detail, error: tool.error, output: tool.output };
        if (idx !== -1) {
          rows[idx] = row;
        } else {
          rows.push(row);
        }
      }
      msg.progress = rows;
    },
    /**
     * G4.S3.T13: the user picked an option on a clarification. Feeds the choice
     * back to the server so it re-runs the original query with the chosen
     * context, streaming the real answer into a new assistant bubble.
     */
    async answerClarification(messageIndex: number, answer: string) {
      const msg = this.messages[messageIndex];
      const clarification = msg?.clarification;
      const text = answer.trim();
      if (!clarification || !text || this.loading) return;
      const query = clarification.query ?? this.messages[messageIndex - 1]?.content ?? "";

      // G4.S7.T10: carry the accumulated history (prior turns only) so the
      // re-run still has multi-turn context on the remote path.
      const history = this.historyForRequest();

      msg.clarificationAnswered = true;
      this.messages.push({ role: "user", content: text, speaker: this.userSpeaker });
      this.loading = true;
      this.error = "";

      const agent = this.speakingAgent();
      const assistantIndex =
        this.messages.push({
          role: "assistant",
          content: "",
          speaker: agent,
        }) - 1;

      try {
        if (agent.agentId) {
          await streamChat(
            this.userId,
            text,
            {
              onDelta: (delta) => {
                this.messages[assistantIndex]!.content += delta;
              },
              onError: (errMessage) => {
                this.error = errMessage;
                if (this.messages[assistantIndex]!.content === "") {
                  this.messages.splice(assistantIndex, 1);
                }
              },
            },
            this.page,
            { query, answer: text },
            agent.agentId,
            history,
          );
        } else {
          await streamChat(this.userId, text, {
            onDelta: (delta) => {
              this.messages[assistantIndex]!.content += delta;
            },
            onError: (errMessage) => {
              this.error = errMessage;
              if (this.messages[assistantIndex]!.content === "") {
                this.messages.splice(assistantIndex, 1);
              }
            },
          }, this.page, { query, answer: text }, undefined, history);
        }
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
      }
    },
    /**
     * G4.S3.T5: rate the assistant answer at `index` (thumbs up/down). Persists
     * the Q&A pair + feedback server-side (deduped by vector similarity) and
     * stores the chosen direction on the message so the button stays active.
     * Re-rating the same direction is a no-op.
     */
    async rateMessage(index: number, feedback: FeedbackDirection) {
      const assistant = this.messages[index];
      if (!assistant || assistant.role !== "assistant" || assistant.feedback === feedback) {
        return;
      }
      const question = this.messages[index - 1];
      try {
        await sendFeedback({
          question: question?.role === "user" ? question.content : "",
          answer: assistant.content,
          sources: [],
          feedback,
        });
        assistant.feedback = feedback;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
    },

    reset() {
      this.messages = [];
      this.loading = false;
      this.error = "";
      this.participants = [{ ...DEFAULT_ATHENA_PARTICIPANT }];
      this.userSpeaker = { ...DEFAULT_USER_SPEAKER };
    },
  },
});
