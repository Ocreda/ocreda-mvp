import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, generateWithGemini, extractJson } from "../_shared/gemini.ts";

interface HandleMessageRequest {
  user_id: string;
  raw_text: string;
  local_date: string; // user's local YYYY-MM-DD
}

interface NoteRow {
  id: string;
  raw_text: string;
  summary: string | null;
  target_date: string | null;
  time_of_day: string | null;
}

interface NoteResult {
  type: "note";
  summary: string;
  target_date: string | null;
  time_of_day: "morning" | "afternoon" | "evening" | "night" | null;
}

interface QuestionResult {
  type: "question";
  answer: string;
  source_note_ids: string[];
  key_points: string[];
}

async function getConnectionCounts(
  supabase: ReturnType<typeof createClient>,
  noteIds: string[]
): Promise<Record<string, number>> {
  if (noteIds.length === 0) return {};
  const { data } = await supabase.from("note_relations").select("note_id").in("note_id", noteIds);
  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as Array<{ note_id: string }>) {
    counts[row.note_id] = (counts[row.note_id] ?? 0) + 1;
  }
  return counts;
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

    const { user_id, raw_text, local_date }: HandleMessageRequest = await req.json();
    const apiKey = Deno.env.get("GEMINI_API_KEY")!;

    const { data: allNotes, error: notesErr } = await supabase
      .from("notes")
      .select("id, raw_text, summary, target_date, time_of_day")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(300);

    if (notesErr) throw notesErr;

    const notesToUse = (allNotes ?? []) as NoteRow[];
    const hasNotes = notesToUse.length > 0;

    const notesContext = hasNotes
      ? notesToUse.map((n, i) => {
          const dateInfo = n.target_date
            ? ` | date: ${n.target_date}${n.time_of_day ? ` (${n.time_of_day})` : ""}`
            : "";
          return `[Note ${i + 1}] ID:${n.id}${dateInfo}\n${n.summary || n.raw_text}`;
        }).join("\n\n---\n\n")
      : "No notes saved yet.";

    const prompt = `Today's date (the user's local date) is ${local_date}.

The user's existing notes:
${notesContext}

The user just typed this into the app:
"${raw_text}"

Decide what this is:
- If it's a statement, task, errand, or fact to remember (declarative/imperative, not asking anything) — treat it as a NOTE to save.
- If it's a question, or a request to recall/see previously saved information (interrogative — "what", "when", "how", "did I", ends in "?", etc.) — treat it as a QUESTION to answer.
When genuinely ambiguous, prefer QUESTION.

Respond with ONLY a single JSON object, no other text before or after it.

If it's a NOTE, respond with exactly this shape:
{
  "type": "note",
  "summary": "short clean one-sentence version of what the note says, keep specifics like quantities/names",
  "target_date": "YYYY-MM-DD or null — resolve relative day words like today/tomorrow/a weekday against today's date above. If it's an actionable task/errand with no date mentioned, default to today's date above. If it's a general fact/definition (not something to do), use null.",
  "time_of_day": "morning, afternoon, evening, or night — or null if none is implied"
}

If it's a QUESTION, respond with exactly this shape:
{
  "type": "question",
  "answer": "your grounded answer. STRICT RULES: only draw on notes that are genuinely relevant — semantically (the topic actually matches) or by date (resolve today/tomorrow/yesterday against today's date above). Never invent facts. If nothing relevant exists, say so honestly instead of padding with unrelated notes. Sound like a thoughtful person, first person where natural, no preamble or closing pleasantries. After each sentence that draws from a specific note, append a marker like [Note 3] using the note number from the list above.",
  "source_note_ids": ["the exact note IDs you actually drew from — can be empty if nothing was relevant"],
  "key_points": ["2-4 short phrases copied EXACTLY as they appear in your answer text — key takeaways"]
}`;

    const raw = await generateWithGemini(
      "You are Ocreda, a personal second-brain assistant. You always respond with a single valid JSON object and nothing else.",
      [{ role: "user", content: prompt }],
      apiKey
    );

    const jsonText = extractJson(raw);
    if (!jsonText) throw new Error("Model did not return valid JSON");
    const parsed = JSON.parse(jsonText);

    if (parsed.type === "note") {
      const result = parsed as NoteResult;
      const { data: savedNote, error: saveErr } = await supabase
        .from("notes")
        .insert({
          user_id,
          raw_text,
          summary: typeof result.summary === "string" && result.summary.trim() ? result.summary.trim() : raw_text,
          target_date: typeof result.target_date === "string" ? result.target_date : null,
          time_of_day: ["morning", "afternoon", "evening", "night"].includes(result.time_of_day as string) ? result.time_of_day : null,
        })
        .select()
        .single();

      if (saveErr) throw saveErr;

      return new Response(
        JSON.stringify({ success: true, type: "note", note: savedNote }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // type === "question"
    const result = parsed as QuestionResult;
    const answer = typeof result.answer === "string" ? result.answer : "";
    const sourceNoteIds = Array.isArray(result.source_note_ids)
      ? result.source_note_ids.filter((id: unknown) => typeof id === "string")
      : [];
    const keyPoints = Array.isArray(result.key_points)
      ? result.key_points.filter((p: unknown) => typeof p === "string")
      : [];

    const noteIndexMap: Record<number, string> = {};
    notesToUse.forEach((n, i) => { noteIndexMap[i + 1] = n.id; });

    const inlineSources: Array<{ marker: string; noteId: string }> = [];
    const markerRegex = /\[Note (\d+)\]/g;
    let markerMatch;
    while ((markerMatch = markerRegex.exec(answer)) !== null) {
      const idx = parseInt(markerMatch[1]);
      if (noteIndexMap[idx]) {
        inlineSources.push({ marker: markerMatch[0], noteId: noteIndexMap[idx] });
      }
    }

    const noteMap = new Map(notesToUse.map((n) => [n.id, n]));
    const connectionCounts = await getConnectionCounts(supabase, sourceNoteIds);
    const relevantNotesOut = sourceNoteIds
      .filter((id) => noteMap.has(id))
      .map((id) => {
        const n = noteMap.get(id)!;
        return { id: n.id, summary: n.summary, raw_text: n.raw_text, connection_count: connectionCounts[id] ?? 0 };
      });

    const { data: savedQuestion, error: saveErr } = await supabase
      .from("questions")
      .insert({ user_id, question: raw_text, answer, relevant_note_ids: sourceNoteIds })
      .select()
      .single();

    if (saveErr) throw saveErr;

    return new Response(
      JSON.stringify({
        success: true,
        type: "question",
        answer,
        relevant_notes: relevantNotesOut,
        question_id: savedQuestion.id,
        key_points: keyPoints,
        inline_sources: inlineSources,
        note_title_map: Object.fromEntries(
          notesToUse.map((n, i) => [`Note ${i + 1}`, { id: n.id, title: n.summary || n.raw_text.slice(0, 40) }])
        ),
      }),
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
