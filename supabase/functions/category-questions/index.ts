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

    const { user_id, category } = await req.json();
    if (!user_id || !category) {
      return new Response(JSON.stringify({ error: "user_id and category required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("Claudebrain")!;

    // Fetch notes in this category
    const { data: notes, error: notesError } = await supabase
      .from("notes")
      .select("id, title, content, tags")
      .eq("user_id", user_id)
      .eq("category", category)
      .order("created_at", { ascending: false })
      .limit(60);

    if (notesError) throw notesError;
    if (!notes || notes.length === 0) {
      return new Response(JSON.stringify({ questions: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const notesText = notes
      .map((n: { id: string; title: string; content: string; tags: string[] }) =>
        `Title: ${n.title || "(no title)"}\nContent: ${n.content.slice(0, 500)}${n.tags?.length ? `\nTags: ${n.tags.join(", ")}` : ""}`
      )
      .join("\n\n---\n\n");

    const prompt = `You are looking at someone's personal knowledge base. Below are their notes from the category "${category}".

Generate exactly 3 short, first-person questions this person might type into an AI to explore their own thinking. The questions must:
- Be written in first person (I, my, me)
- Be short and direct — maximum 8 words each
- Be specific to the actual content of the notes — reference real details, names, projects, or themes from the notes
- Sound natural, like something a person would genuinely ask themselves
- NOT be generic

Good examples: "What have I learned about resilience?", "How do I handle failure?", "What drives my confidence?", "What did I decide about João's offer?", "Why do I keep avoiding this goal?"

Bad examples (too long, too generic): "What insights have you gathered about resilience and how they apply to your life?"

NOTES:
${notesText}

Return a JSON array of exactly 3 question strings and nothing else. No markdown, no explanation, no code blocks.
Example: ["What have I learned about X?", "How do I approach Y?", "What drives my Z?"]`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);

    const claudeData = await res.json();
    const rawText = claudeData.content[0].text.trim();

    const match = rawText.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array found");
    const questions: string[] = JSON.parse(match[0]);
    if (!Array.isArray(questions)) throw new Error("Invalid response structure");

    return new Response(
      JSON.stringify({ questions: questions.slice(0, 3) }),
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
