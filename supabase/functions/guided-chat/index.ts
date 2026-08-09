import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, generateWithGemini } from "../_shared/gemini.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const { previous_answer, next_question } = await req.json();
    const systemPrompt = `You are onboarding a new user to a note app. React to their answer in one short sentence using their own vocabulary, then ask exactly the supplied next question.

Rules:
- Never mention or refer to an earlier saved note.
- Never ask a follow-up question beyond the supplied question.
- Never offer advice or interpretation.
- Maximum 2 sentences total.
- Use plain language with no enthusiasm markers.
- Never say "based on your notes" or similar wording.`;

    const message = await generateWithGemini(
      systemPrompt,
      [{ role: "user", content: `Their answer: ${previous_answer}\n\nExact next question: ${next_question}` }],
      Deno.env.get("GEMINI_API_KEY")!
    );

    return new Response(JSON.stringify({ message: message.trim() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
