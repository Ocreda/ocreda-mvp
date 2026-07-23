import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, generateWithGemini, extractJson } from "../_shared/gemini.ts";

interface ProcessNoteRequest {
  note_id: string;
  user_id: string;
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

    const { note_id, user_id }: ProcessNoteRequest = await req.json();
    const apiKey = Deno.env.get("GEMINI_API_KEY")!;

    const { data: newNote, error: newNoteErr } = await supabase
      .from("notes")
      .select("id, raw_text, summary")
      .eq("id", note_id)
      .maybeSingle();

    if (newNoteErr || !newNote) throw new Error("Note not found");

    const { data: allNotes } = await supabase
      .from("notes")
      .select("id, raw_text, summary")
      .eq("user_id", user_id)
      .neq("id", note_id)
      .limit(200);

    let relations: RelationResult[] = [];

    if (allNotes && allNotes.length > 0) {
      const notesListText = allNotes
        .map((n) => `ID:${n.id}\n${n.summary || n.raw_text}`)
        .join("\n\n---\n\n");

      const relationsRaw = await generateWithGemini(
        "You analyze a personal knowledge base for meaningful relationships between notes. Return ONLY valid JSON.",
        [{
          role: "user",
          content: `NEW NOTE:\n${newNote.summary || newNote.raw_text}\n\nEXISTING NOTES:\n${notesListText}\n\nIdentify which existing notes are meaningfully related to the new note — they share a concept, topic, or context (not just incidental keyword overlap). Return ONLY a JSON array of objects with "related_note_id" (exact UUID) and "reason" (one short sentence). If none are related, return [].`,
        }],
        apiKey
      );

      const jsonText = extractJson(relationsRaw);
      if (jsonText) {
        try {
          const parsed = JSON.parse(jsonText);
          if (Array.isArray(parsed)) {
            const validIds = new Set(allNotes.map((n) => n.id));
            relations = parsed.filter(
              (r: unknown): r is RelationResult =>
                r !== null &&
                typeof r === "object" &&
                typeof (r as RelationResult).related_note_id === "string" &&
                typeof (r as RelationResult).reason === "string" &&
                validIds.has((r as RelationResult).related_note_id)
            );
          }
        } catch { /* ignore */ }
      }

      await supabase.from("note_relations").delete().eq("note_id", note_id);
      await supabase.from("note_relations").delete().eq("related_note_id", note_id);

      if (relations.length > 0) {
        const relationsToInsert = relations.flatMap((r) => [
          { note_id: note_id, related_note_id: r.related_note_id, reason: r.reason },
          { note_id: r.related_note_id, related_note_id: note_id, reason: r.reason },
        ]);
        await supabase.from("note_relations").upsert(relationsToInsert, {
          onConflict: "note_id,related_note_id",
          ignoreDuplicates: false,
        });
      }
    }

    return new Response(
      JSON.stringify({ success: true, relations_count: relations.length }),
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
