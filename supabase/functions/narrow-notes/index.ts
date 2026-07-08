import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface NoteRow {
  id: string;
  title: string;
  content: string;
  category: string | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { user_id, query, category_notes, other_notes } = await req.json();

    if (!user_id || !query) {
      return new Response(JSON.stringify({ error: "user_id and query required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("Claudebrain")!;

    const categoryNotesText = (category_notes as NoteRow[])
      .map((n) => `ID:${n.id}\nTitle: ${n.title}\nContent: ${n.content.slice(0, 400)}`)
      .join("\n\n---\n\n");

    const otherNotesText = (other_notes as NoteRow[])
      .map((n) => `ID:${n.id}\nTitle: ${n.title}\nCategory: ${n.category || "uncategorized"}\nContent: ${n.content.slice(0, 300)}`)
      .join("\n\n---\n\n");

    const prompt = `The user is looking for notes related to: "${query}"

NOTES IN THE CURRENT CATEGORY:
${categoryNotesText}

OTHER NOTES (from other categories):
${otherNotesText}

Your task:
1. From the CATEGORY NOTES, identify which ones are most relevant to "${query}". Use semantic understanding — the notes don't need to contain the exact words, just relate to the concept, theme, or idea.
2. From the OTHER NOTES, find 2-3 that also connect to "${query}" even though they're in a different category.

Return ONLY valid JSON, no other text:
{
  "category_matches": ["note_id_1", "note_id_2"],
  "cross_category_matches": ["note_id_3", "note_id_4"]
}

If nothing matches, return empty arrays. Order by relevance (most relevant first).`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);

    const claudeData = await res.json();
    const rawText = claudeData.content[0].text.trim();

    let parsed: { category_matches: string[]; cross_category_matches: string[] };
    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON found");
      parsed = JSON.parse(match[0]);
    } catch {
      parsed = { category_matches: [], cross_category_matches: [] };
    }

    return new Response(
      JSON.stringify({
        category_matches: parsed.category_matches || [],
        cross_category_matches: parsed.cross_category_matches || [],
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
