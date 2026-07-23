import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, generateWithGemini, GeminiMessage } from "../_shared/gemini.ts";

interface ChatMessageRequest {
  question_id: string;
  user_id: string;
  message: string;
  local_date: string;
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

    const { question_id, user_id, message, local_date }: ChatMessageRequest = await req.json();

    // 1. Load the original question
    const { data: question, error: qErr } = await supabase
      .from("questions")
      .select("id, question, answer, relevant_note_ids")
      .eq("id", question_id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (qErr || !question) throw new Error("Question not found");

    // 2. Load conversation history
    const { data: history, error: hErr } = await supabase
      .from("conversation_messages")
      .select("role, content, created_at")
      .eq("question_id", question_id)
      .order("created_at", { ascending: true });

    if (hErr) throw hErr;

    // 3. Fetch notes for this user
    const { data: allNotes, error: notesErr } = await supabase
      .from("notes")
      .select("id, raw_text, summary, target_date, time_of_day")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(300);

    if (notesErr) throw notesErr;

    const notesToUse = allNotes ?? [];

    // 4. Build notes context
    const notesContext = notesToUse.map((n, i) => {
      const dateInfo = n.target_date
        ? ` | date: ${n.target_date}${n.time_of_day ? ` (${n.time_of_day})` : ""}`
        : "";
      return `[Note ${i + 1}]${dateInfo}\n${n.summary || n.raw_text}`;
    }).join("\n\n---\n\n");

    const systemPrompt = `You are the user's second brain — you only know what's in their notes below. Today's date (the user's local date) is ${local_date}; resolve any "today"/"tomorrow"/"yesterday"/weekday references against that. This is an ongoing conversation, and you remember everything discussed so far.

The user's full notes library:
${notesContext || "No notes available."}

How to respond:
- Talk like a thoughtful person who knows this material deeply, not a search engine
- Be natural and conversational — this is a back-and-forth dialogue
- Only draw on notes that are genuinely relevant (by topic or by date) — never pad the answer with unrelated notes, never invent facts
- If nothing relevant exists, say so honestly`;

    // 5. Build message history for Gemini (Gemini uses "model" instead of "assistant")
    const geminiMessages: GeminiMessage[] = [];

    geminiMessages.push({ role: "user", content: question.question });
    if (question.answer) {
      geminiMessages.push({ role: "model", content: question.answer });
    }

    for (const msg of (history ?? [])) {
      geminiMessages.push({ role: msg.role === "assistant" ? "model" : "user", content: msg.content });
    }

    geminiMessages.push({ role: "user", content: message });

    // 6. Call Gemini
    const reply = await generateWithGemini(systemPrompt, geminiMessages, Deno.env.get("GEMINI_API_KEY")!);
    const relevantNoteIds = notesToUse.map((n) => n.id);

    // 7. Save user message and assistant reply
    const { data: insertedMessages, error: insertErr } = await supabase
      .from("conversation_messages")
      .insert([
        { question_id, user_id, role: "user", content: message, relevant_note_ids: [] },
        { question_id, user_id, role: "assistant", content: reply, relevant_note_ids: relevantNoteIds },
      ])
      .select();

    if (insertErr) throw insertErr;

    return new Response(
      JSON.stringify({
        success: true,
        reply,
        relevant_notes: notesToUse.map((n) => ({ id: n.id, summary: n.summary, raw_text: n.raw_text, connection_count: 0 })),
        messages: insertedMessages,
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
