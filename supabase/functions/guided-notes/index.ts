import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, extractJson, generateWithGemini } from "../_shared/gemini.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const { answers } = await req.json() as { answers: string[] };
    const prompt = `Convert these answers into atomic notes.

Rules:
- One distinct claim or observation per note.
- Use the user's own words and phrasing wherever possible.
- Do not add interpretation, advice, or framing they didn't say.
- Do not write notes about the person as a category ("interested in X"). Write the actual idea they stated.
- Skip anything with no substance.
- Create 1 to 2 notes per answer; fewer is fine.
- Each note must have a short title and 1 to 3 sentences of body.

Answers:
${answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n")}

Return JSON only in this exact shape:
{"notes":[{"title":"...","body":"...","source_answer":1}]}`;

    const raw = await generateWithGemini(
      "You extract faithful atomic notes and return only valid JSON.",
      [{ role: "user", content: prompt }],
      Deno.env.get("GEMINI_API_KEY")!
    );
    const json = extractJson(raw);
    if (!json) throw new Error("Model did not return valid JSON");
    const parsed = JSON.parse(json);
    const notes = Array.isArray(parsed.notes) ? parsed.notes.filter((note: unknown) => {
      if (!note || typeof note !== "object") return false;
      const value = note as Record<string, unknown>;
      return typeof value.title === "string" && typeof value.body === "string";
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
