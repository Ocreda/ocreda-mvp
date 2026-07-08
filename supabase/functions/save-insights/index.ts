import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface SaveInsightsRequest {
  question_id: string;
  user_id: string;
  // If accepted_insights is provided, save them — otherwise generate candidates
  accepted_insights?: Array<{ title: string; content: string; type: string; tags: string[] }>;
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

    const { question_id, user_id, accepted_insights }: SaveInsightsRequest = await req.json();

    // ── SAVE MODE: caller has already reviewed and selected insights ─────────
    if (accepted_insights && accepted_insights.length > 0) {
      const insertPayload = accepted_insights.map((n) => ({
        user_id,
        title: n.title,
        content: n.content,
        type: n.type,
        tags: n.tags ?? [],
      }));

      const { data: savedNotes, error: insertErr } = await supabase
        .from("notes")
        .insert(insertPayload)
        .select("id, title, type, tags");

      if (insertErr) throw insertErr;

      return new Response(
        JSON.stringify({ success: true, mode: "saved", notes: savedNotes, count: savedNotes?.length ?? 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── GENERATE MODE: produce insight candidates for the user to review ─────

    // Load original question + answer
    const { data: question, error: qErr } = await supabase
      .from("questions")
      .select("question, answer, relevant_note_ids")
      .eq("id", question_id)
      .eq("user_id", user_id)
      .maybeSingle();

    if (qErr || !question) throw new Error("Question not found");

    // Load source notes content
    const sourceIds: string[] = question.relevant_note_ids ?? [];
    let sourceNotesText = "";
    if (sourceIds.length > 0) {
      const { data: sourceNotes } = await supabase
        .from("notes")
        .select("id, title, content")
        .in("id", sourceIds.slice(0, 8));

      if (sourceNotes && sourceNotes.length > 0) {
        sourceNotesText = "\n\nSOURCE NOTES:\n" + sourceNotes
          .map((n) => `"${n.title}": ${n.content}`)
          .join("\n\n---\n\n");
      }
    }

    // Load full conversation history
    const { data: history } = await supabase
      .from("conversation_messages")
      .select("role, content")
      .eq("question_id", question_id)
      .order("created_at", { ascending: true });

    const transcript: string[] = [];
    transcript.push(`Question: ${question.question}`);
    if (question.answer) transcript.push(`Answer: ${question.answer}`);
    for (const msg of (history ?? [])) {
      transcript.push(`${msg.role === "user" ? "You" : "Claude"}: ${msg.content}`);
    }
    const conversationText = transcript.join("\n\n");

    const systemPrompt = `You are a lateral thinking partner helping a user develop their ideas further.

Given a conversation the user had with their AI knowledge base, plus the source notes that informed the answer, generate 2-3 GENUINELY NEW insights.

What counts as a new insight:
- A connection between two ideas that isn't explicitly stated in any note
- An implication or consequence that follows logically but hasn't been written down
- A question or tension this topic raises that's worth exploring
- An analogy or reframe that casts existing knowledge in a new light
- A gap, contradiction, or next step implied by the current knowledge

What does NOT count:
- Summaries of what the notes already say
- Restating the answer in different words
- Generic observations anyone could make without reading the notes

Each insight must feel like a genuine "oh, I hadn't thought of it that way" moment.

Output ONLY a JSON array — no markdown, no explanation:
[
  {
    "title": "Short title (max 8 words)",
    "content": "2-3 sentences. The new idea, connection, or question. First person where natural.",
    "type": "idea",
    "tags": ["tag1", "tag2"]
  }
]

type must be one of: idea | question | connection | implication`;

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
        messages: [{
          role: "user",
          content: `CONVERSATION:\n${conversationText}${sourceNotesText}\n\nGenerate 2-3 new insights that are NOT already in the notes or conversation.`,
        }],
      }),
    });

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text();
      throw new Error(`Claude API error: ${err}`);
    }

    const claudeData = await claudeResponse.json();
    const rawJson = claudeData.content[0].text.trim();

    let candidates: Array<{ title: string; content: string; type: string; tags: string[] }> = [];
    try {
      candidates = JSON.parse(rawJson);
    } catch {
      const match = rawJson.match(/\[[\s\S]*\]/);
      if (match) candidates = JSON.parse(match[0]);
      else throw new Error("Failed to parse insight JSON from Claude");
    }

    return new Response(
      JSON.stringify({ success: true, mode: "candidates", candidates, count: candidates.length }),
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
