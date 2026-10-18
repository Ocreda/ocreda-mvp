import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isAuthenticationError, verifiedUserId } from "../_shared/auth.ts";
import { BEST_MODEL, corsHeaders, generateWithGeminiResult, extractJson } from "../_shared/gemini.ts";
import { recordUsageInBackground } from "../_shared/usage.ts";

interface HandleMessageRequest {
  raw_text: string;
  local_date: string; // user's local YYYY-MM-DD
  /** Exploring the sample notes: answer from them, and save a new note among them. */
  samples?: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
    // The user comes from the caller's verified login, never from the request
    // body: this client bypasses row-level security, so every query below is
    // scoped to this id by hand.
    const user_id = await verifiedUserId(req);
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { raw_text, local_date, samples }: HandleMessageRequest = await req.json();
    const isSample = samples === true;
    const apiKey = Deno.env.get("OPENROUTER_API_KEY")!;

    const { data: allNotes, error: notesErr } = await supabase
      .from("notes")
      .select("id, raw_text, summary, target_date, time_of_day")
      .eq("user_id", user_id)
      .eq("is_sample", isSample)
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

    const startedAt = Date.now();
    const { text: raw, usage } = await generateWithGeminiResult(
      "You are Ocreda, a personal second-brain assistant. You always respond with a single valid JSON object and nothing else.",
      [{ role: "user", content: prompt }],
      apiKey,
      BEST_MODEL,
    );
    if (usage) {
      recordUsageInBackground({ userId: user_id, feature: "handle-message", billedBy: "openrouter", model: BEST_MODEL, steps: { answer: usage }, status: "ok", startedAt });
    }

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
          is_sample: isSample,
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
    // Only the person's own notes, whatever ids the model wrote: they are saved
    // with the question and looked up below.
    const ownNoteIds = new Set(notesToUse.map((n) => n.id));
    const sourceNoteIds: string[] = Array.isArray(result.source_note_ids)
      ? result.source_note_ids.filter((id: unknown): id is string => typeof id === "string" && ownNoteIds.has(id))
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
    if (isAuthenticationError(error)) return json({ success: false, error: "Sign in to continue." }, 401);
    // The details stay in the logs; database errors are not for the browser.
    console.error("handle-message failed:", error instanceof Error ? error.message : error);
    return json({ success: false, error: "Could not handle that right now. Please try again." }, 500);
  }
});
