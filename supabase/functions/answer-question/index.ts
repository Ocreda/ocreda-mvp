import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface AnswerQuestionRequest {
  question: string;
  user_id: string;
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

    const { question, user_id }: AnswerQuestionRequest = await req.json();

    const { data: allNotes, error: allNotesError } = await supabase
      .from("notes")
      .select("id, title, content, tags")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (allNotesError) throw allNotesError;

    let vectorNotes: Array<{ id: string; title: string; content: string; tags: string[]; similarity: number }> = [];

    try {
      const embeddingResponse = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("openbrain")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: question,
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
      // fall back to all notes
    }

    const notesToUse = vectorNotes.length > 0
      ? vectorNotes
      : (allNotes ?? []).slice(0, 20).map((n) => ({ ...n, similarity: 1 }));

    const { data: recentQuestions } = await supabase
      .from("questions")
      .select("question")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false })
      .limit(5);

    const hasNotes = notesToUse.length > 0;

    // Build numbered note list so Claude can reference by index
    const notesContext = hasNotes
      ? notesToUse.map((n, i) => {
          return `[Note ${i + 1}] ID:${n.id}\nTitle: "${n.title}"\nTags: ${n.tags?.join(", ") || "none"}\nContent: ${n.content}`;
        }).join("\n\n---\n\n")
      : "The user has no notes saved yet.";

    const questionsContext = recentQuestions && recentQuestions.length > 0
      ? recentQuestions.map((q: { question: string }) => `- ${q.question}`).join("\n")
      : "";

    const systemPrompt = `You are the user's inner voice — the part of their mind that has absorbed every note they've ever written. When they ask you something, you answer the way they'd talk to a close friend: honest, direct, in first person where it feels natural, no corporate stiffness.

Voice rules:
- Sound like a thoughtful person, not a search engine. Use "I", "you", "we" naturally.
- No preamble ("Great question!"), no restating what they asked, no closing pleasantries.
- Be direct. If you know the answer from the notes, just say it.
- Maximum 4 sentences unless the question genuinely needs more. Every word earns its place.
- Ground everything strictly in the provided notes. Never invent facts.
- If the notes have rich relevant content, give a rich answer. If sparse, be honest: "I don't have much on this yet."

INLINE SOURCE ANNOTATION:
After each sentence that draws from a specific note, append a source marker like this: [Note 3]
Use the note number from the list provided. Only annotate sentences that directly use information from a note.
Do not annotate general reasoning that doesn't come from a specific note.

KEY POINTS:
After your answer (separated by a blank line), output a JSON block and nothing else:
{
  "source_note_ids": ["id1", "id2"],
  "key_points": ["exact phrase or short clause from the answer that is a key takeaway", "another key point"]
}
- key_points: 2-4 short phrases or clauses copied EXACTLY as they appear in your answer text (so they can be highlighted). Pick the most important takeaways.
- source_note_ids: the 3-5 note IDs you drew from most directly.${questionsContext ? `\n\nRecent questions from this user (context only):\n${questionsContext}` : ""}`;

    const userPrompt = hasNotes
      ? `Here are my notes:\n\n${notesContext}\n\n---\n\nAnswer this question using only the above notes:\n${question}`
      : `I have no notes saved yet.\n\nQuestion: ${question}`;

    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": Deno.env.get("Claudebrain")!,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text();
      throw new Error(`Claude API error: ${err}`);
    }

    const claudeData = await claudeResponse.json();
    const rawAnswer = claudeData.content[0].text as string;

    let answer = rawAnswer;
    let sourceNoteIds: string[] = [];
    let keyPoints: string[] = [];

    // Extract the trailing JSON block
    const jsonMatch = rawAnswer.match(/\{[\s\S]*"source_note_ids"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.source_note_ids)) {
          sourceNoteIds = parsed.source_note_ids.filter((id: unknown) => typeof id === "string");
        }
        if (Array.isArray(parsed.key_points)) {
          keyPoints = parsed.key_points.filter((p: unknown) => typeof p === "string");
        }
      } catch { /* ignore parse errors */ }
      answer = rawAnswer.slice(0, rawAnswer.lastIndexOf(jsonMatch[0])).trimEnd();
    }

    if (sourceNoteIds.length === 0) {
      sourceNoteIds = notesToUse.slice(0, 5).map((n) => n.id);
    }

    // Build a note index map for inline source resolution
    // The answer may contain [Note N] markers — resolve them to note IDs
    const noteIndexMap: Record<number, string> = {};
    notesToUse.forEach((n, i) => { noteIndexMap[i + 1] = n.id; });

    // Extract inline source references from the answer text
    const inlineSources: Array<{ marker: string; noteId: string }> = [];
    const markerRegex = /\[Note (\d+)\]/g;
    let markerMatch;
    while ((markerMatch = markerRegex.exec(answer)) !== null) {
      const idx = parseInt(markerMatch[1]);
      if (noteIndexMap[idx]) {
        inlineSources.push({ marker: markerMatch[0], noteId: noteIndexMap[idx] });
      }
    }

    const noteMap = new Map((allNotes ?? []).map((n) => [n.id, n]));
    const relevantNotesOut = sourceNoteIds
      .filter((id) => noteMap.has(id))
      .map((id) => {
        const n = noteMap.get(id)!;
        const vn = vectorNotes.find((v) => v.id === id);
        return { id: n.id, title: n.title, content: n.content, tags: n.tags, similarity: vn ? vn.similarity : 1 };
      });

    const allRelevantIds = notesToUse.map((n) => n.id);

    const { data: savedQuestion, error: saveError } = await supabase
      .from("questions")
      .insert({
        user_id,
        question,
        answer,
        relevant_note_ids: allRelevantIds,
      })
      .select()
      .single();

    if (saveError) throw saveError;

    return new Response(
      JSON.stringify({
        success: true,
        answer,
        relevant_notes: relevantNotesOut,
        question_id: savedQuestion.id,
        key_points: keyPoints,
        inline_sources: inlineSources,
        note_title_map: Object.fromEntries(
          notesToUse.map((n, i) => [`Note ${i + 1}`, { id: n.id, title: n.title }])
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
