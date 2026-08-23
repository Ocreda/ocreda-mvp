import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, extractJson, generateWithGemini } from "../_shared/gemini.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
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

    const raw = await generateWithGemini(
      "You retrieve the most relevant existing notes from a supplied corpus and return only valid JSON.",
      [{ role: "user", content: prompt }],
      Deno.env.get("GEMINI_API_KEY")!
    );
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
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
