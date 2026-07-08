import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ChatMessageRequest {
  question_id: string;
  user_id: string;
  message: string;
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

    const { question_id, user_id, message }: ChatMessageRequest = await req.json();

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

    // 3. Fetch ALL notes for this user
    const { data: allNotes, error: notesErr } = await supabase
      .from("notes")
      .select("id, title, content, tags")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (notesErr) throw notesErr;

    // 4. Try vector search for most relevant notes to the new message
    let vectorNotes: Array<{ id: string; title: string; content: string; type: string; tags: string[]; similarity: number }> = [];

    try {
      const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("openbrain")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: message,
        }),
      });

      if (embeddingResponse.ok) {
        const embeddingData = await embeddingResponse.json();
        const queryEmbedding = embeddingData.data[0].embedding;

        const { data: matched } = await supabase.rpc("match_notes", {
          query_embedding: queryEmbedding,
          match_threshold: 0.3,
          match_count: 8,
          filter_user_id: user_id,
        });

        if (matched && matched.length > 0) {
          vectorNotes = matched;
        }
      }
    } catch {
      // fall through to all notes
    }

    const notesToUse = vectorNotes.length > 0
      ? vectorNotes
      : (allNotes ?? []).slice(0, 20).map((n) => ({ ...n, similarity: 1 }));

    // 5. Build notes context
    const notesContext = notesToUse.map((n, i) => {
      const simLabel = n.similarity < 1 ? ` [relevance: ${(n.similarity * 100).toFixed(0)}%]` : "";
      return `[Note ${i + 1}] "${n.title}"${simLabel}\nTags: ${n.tags?.join(", ") || "none"}\nContent: ${n.content}`;
    }).join("\n\n---\n\n");

    const systemPrompt = `You are the user's second brain — a version of them that has absorbed every note they've written. This is an ongoing conversation, and you remember everything discussed so far.

The user's full notes library:
${notesContext || "No notes available."}

How to respond:
- Talk like a thoughtful person who knows this material deeply, not like a search engine
- Be natural and conversational — this is a back-and-forth dialogue, not a report
- Reference notes naturally woven into your answer, not as a mechanical list
- Use first person where it fits ("You've written about this...", "From your notes...")
- Stay grounded in the notes — don't invent facts
- Never suggest the user write notes or add information`;

    // 6. Build message history for Claude
    const claudeMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

    // Original Q&A as the first exchange
    claudeMessages.push({ role: "user", content: question.question });
    if (question.answer) {
      claudeMessages.push({ role: "assistant", content: question.answer });
    }

    // Prior conversation messages
    for (const msg of (history ?? [])) {
      claudeMessages.push({ role: msg.role as "user" | "assistant", content: msg.content });
    }

    // The new user message
    claudeMessages.push({ role: "user", content: message });

    // 7. Call Claude
    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("Claudebrain")!,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system: systemPrompt,
        messages: claudeMessages,
      }),
    });

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text();
      throw new Error(`Claude API error: ${err}`);
    }

    const claudeData = await claudeResponse.json();
    const reply = claudeData.content[0].text;
    const relevantNoteIds = notesToUse.map((n) => n.id);

    // 8. Save user message and assistant reply
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
        relevant_notes: notesToUse,
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
