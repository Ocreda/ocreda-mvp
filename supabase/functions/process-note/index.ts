import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ProcessNoteRequest {
  note_id: string;
  user_id: string;
  title: string;
  content: string;
  image_url?: string;
}

async function analyzeImage(imageUrl: string, apiKey: string): Promise<{ description: string; tags: string[] }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", url: imageUrl },
          },
          {
            type: "text",
            text: 'Analyze this image and return ONLY a valid JSON object with two fields: "description" (a detailed, rich description of everything meaningful in the image — objects, text, people, emotions, themes, setting, colors, context) and "tags" (an array of 4-6 relevant lowercase tags). No markdown, no extra text. Example: {"description": "A handwritten to-do list on yellow sticky note with three items: buy groceries, call mom, finish report. The note is placed on a wooden desk.", "tags": ["handwriting", "to-do", "productivity", "notes"]}',
          },
        ],
      }],
    }),
  });
  if (!res.ok) return { description: "", tags: [] };
  const data = await res.json();
  const rawText = (data.content?.[0]?.text ?? "").trim();
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        description: typeof parsed.description === "string" ? parsed.description : "",
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: unknown) => typeof t === "string") : [],
      };
    }
  } catch { /* fall through */ }
  return { description: "", tags: [] };
}

async function generateTitle(content: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 32,
      messages: [{
        role: "user",
        content: `Write a title for this note in 4 words or fewer. Short, sharp, like a label not a sentence. Return ONLY the title text, no quotes, no punctuation at the end.\n\nNote content:\n${content.slice(0, 600)}`,
      }],
    }),
  });
  if (!res.ok) return "";
  const data = await res.json();
  return (data.content?.[0]?.text ?? "").trim().replace(/^["']|["']$/g, "").trim();
}

interface NoteRow {
  id: string;
  title: string;
  content: string;
}

interface RelationResult {
  related_note_id: string;
  reason: string;
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

    const { note_id, user_id, title, content, image_url }: ProcessNoteRequest = await req.json();
    const apiKey = Deno.env.get("Claudebrain")!;

    // 1. If image provided, analyze it with Claude vision
    let imageDescription = "";
    let imageTags: string[] = [];
    if (image_url) {
      const analysis = await analyzeImage(image_url, apiKey);
      imageDescription = analysis.description;
      imageTags = analysis.tags;
    }

    // Update note with image description stored separately (keep content as user text only)
    if (imageDescription) {
      await supabase.from("notes").update({ image_description: imageDescription }).eq("id", note_id);
    }

    // Build the effective content for AI processing (user text + image description)
    const effectiveContent = imageDescription
      ? (content?.trim() ? `${content}\n\n${imageDescription}` : imageDescription)
      : (content || "");

    // 2. Generate title if none provided
    let finalTitle = title?.trim();
    if (!finalTitle) {
      const generated = await generateTitle(effectiveContent, apiKey);
      if (generated) finalTitle = generated;
    }

    // 3. Generate tags, seeding with image tags if available
    const seedTagsHint = imageTags.length > 0
      ? `\n\nSuggested tags from image analysis: ${imageTags.join(", ")}. Include relevant ones.`
      : "";

    const claudeTagsResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 256,
        messages: [{
          role: "user",
          content: `Generate 3-7 concise, lowercase tags for this note. Return ONLY a JSON array of strings, nothing else.${seedTagsHint}

Title: ${finalTitle || title}
Content: ${effectiveContent}

Example output: ["machine learning", "neural networks", "deep learning"]`,
        }],
      }),
    });

    let tags: string[] = [];
    if (claudeTagsResponse.ok) {
      const claudeData = await claudeTagsResponse.json();
      const rawText = claudeData.content[0].text.trim();
      try {
        const match = rawText.match(/\[.*\]/s);
        if (match) tags = JSON.parse(match[0]);
      } catch { tags = []; }
    }
    // Fallback: keep image tags if Claude didn't produce any
    if (tags.length === 0 && imageTags.length > 0) tags = imageTags;

    // 4. Update note with final tags and title
    const updatePayload: Record<string, unknown> = { tags };
    if (finalTitle && finalTitle !== title) updatePayload.title = finalTitle;
    await supabase.from("notes").update(updatePayload).eq("id", note_id);

    // 5. Fetch other notes for relation finding
    const { data: allNotes, error: allNotesError } = await supabase
      .from("notes")
      .select("id, title, content")
      .eq("user_id", user_id)
      .neq("id", note_id)
      .limit(80);

    let relations: RelationResult[] = [];

    if (!allNotesError && allNotes && allNotes.length > 0) {
      const notesListText = (allNotes as NoteRow[])
        .map((n, i) => `[${i}] ID:${n.id}\nTitle: ${n.title}\nContent: ${n.content.slice(0, 400)}`)
        .join("\n\n---\n\n");

      const claudeRelationsResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{
            role: "user",
            content: `You are analyzing a personal knowledge base. A new note was saved:

NEW NOTE:
Title: ${finalTitle || title}
Content: ${effectiveContent}

EXISTING NOTES:
${notesListText}

Identify which existing notes are meaningfully related to the new note. A meaningful relationship means they share concepts, themes, ideas, insights, or topics — not just superficial keyword overlap.

Return ONLY a JSON array of objects. Each object must have:
- "related_note_id": the exact UUID from the ID field
- "reason": a concise 1-sentence explanation of why they are related

If no meaningful relationships exist, return an empty array: []

Example: [{"related_note_id": "uuid-here", "reason": "Both explore the concept of flow states in creative work."}]`,
          }],
        }),
      });

      if (claudeRelationsResponse.ok) {
        const claudeRelData = await claudeRelationsResponse.json();
        const rawText = claudeRelData.content[0].text.trim();
        try {
          const match = rawText.match(/\[[\s\S]*\]/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (Array.isArray(parsed)) {
              relations = parsed.filter(
                (r: unknown) =>
                  r !== null &&
                  typeof r === "object" &&
                  "related_note_id" in (r as object) &&
                  "reason" in (r as object) &&
                  typeof (r as RelationResult).related_note_id === "string" &&
                  typeof (r as RelationResult).reason === "string"
              );
            }
          }
        } catch { relations = []; }
      }

      await supabase.from("note_relations").delete().eq("note_id", note_id);
      await supabase.from("note_relations").delete().eq("related_note_id", note_id);

      if (relations.length > 0) {
        const validNoteIds = new Set((allNotes as NoteRow[]).map((n) => n.id));
        const relationsToInsert = relations
          .filter((r) => validNoteIds.has(r.related_note_id))
          .flatMap((r) => [
            { note_id: note_id, related_note_id: r.related_note_id, reason: r.reason },
            { note_id: r.related_note_id, related_note_id: note_id, reason: r.reason },
          ]);

        if (relationsToInsert.length > 0) {
          await supabase.from("note_relations").upsert(relationsToInsert, {
            onConflict: "note_id,related_note_id",
            ignoreDuplicates: false,
          });
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, tags, title: finalTitle || title, relations_count: relations.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
