/**
 * "Send feedback": checks a comment and emails it to the team through Resend.
 *
 * Shared by the send-feedback Edge Function and the local-mode route in dev/,
 * so it uses only fetch and plain TypeScript (no Deno or Node globals). The
 * caller reads its own environment and passes the settings in.
 *
 * The recipient address lives only in server configuration (FEEDBACK_TO_EMAIL);
 * it is never sent to, or known by, the browser.
 */

export const MAX_FEEDBACK_WORDS = 4000;
/**
 * A backstop on raw size, since one "word" can be any length. Far above what
 * 4,000 real words take (about 25,000 characters), so only junk hits it.
 */
export const MAX_FEEDBACK_CHARS = 60_000;

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
/** Per person, per server instance. A light brake on accidental or scripted floods. */
export const FEEDBACK_LIMIT = 5;
export const FEEDBACK_WINDOW_MS = 10 * 60 * 1000;

export interface FeedbackInput {
  message: string;
  page: string | null;
  sentAt: string | null;
}

export interface FeedbackSender {
  userId: string;
  email: string | null;
}

export interface FeedbackConfig {
  resendApiKey: string | null;
  to: string | null;
  /** Must be a sender Resend has verified. Resend's test sender works until a domain is set up. */
  from: string | null;
}

export type FeedbackOutcome =
  | { status: "sent" }
  | { status: "logged" }
  | { status: "failed"; detail: string };

/** The comment and its context from a request body, or an error message for the person. */
export function readFeedbackInput(body: unknown): FeedbackInput | { error: string } {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!message) return { error: "Write a comment before sending." };
  if (message.length > MAX_FEEDBACK_CHARS || countWords(message) > MAX_FEEDBACK_WORDS) {
    return { error: `Please keep feedback under ${MAX_FEEDBACK_WORDS.toLocaleString("en-US")} words.` };
  }
  const page = typeof record.page === "string" ? record.page.slice(0, 300) : null;
  const sentAt = typeof record.sent_at === "string" ? record.sent_at.slice(0, 40) : null;
  return { message, page, sentAt };
}

const recentSends = new Map<string, number[]>();

/** True when this person has sent too much feedback lately. Records the attempt when allowed. */
export function overFeedbackLimit(userId: string, now = Date.now()): boolean {
  const recent = (recentSends.get(userId) ?? []).filter((time) => now - time < FEEDBACK_WINDOW_MS);
  if (recent.length >= FEEDBACK_LIMIT) {
    recentSends.set(userId, recent);
    return true;
  }
  recent.push(now);
  recentSends.set(userId, recent);
  return false;
}

export function feedbackEmailText(input: FeedbackInput, sender: FeedbackSender, receivedAt: string): string {
  return [
    input.message,
    "",
    "—",
    `From: ${sender.email ?? "(no email)"}`,
    `User id: ${sender.userId}`,
    `Page: ${input.page ?? "(unknown)"}`,
    `Sent (their clock): ${input.sentAt ?? "(unknown)"}`,
    `Received (server): ${receivedAt}`,
  ].join("\n");
}

function subjectFor(message: string): string {
  const firstLine = message.split("\n")[0].trim();
  return `Ocreda feedback: ${firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine}`;
}

/**
 * Emails the feedback when Resend is configured. With no key or no recipient it
 * returns "logged", and the caller writes the text to its server log instead,
 * so the feature can be tried without sending anything.
 */
export async function deliverFeedback(
  input: FeedbackInput,
  sender: FeedbackSender,
  config: FeedbackConfig,
  receivedAt = new Date().toISOString(),
): Promise<FeedbackOutcome> {
  if (!config.resendApiKey || !config.to) return { status: "logged" };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.from || "Ocreda feedback <onboarding@resend.dev>",
      to: [config.to],
      subject: subjectFor(input.message),
      text: feedbackEmailText(input, sender, receivedAt),
      ...(sender.email ? { reply_to: sender.email } : {}),
    }),
  });
  if (response.ok) return { status: "sent" };
  const detail = await response.text().catch(() => "");
  return { status: "failed", detail: `Resend ${response.status}: ${detail.slice(0, 500)}` };
}
