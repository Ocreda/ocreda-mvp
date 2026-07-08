import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

interface FindMemoryRequest {
  user_id: string;
  fragment: string;
  conversation: ConversationTurn[];
  session_id?: string;
  hint_category?: string;
}

interface NoteRow {
  id: string;
  title: string | null;
  content: string;
  tags: string[];
  category: string | null;
}

interface RankedNote {
  id: string;
  title: string;
  content: string;
  tags: string[];
  score: number;
  reason: string;
}

async function callClaude(prompt: string, apiKey: string, maxTokens = 3000): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

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

    const body: FindMemoryRequest = await req.json();
    const { user_id, fragment, conversation = [], session_id, hint_category } = body;

    if (!user_id) throw new Error("user_id is required");
    if (!fragment) throw new Error("fragment is required");

    // ALWAYS fetch ALL notes — never filter by category or candidates
    const { data: noteRows, error: notesError } = await supabase
      .from("notes")
      .select("id, title, content, tags, category")
      .eq("user_id", user_id)
      .order("created_at", { ascending: false });

    if (notesError) throw new Error(`Supabase error: ${notesError.message}`);

    const notes: NoteRow[] = (noteRows || []).map((n) => ({
      id: n.id,
      title: n.title ?? null,
      content: n.content ?? "",
      tags: Array.isArray(n.tags) ? n.tags : [],
      category: n.category ?? null,
    }));

    if (notes.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          session_id: session_id ?? null,
          ranked_notes: [],
          clarifying_question: "You don't have any notes yet. Start adding notes and I'll help you find them.",
          done: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Conversation context
    const convText = conversation.length > 0
      ? "\n\nCONVERSATION SO FAR:\n" +
        conversation.map((t) => `${t.role === "user" ? "User" : "AI"}: ${t.text}`).join("\n")
      : "";

    // Category hint context (soft signal only — never filters)
    const categoryHint = hint_category
      ? `\n\nThe user mentioned "${hint_category}" as a possible category hint, but the correct note may be in ANY category — do not restrict scoring to that category.`
      : "";

    // Build notes list
    const notesText = notes
      .map((n, i) => {
        const cat = n.category ? ` [${n.category}]` : "";
        return `[${i + 1}] ID:${n.id}\nTitle: ${n.title || "(untitled)"}${cat}\nContent: ${n.content.slice(0, 380)}`;
      })
      .join("\n\n---\n\n");

    // Already-asked questions
    const askedQuestions = conversation
      .filter((t) => t.role === "assistant")
      .map((t) => `- ${t.text}`)
      .join("\n");

    const prompt = `You are helping a user recover a specific note from their personal knowledge base. They remember something about it but not exactly which note it was.

MEMORY FRAGMENT: "${fragment}"${categoryHint}${convText}

NOTES TO SEARCH (${notes.length} total — ALL notes, not filtered by category):
${notesText}

${askedQuestions ? `QUESTIONS ALREADY ASKED (do NOT repeat any of these):\n${askedQuestions}\n` : ""}
Your task:
1. Score every note 0.0–1.0 based on how likely it matches the memory fragment + conversation context. Consider all notes equally regardless of category.
2. If the top note has score >= 0.90 AND is clearly ahead of all others (next best score <= 0.65), set done=true.
3. Otherwise set done=false and write ONE short, specific clarifying question designed to eliminate the most candidates. Ask about a concrete difference between the top candidates — a topic, timeframe, person, specific detail, or format. Never ask a vague question. Never repeat a previously asked question.

Return ONLY valid JSON — no markdown fences, no explanation:
{
  "scores": [{"id": "uuid", "score": 0.85, "reason": "one short sentence why"}],
  "clarifying_question": "Your specific question here",
  "done": false
}`;

    const rawText = await callClaude(prompt, apiKey, 3500);

    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`No JSON in Claude response: ${rawText.slice(0, 300)}`);

    let parsed: { scores: Array<{ id: string; score: number; reason: string }>; clarifying_question: string; done: boolean };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error(`Failed to parse Claude JSON: ${match[0].slice(0, 300)}`);
    }

    if (!Array.isArray(parsed.scores)) throw new Error("scores is not an array");

    const noteMap = new Map(notes.map((n) => [n.id, n]));

    const ranked_notes: RankedNote[] = parsed.scores
      .filter((r) => noteMap.has(r.id) && typeof r.score === "number")
      .map((r) => {
        const n = noteMap.get(r.id)!;
        return {
          id: n.id,
          title: n.title || "",
          content: n.content,
          tags: n.tags,
          score: Math.max(0, Math.min(1, r.score)),
          reason: r.reason || "",
        };
      })
      .sort((a, b) => b.score - a.score);

    // Include any notes Claude skipped at low score
    const scoredIds = new Set(ranked_notes.map((r) => r.id));
    for (const n of notes) {
      if (!scoredIds.has(n.id)) {
        ranked_notes.push({ id: n.id, title: n.title || "", content: n.content, tags: n.tags, score: 0.02, reason: "" });
      }
    }

    const done = !!parsed.done;
    const clarifying_question = parsed.clarifying_question || "";

    const updatedConversation: ConversationTurn[] = [
      ...conversation,
      ...(clarifying_question && !done ? [{ role: "assistant" as const, text: clarifying_question }] : []),
    ];

    const chainNoteIds = ranked_notes.slice(0, 5).map((n) => n.id);

    // Persist session
    let sessionId = session_id;
    if (!sessionId) {
      const { data: sess } = await supabase
        .from("memory_sessions")
        .insert({ user_id, fragment, conversation: updatedConversation, chain_note_ids: chainNoteIds })
        .select("id")
        .single();
      sessionId = sess?.id;
    } else {
      await supabase
        .from("memory_sessions")
        .update({ conversation: updatedConversation, chain_note_ids: chainNoteIds, updated_at: new Date().toISOString() })
        .eq("id", sessionId);
    }

    return new Response(
      JSON.stringify({ success: true, session_id: sessionId, ranked_notes, clarifying_question, done }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("find-memory error:", message);
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
