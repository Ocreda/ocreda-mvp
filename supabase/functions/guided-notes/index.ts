import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { BEST_MODEL, corsHeaders, extractJson, generateWithGeminiResult } from "../_shared/gemini.ts";
import { isAuthenticationError, verifiedUserId } from "../_shared/auth.ts";
import { recordUsageInBackground } from "../_shared/usage.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    // Signed-in people only: this spends AI credit, and the public key alone
    // must not be enough to do that.
    const userId = await verifiedUserId(req);
    const { answers, corpus } = await req.json() as {
      answers: string[];
      corpus: Array<{ id: string; title: string | null; body: string }>;
    };
    if (!Array.isArray(corpus) || corpus.length === 0) {
      return new Response(JSON.stringify({ notes: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const prompt = `Read the complete onboarding conversation and retrieve the best-matching EXISTING notes from the user's corpus.

Rules:
- Never turn an answer into a new note.
- Never repeat, quote, or paraphrase the chat as a result.
- Return only notes whose IDs occur in the corpus below.
- Rank by underlying meaning, not merely shared words.
- Return at most 3 notes, strongest match first.
- Copy each selected corpus note's title and body exactly.

Conversation:
${answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n")}

Existing corpus:
${corpus.map((note) => `ID: ${note.id}\nTitle: ${note.title ?? "Untitled"}\nBody: ${note.body}`).join("\n\n")}

Return JSON only in this exact shape:
{"notes":[{"existing_note_id":"...","title":"...","body":"..."}]}`;

    const startedAt = Date.now();
    const { text: raw, usage } = await generateWithGeminiResult(
      "You retrieve the most relevant existing notes from a supplied corpus and return only valid JSON.",
      [{ role: "user", content: prompt }],
      Deno.env.get("OPENROUTER_API_KEY")!,
      BEST_MODEL,
    );
    if (usage) {
      recordUsageInBackground({ userId, feature: "guided-notes", billedBy: "openrouter", model: BEST_MODEL, steps: { notes: usage }, status: "ok", startedAt });
    }
    const json = extractJson(raw);
    if (!json) throw new Error("Model did not return valid JSON");
    const parsed = JSON.parse(json);
    const notes = Array.isArray(parsed.notes) ? parsed.notes.filter((note: unknown) => {
      if (!note || typeof note !== "object") return false;
      const value = note as Record<string, unknown>;
      return typeof value.existing_note_id === "string" &&
        corpus.some((candidate) => candidate.id === value.existing_note_id) &&
        typeof value.title === "string" && typeof value.body === "string";
    }) : [];

    return new Response(JSON.stringify({ notes }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (isAuthenticationError(error)) {
      return new Response(JSON.stringify({ error: "Sign in to continue." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    console.error("guided-notes failed:", error instanceof Error ? error.message : error);
    return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
