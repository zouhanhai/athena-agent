import { defineStore } from "pinia";
import { streamChat } from "@/api/chat";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatState {
  messages: ChatMessage[];
  loading: boolean;
  error: string;
  userId: string;
}

export const useChatStore = defineStore("chat", {
  state: (): ChatState => ({
    messages: [],
    loading: false,
    error: "",
    userId: "hermes",
  }),
  actions: {
    /**
     * Send a message: append a user bubble + empty assistant bubble,
     * stream the reply chunk by chunk into the assistant bubble.
     */
    async send(message: string) {
      const text = message.trim();
      if (!text || this.loading) return;

      this.messages.push({ role: "user", content: text });
      this.loading = true;
      this.error = "";

      const assistantIndex = this.messages.push({ role: "assistant", content: "" }) - 1;

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
        });
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
      }
    },
    reset() {
      this.messages = [];
      this.loading = false;
      this.error = "";
    },
  },
});
