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

    const { user_id } = await req.json();
    const apiKey = Deno.env.get("Claudebrain")!;

    // Fetch all notes
    const { data: allNotes, error: notesError } = await supabase
      .from("notes")
      .select("id, title, content, tags, created_at, updated_at")
      .eq("user_id", user_id)
      .order("updated_at", { ascending: true });

    if (notesError || !allNotes || allNotes.length === 0) {
      return new Response(JSON.stringify({ notes: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch recent questions (last 14 days) for context
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const { data: recentQuestions } = await supabase
      .from("questions")
      .select("question, created_at")
      .eq("user_id", user_id)
      .gte("created_at", twoWeeksAgo.toISOString())
      .order("created_at", { ascending: false })
      .limit(20);

    // Fetch recently added notes (last 7 days) for context
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const recentNoteIds = new Set(
      allNotes
        .filter((n) => new Date(n.created_at) >= oneWeekAgo)
        .map((n) => n.id)
    );

    // Candidates: notes NOT recently added (older than 7 days), pick oldest first
    const candidates = allNotes
      .filter((n) => !recentNoteIds.has(n.id))
      .slice(0, 60);

    if (candidates.length === 0) {
      return new Response(JSON.stringify({ notes: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const recentContext = [
      ...(recentQuestions || []).map((q) => `Question: ${q.question}`),
      ...allNotes
        .filter((n) => recentNoteIds.has(n.id))
        .map((n) => `Recent note: ${n.title}`),
    ].join("\n");

    const notesList = candidates
      .map((n, i) => `[${i}] ID:${n.id}\nTitle: ${n.title}\nContent: ${n.content.slice(0, 300)}\nTags: ${(n.tags || []).join(", ")}\nLast updated: ${n.updated_at}`)
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
            content: `You are helping someone review their personal knowledge base. Select 3-5 notes they haven't visited recently but that feel relevant to what they've been thinking about lately.

RECENT CONTEXT (what they've been thinking about):
${recentContext || "No recent activity"}

OLD NOTES TO CHOOSE FROM:
${notesList}

Pick 3-5 notes that feel most worth revisiting right now — notes that connect to their recent thinking, or that contain ideas worth refreshing. Prioritize emotional resonance and conceptual relevance over recency.

Return ONLY a JSON array of note IDs (strings), e.g.: ["uuid1", "uuid2", "uuid3"]`,
          },
        ],
      }),
    });

    let selectedIds: string[] = [];
    if (claudeRes.ok) {
      const data = await claudeRes.json();
      const raw = data.content?.[0]?.text?.trim() ?? "";
      try {
        const match = raw.match(/\[[\s\S]*?\]/);
        if (match) selectedIds = JSON.parse(match[0]);
      } catch {
        selectedIds = [];
      }
    }

    // Fallback: pick oldest 3 if claude fails
    if (selectedIds.length === 0) {
      selectedIds = candidates.slice(0, 3).map((n) => n.id);
    }

    // Return full note objects for selected IDs
    const selectedNotes = selectedIds
      .map((id) => allNotes.find((n) => n.id === id))
      .filter(Boolean);

    return new Response(JSON.stringify({ notes: selectedNotes }), {
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
