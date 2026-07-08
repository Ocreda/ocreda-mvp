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

    const apiKey = Deno.env.get("Claudebrain");
    if (!apiKey) throw new Error("Claudebrain API key not configured");

    const { user_id, journal_content, date } = await req.json();
    if (!user_id || !journal_content?.trim()) throw new Error("user_id and journal_content required");

    const prompt = `You are helping a user extract key insights from their personal journal entry.

Journal entry (${date}):
${journal_content}

Extract 2-3 key insights, realizations, or learnings from this entry — things worth remembering and connecting to other knowledge. These should be:
- Concrete and actionable, or emotionally significant
- Written as standalone notes that make sense without the full journal context
- First person, direct, the way the user would write a note to themselves

Return ONLY a JSON array:
[
  {
    "title": "Short title (4-7 words)",
    "content": "2-3 sentences capturing the insight.",
    "tags": ["tag1", "tag2"]
  }
]`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const rawText = (data.content?.[0]?.text ?? "").trim();

    let insights: Array<{ title: string; content: string; tags: string[] }> = [];
    try {
      insights = JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\[[\s\S]*\]/);
      if (match) insights = JSON.parse(match[0]);
      else throw new Error("Failed to parse insights JSON");
    }

    if (!Array.isArray(insights)) throw new Error("Invalid insights format");

    const insertPayload = insights.map((ins) => ({
      user_id,
      title: ins.title || "",
      content: ins.content || "",
      type: "idea",
      tags: [...(ins.tags ?? []), "journal"],
    }));

    const { data: savedNotes, error: insertErr } = await supabase
      .from("notes")
      .insert(insertPayload)
      .select("id, title, tags");

    if (insertErr) throw insertErr;

    for (const note of savedNotes ?? []) {
      const idx = (savedNotes ?? []).indexOf(note);
      const ins = insights[idx];
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/process-note`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ note_id: note.id, user_id, title: note.title, content: ins?.content ?? "" }),
      }).catch(() => {});
    }

    return new Response(
      JSON.stringify({ success: true, notes: savedNotes, count: savedNotes?.length ?? 0 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
