import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { BEST_MODEL, corsHeaders, generateWithGeminiResult } from "../_shared/gemini.ts";
import { isAuthenticationError, verifiedUserId } from "../_shared/auth.ts";
import { recordUsageInBackground } from "../_shared/usage.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    // Signed-in people only: this spends AI credit, and the public key alone
    // must not be enough to do that.
    const userId = await verifiedUserId(req);
    const { previous_answer, next_question } = await req.json();
    const systemPrompt = `You are onboarding a new user to a note app. React to their answer in one short sentence using their own vocabulary, then ask exactly the supplied next question.

Rules:
- Never mention or refer to an earlier saved note.
- Never repeat, quote, or closely paraphrase the user's answer.
- React to the underlying idea, not the wording they used.
- Never ask a follow-up question beyond the supplied question.
- Never offer advice or interpretation.
- Maximum 2 sentences total.
- Use plain language with no enthusiasm markers.
- Never say "based on your notes" or similar wording.`;

    const startedAt = Date.now();
    const { text: message, usage } = await generateWithGeminiResult(
      systemPrompt,
      [{ role: "user", content: `Their answer: ${previous_answer}\n\nExact next question: ${next_question}` }],
      Deno.env.get("OPENROUTER_API_KEY")!,
      BEST_MODEL,
    );
    if (usage) {
      recordUsageInBackground({ userId, feature: "guided-chat", billedBy: "openrouter", model: BEST_MODEL, steps: { reply: usage }, status: "ok", startedAt });
    }

    return new Response(JSON.stringify({ message: message.trim() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (isAuthenticationError(error)) {
      return new Response(JSON.stringify({ error: "Sign in to continue." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("guided-chat failed:", error instanceof Error ? error.message : error);
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
