import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

async function describeImage(imageUrl: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: imageUrl } },
          {
            type: "text",
            text: "Describe this image in 2-3 sentences. Focus on what's meaningful, emotional, or noteworthy — not just what's literally present. Be specific and vivid.",
          },
        ],
      }],
    }),
  });
  if (!res.ok) return "";
  const data = await res.json();
  return (data.content?.[0]?.text ?? "").trim();
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

    const apiKey = Deno.env.get("Claudebrain");
    if (!apiKey) throw new Error("Claudebrain API key not configured");

    const { user_id, journal_content, date, image_url } = await req.json();
    if (!user_id || (!journal_content?.trim() && !image_url)) {
      return new Response(
        JSON.stringify({ success: true, summary: "", related_notes: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let imageDescription = "";
    if (image_url) {
      imageDescription = await describeImage(image_url, apiKey);
    }

    const enrichedContent = imageDescription
      ? (journal_content?.trim() ? `${journal_content}\n\n[Image attached: ${imageDescription}]` : imageDescription)
      : (journal_content || "");

    if (!enrichedContent.trim()) {
      return new Response(
        JSON.stringify({ success: true, summary: "", related_notes: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch ALL notes for genuine semantic ranking (not just recent ones)
    const { data: allNotes } = await supabase
      .from("notes")
      .select("id, title, content, tags, image_description")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (!allNotes || allNotes.length === 0) {
      // No notes yet — just generate a reflection
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 300,
          system: "You are the user's inner voice. Offer a brief, honest reflection on their journal entry in 2-3 sentences. Be direct and warm.",
          messages: [{ role: "user", content: `Journal entry (${date}):\n${enrichedContent}` }],
        }),
      });
      const data = res.ok ? await res.json() : null;
      const summary = (data?.content?.[0]?.text ?? "").trim();
      return new Response(
        JSON.stringify({ success: true, summary, related_notes: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build compact notes list — include image_description as semantic context
    const notesListText = allNotes
      .map((n, i) => {
        const extra = n.image_description ? `\n[Image: ${n.image_description.slice(0, 120)}]` : "";
        return `[${i}] ID:${n.id}\nTitle: ${n.title || "(untitled)"}\n${(n.content || "").slice(0, 280)}${extra}`;
      })
      .join("\n\n---\n\n");

    // Single Claude call: reflection + semantic ranking across ALL notes
    const combinedRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1200,
        system: `You are the user's inner voice — the part of their mind that has absorbed every note they have ever written. When given a journal entry and a list of their notes, you do two things:

1. Write a brief reflection (2-3 sentences) that notices patterns or themes from their notes that connect to what they just wrote. Sound like their own brain talking to them — direct, warm, no fluff.

2. Identify the top 10 most semantically related notes based on shared themes, concepts, emotions, or insights — NOT recency. A note written months ago that shares deep thematic resonance ranks higher than a recent note with only surface-level overlap. Only include genuinely relevant notes.

Return ONLY valid JSON in exactly this format (no markdown, no code blocks):
{"summary":"your 2-3 sentence reflection","related_note_ids":["uuid1","uuid2"]}

Use exact UUIDs from the notes list. Order by relevance descending. Return up to 10. Return [] if nothing is genuinely relevant.`,
        messages: [{
          role: "user",
          content: `My notes (${allNotes.length} total):\n\n${notesListText}\n\n---\n\nMy journal entry (${date}):\n${enrichedContent}\n\n---\n\nGive me your reflection and the IDs of my most semantically related notes.`,
        }],
      }),
    });

    if (!combinedRes.ok) throw new Error(`Claude API error ${combinedRes.status}: ${await combinedRes.text()}`);
    const combinedData = await combinedRes.json();
    const rawText = (combinedData.content?.[0]?.text ?? "").trim();

    let summary = "";
    let relatedNoteIds: string[] = [];

    try {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        summary = typeof parsed.summary === "string" ? parsed.summary : "";
        relatedNoteIds = Array.isArray(parsed.related_note_ids)
          ? parsed.related_note_ids.filter((id: unknown) => typeof id === "string")
          : [];
      }
    } catch { /* fall through to empty */ }

    // Validate IDs against actual note list and preserve ranked order
    const validIds = new Set(allNotes.map((n) => n.id));
    const validRelatedIds = relatedNoteIds.filter((id) => validIds.has(id)).slice(0, 10);

    const noteMap = new Map(allNotes.map((n) => [n.id, n]));
    const relatedNotes = validRelatedIds
      .map((id) => noteMap.get(id))
      .filter(Boolean)
      .map((n) => ({
        id: n!.id,
        title: n!.title || "",
        content: n!.content || "",
        tags: n!.tags || [],
        similarity: 1.0,
      }));

    return new Response(
      JSON.stringify({ success: true, summary, related_notes: relatedNotes }),
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
