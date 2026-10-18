import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isAuthenticationError, verifiedUserId } from "../_shared/auth.ts";
import { BEST_MODEL, corsHeaders, generateWithGeminiResult, extractJson } from "../_shared/gemini.ts";
import { recordUsageInBackground } from "../_shared/usage.ts";

interface ProcessNoteRequest {
  note_id: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface RelationResult {
  related_note_id: string;
  reason: string;
  confidence: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    // The user comes from the caller's verified login, never from the request
    // body: this client bypasses row-level security, so every query below is
    // scoped to this id by hand.
    const user_id = await verifiedUserId(req);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { note_id }: ProcessNoteRequest = await req.json();
    const apiKey = Deno.env.get("OPENROUTER_API_KEY")!;

    // Only the caller's own note. Its connections are rewritten below, so a
    // note id alone must never be enough to touch someone else's.
    const { data: newNote, error: newNoteErr } = await supabase
      .from("notes")
      .select("id, raw_text, summary, is_sample")
      .eq("id", note_id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (newNoteErr || !newNote) return json({ success: false, error: "Note not found" }, 404);

    const { data: allNotes } = await supabase
      .from("notes")
      .select("id, raw_text, summary")
      .eq("user_id", user_id)
      // A sample note is only ever connected to sample notes, and an own note to own notes.
      .eq("is_sample", newNote.is_sample === true)
      .neq("id", note_id)
      .limit(200);

    let relations: RelationResult[] = [];

    if (allNotes && allNotes.length > 0) {
      const notesListText = allNotes
        .map((n) => `ID:${n.id}\n${n.summary || n.raw_text}`)
        .join("\n\n---\n\n");

      const startedAt = Date.now();
      const { text: relationsRaw, usage } = await generateWithGeminiResult(
        "You analyze a personal knowledge base for meaningful relationships between notes. Return ONLY valid JSON.",
        [{
          role: "user",
          content: `NEW NOTE:\n${newNote.summary || newNote.raw_text}\n\nEXISTING NOTES:\n${notesListText}\n\nIdentify deeper, meaningful connections between the new note and existing notes. Do not connect notes merely because they share a topic or keywords. The reason must name the underlying shared meaning, tension, belief, motivation, or pattern. Return ONLY a JSON array of objects with "related_note_id" (exact UUID), "reason" (one specific sentence beginning with "They are connected because"), and "confidence" (0 to 1). Return at most 3, ordered from highest confidence to lowest. If none are meaningfully related, return [].`,
        }],
        apiKey,
        BEST_MODEL,
      );
      if (usage) {
        recordUsageInBackground({ userId: user_id, feature: "process-note", billedBy: "openrouter", model: BEST_MODEL, steps: { relations: usage }, status: "ok", startedAt });
      }

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
          { note_id: note_id, related_note_id: r.related_note_id, reason: r.reason, confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0.5)) },
          { note_id: r.related_note_id, related_note_id: note_id, reason: r.reason, confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0.5)) },
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
    if (isAuthenticationError(error)) return json({ success: false, error: "Sign in to continue." }, 401);
    // The details stay in the logs; database errors are not for the browser.
    console.error("process-note failed:", error instanceof Error ? error.message : error);
    return json({ success: false, error: "Could not process this note right now." }, 500);
  }
});
