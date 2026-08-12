import { defineStore } from "pinia";
import { streamChat } from "@/api/chat";
import { sendFeedback, type FeedbackDirection } from "@/api/feedback";
import type { ChatClarification } from "@/api/sse";

export type ChatSpeakerKind = "agent" | "employee";
export type ChatMessageRole = "user" | "assistant" | "system";

/** Who said a message — an agent (S1) or an employee (S2). */
export interface ChatSpeaker {
  id: string;
  kind: ChatSpeakerKind;
  name: string;
  logoUrl: string;
}

/** A participant (agent/employee) in the shared conversation, shown as a card. */
export interface ChatParticipant extends ChatSpeaker {
  capabilities: string[];
  /** Speak permission: on = responds, off = reads context only. */
  speak: boolean;
  /** Page context injected when this participant joined (onAgentJoined). */
  joinedPage?: string;
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
    /** The participant that speaks for the assistant bubbles — the last joined agent with speak on, else Athena. */
    speakingAgent(): ChatSpeaker {
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
     * Send a message: append a user bubble + empty assistant bubble,
     * stream the reply chunk by chunk into the assistant bubble. When the
     * stream relays a clarification (G4.S3.T13), the assistant bubble becomes
     * the question + options instead of a dead-end answer.
     */
    async send(message: string) {
      const text = message.trim();
      if (!text || this.loading) return;

      this.messages.push({ role: "user", content: text, speaker: this.userSpeaker });
      this.loading = true;
      this.error = "";

      const assistantIndex =
        this.messages.push({
          role: "assistant",
          content: "",
          speaker: this.speakingAgent(),
        }) - 1;

      try {
        await streamChat(this.userId, text, {
          onDelta: (delta) => {
            this.messages[assistantIndex]!.content += delta;
          },
          onClarify: (clarify) => {
            const msg = this.messages[assistantIndex];
            if (msg) {
              msg.clarification = clarify;
              msg.content = clarify.question;
            }
          },
          onError: (errMessage) => {
            this.error = errMessage;
            if (this.messages[assistantIndex]!.content === "") {
              this.messages.splice(assistantIndex, 1);
            }
          },
        }, this.page);
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
      }
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

      msg.clarificationAnswered = true;
      this.messages.push({ role: "user", content: text, speaker: this.userSpeaker });
      this.loading = true;
      this.error = "";

      const assistantIndex =
        this.messages.push({
          role: "assistant",
          content: "",
          speaker: this.speakingAgent(),
        }) - 1;

      try {
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
        }, this.page, { query, answer: text });
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
