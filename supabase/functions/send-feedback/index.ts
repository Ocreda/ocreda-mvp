import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { authenticateRequest, isAuthenticationError } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/gemini.ts";
import {
  deliverFeedback,
  feedbackEmailText,
  overFeedbackLimit,
  readFeedbackInput,
} from "../_shared/feedback.ts";

/**
 * "Send feedback" from the app header. Signed-in people only. Emails the
 * comment to FEEDBACK_TO_EMAIL through Resend; with no RESEND_API_KEY or
 * FEEDBACK_TO_EMAIL set, it writes the comment to this function's logs.
 *
 * Secrets (supabase secrets set ...):
 *   RESEND_API_KEY       Resend API key with sending access
 *   FEEDBACK_TO_EMAIL    where feedback goes; never sent to the browser
 *   FEEDBACK_FROM_EMAIL  optional verified sender, e.g. "Ocreda <feedback@yourdomain>"
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let user;
  try {
    ({ user } = await authenticateRequest(req));
  } catch (error) {
    if (isAuthenticationError(error)) return json({ error: "Sign in to send feedback." }, 401);
    return json({ error: "Couldn't check your sign-in. Please try again." }, 500);
  }

  const body = await req.json().catch(() => null);
  const input = readFeedbackInput(body);
  if ("error" in input) return json({ error: input.error }, 400);
  if (overFeedbackLimit(user.id)) {
    return json({ error: "Thanks — that's a lot of feedback at once. Please try again in a few minutes." }, 429);
  }

  const sender = { userId: user.id, email: user.email ?? null };
  const receivedAt = new Date().toISOString();
  try {
    const outcome = await deliverFeedback(input, sender, {
      resendApiKey: Deno.env.get("RESEND_API_KEY") ?? null,
      to: Deno.env.get("FEEDBACK_TO_EMAIL") ?? null,
      from: Deno.env.get("FEEDBACK_FROM_EMAIL") ?? null,
    }, receivedAt);
    if (outcome.status === "logged") {
      console.warn("send-feedback: RESEND_API_KEY or FEEDBACK_TO_EMAIL not set; logging instead of emailing.");
      console.log(`send-feedback:\n${feedbackEmailText(input, sender, receivedAt)}`);
      return json({ ok: true });
    }
    if (outcome.status === "failed") {
      console.error(`send-feedback: ${outcome.detail}`);
      console.log(`send-feedback (undelivered):\n${feedbackEmailText(input, sender, receivedAt)}`);
      return json({ error: "Couldn't send your feedback right now. Please try again." }, 502);
    }
    return json({ ok: true });
  } catch (error) {
    console.error("send-feedback:", error);
    console.log(`send-feedback (undelivered):\n${feedbackEmailText(input, sender, receivedAt)}`);
    return json({ error: "Couldn't send your feedback right now. Please try again." }, 502);
  }
});
