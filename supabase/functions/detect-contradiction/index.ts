import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { note_id, user_id } = await req.json();
    const apiKey = Deno.env.get("Claudebrain")!;

    // Fetch the new note
    const { data: newNote, error: noteError } = await supabase
      .from("notes")
      .select("id, title, content, tags")
      .eq("id", note_id)
      .maybeSingle();

    if (noteError || !newNote) {
      return new Response(JSON.stringify({ contradictions: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch other notes
    const { data: otherNotes, error: othersError } = await supabase
      .from("notes")
      .select("id, title, content")
      .eq("user_id", user_id)
      .neq("id", note_id)
      .limit(80);

    if (othersError || !otherNotes || otherNotes.length === 0) {
      return new Response(JSON.stringify({ contradictions: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const notesList = otherNotes
      .map((n, i) => `[${i}] ID:${n.id}\nTitle: ${n.title}\nContent: ${n.content.slice(0, 400)}`)
      .join("\n\n---\n\n");

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content: `You are analyzing a personal knowledge base for intellectual contradictions or significant shifts in thinking.

NEW NOTE:
Title: ${newNote.title}
Content: ${newNote.content}

EXISTING NOTES:
${notesList}

Look for direct contradictions: where the new note expresses a belief, conclusion, or stance that conflicts with something in an existing note. Not just different topics — genuine intellectual contradictions where both cannot simultaneously be true, or where the person's thinking has clearly changed.

Return ONLY a JSON array. Each object must have:
- "note_id_b": the UUID of the contradicting existing note
- "summary": 1-2 sentence description of the specific contradiction

If no real contradictions exist, return: []

Example: [{"note_id_b": "uuid", "summary": "The new note argues remote work increases productivity, while the earlier note concluded office environments are essential for creative collaboration."}]`,
          },
        ],
      }),
    });

    let found: Array<{ note_id_b: string; summary: string }> = [];
    if (claudeRes.ok) {
      const data = await claudeRes.json();
      const raw = data.content?.[0]?.text?.trim() ?? "";
      try {
        const match = raw.match(/\[[\s\S]*?\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            found = parsed.filter(
              (r) => r && typeof r.note_id_b === "string" && typeof r.summary === "string"
            );
          }
        }
      } catch {
        found = [];
      }
    }

    // Save contradictions to DB
    const saved = [];
    for (const c of found) {
      const validNote = otherNotes.find((n) => n.id === c.note_id_b);
      if (!validNote) continue;

      const { data: inserted } = await supabase
        .from("note_contradictions")
        .insert({
          user_id,
          note_id_a: note_id,
          note_id_b: c.note_id_b,
          contradiction_summary: c.summary,
        })
        .select()
        .maybeSingle();

      if (inserted) {
        saved.push({
          id: inserted.id,
          note_id_a: note_id,
          note_id_b: c.note_id_b,
          note_a_title: newNote.title,
          note_b_title: validNote.title,
          summary: c.summary,
        });
      }
    }

    return new Response(JSON.stringify({ contradictions: saved }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message, contradictions: [] }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
