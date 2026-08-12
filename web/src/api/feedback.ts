/**
 * Feedback loop API (G4.S3.T5): thumbs up/down on a chat answer → stored Q&A
 * pair + source confidence reinforce/fade.
 */

export type FeedbackDirection = "up" | "down";

export interface QaSource {
  /** Wiki page path, e.g. "wiki/events/c-day.md". */
  path?: string;
  /** Alias used by RAG search hits (G4.S2.T11). */
  wikiPath?: string;
  title?: string;
  snippet?: string;
}

export interface QaPair {
  id: string;
  question: string;
  answer: string;
  sources: QaSource[];
  feedback: FeedbackDirection | null;
  created_at: string;
  updated_at: string;
}

export interface SendFeedbackInput {
  question: string;
  answer: string;
  sources?: QaSource[];
  feedback: FeedbackDirection;
}

export interface ConfidenceUpdate {
  path: string;
  feedback: FeedbackDirection;
  from: number;
  to: number;
}

export interface SendFeedbackResult {
  pair: QaPair;
  /** True when the question matched an existing pair by vector similarity. */
  deduped: boolean;
  matchedQuestion?: string;
  confidenceUpdates: ConfidenceUpdate[];
}

const FEEDBACK_ENDPOINT = "/api/kb/feedback";
const QA_ENDPOINT = "/api/kb/qa";

/**
 * Record a chat answer's thumbs up/down. Stores the Q&A pair (deduped by vector
 * similarity) and reinforces/fades the source pages' confidence. Throws an Error
 * on failure (includes HTTP status code or network error).
 */
export async function sendFeedback(input: SendFeedbackInput): Promise<SendFeedbackResult> {
  const res = await fetch(FEEDBACK_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  return (await res.json()) as SendFeedbackResult;
}

/** List the stored Q&A pairs (feedback loop + manual) for the Terms & QA tab. */
export async function listQaPairs(): Promise<QaPair[]> {
  const res = await fetch(QA_ENDPOINT);
  if (!res.ok) {
    throw new Error(`Request failed with status ${res.status}`);
  }
  const data = (await res.json()) as { pairs: QaPair[] };
  return data.pairs;
}
