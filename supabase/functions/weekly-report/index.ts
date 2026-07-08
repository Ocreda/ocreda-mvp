import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { user_id, week_start, week_end } = await req.json();
    const apiKey = Deno.env.get("Claudebrain")!;

    const weekStartDate = new Date(week_start);
    const weekEndDate = new Date(week_end);
    weekEndDate.setHours(23, 59, 59, 999);

    // Fetch notes added this week
    const { data: weekNotes } = await supabase
      .from("notes")
      .select("id, title, content, tags, created_at")
      .eq("user_id", user_id)
      .gte("created_at", weekStartDate.toISOString())
      .lte("created_at", weekEndDate.toISOString())
      .order("created_at", { ascending: true });

    // Fetch questions asked this week
    const { data: weekQuestions } = await supabase
      .from("questions")
      .select("question, answer, created_at")
      .eq("user_id", user_id)
      .gte("created_at", weekStartDate.toISOString())
      .lte("created_at", weekEndDate.toISOString())
      .order("created_at", { ascending: true });

    // Fetch new connections formed this week
    const { data: weekRelations } = await supabase
      .from("note_relations")
      .select("note_id, related_note_id, reason, note:notes!note_id(title, user_id)")
      .gte("created_at", weekStartDate.toISOString())
      .lte("created_at", weekEndDate.toISOString())
      .limit(50);

    const userRelations = (weekRelations || []).filter((r: any) => {
      const n = Array.isArray(r.note) ? r.note[0] : r.note;
      return n && n.user_id === user_id;
    });

    // Fetch memory strength changes (notes viewed this week)
    const { data: strengthData } = await supabase
      .from("note_memory_strength")
      .select("note_id, score, access_count, last_accessed, note:notes!note_id(title)")
      .eq("user_id", user_id)
      .gte("last_accessed", weekStartDate.toISOString())
      .lte("last_accessed", weekEndDate.toISOString())
      .order("score", { ascending: false })
      .limit(20);

    // Fetch contradictions found this week
    const { data: weekContradictions } = await supabase
      .from("note_contradictions")
      .select("contradiction_summary, note_a:notes!note_id_a(title), note_b:notes!note_id_b(title)")
      .eq("user_id", user_id)
      .gte("created_at", weekStartDate.toISOString())
      .lte("created_at", weekEndDate.toISOString());

    const stats = {
      notes_added: (weekNotes || []).length,
      questions_asked: (weekQuestions || []).length,
      connections_formed: userRelations.length,
      notes_reviewed: (strengthData || []).length,
      contradictions_found: (weekContradictions || []).length,
    };

    // Build context for Claude
    const notesText = (weekNotes || [])
      .map((n) => `- "${n.title}": ${n.content.slice(0, 200)}`)
      .join("\n");

    const questionsText = (weekQuestions || [])
      .map((q) => `- ${q.question}`)
      .join("\n");

    const connectionsText = userRelations
      .slice(0, 15)
      .map((r: any) => {
        const n = Array.isArray(r.note) ? r.note[0] : r.note;
        return `- "${n?.title}" connected because: ${r.reason}`;
      })
      .join("\n");

    const strengthText = (strengthData || [])
      .slice(0, 10)
      .map((s: any) => {
        const n = Array.isArray(s.note) ? s.note[0] : s.note;
        return `- "${n?.title}" (score: ${Math.round(s.score)})`;
      })
      .join("\n");

    const contradictionsText = (weekContradictions || [])
      .map((c: any) => `- ${c.contradiction_summary}`)
      .join("\n");

    const noActivity =
      stats.notes_added === 0 &&
      stats.questions_asked === 0 &&
      stats.connections_formed === 0;

    let reportText = "";

    if (noActivity) {
      reportText = `This was a quiet week. No new notes, questions, or connections were recorded. Sometimes the mind needs rest before it can grow again. Your knowledge base is waiting for you whenever you're ready.`;
    } else {
      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 1200,
          messages: [
            {
              role: "user",
              content: `Write a warm, personal weekly brain report for someone reviewing their personal knowledge base. Write it as a letter addressed to them — "you" — not about them in third person. Make it feel like a thoughtful friend who watched your mind work this week.

WEEK: ${week_start} to ${week_end}

NOTES ADDED THIS WEEK (${stats.notes_added}):
${notesText || "None"}

QUESTIONS ASKED (${stats.questions_asked}):
${questionsText || "None"}

NEW CONNECTIONS FORMED (${stats.connections_formed}):
${connectionsText || "None"}

MEMORIES THAT RESURFACED / NOTES REVIEWED:
${strengthText || "None"}

CONTRADICTIONS DETECTED (${stats.contradictions_found}):
${contradictionsText || "None"}

Write a narrative of 3-5 paragraphs. Cover naturally:
- What themes dominated their thinking this week
- What new connections their mind made (if any)
- What they've been searching for or questioning
- What old memories resurfaced (if any)
- How their knowledge graph grew or shifted

Be warm, insightful, and specific to what actually happened. Do not use bullet points or headers. Write flowing prose. If something didn't happen (e.g. no contradictions), don't mention it at all. End with one sentence that feels like a gentle invitation to keep going.`,
            },
          ],
        }),
      });

      if (claudeRes.ok) {
        const data = await claudeRes.json();
        reportText = data.content?.[0]?.text?.trim() ?? "";
      }

      if (!reportText) {
        reportText = `This week you added ${stats.notes_added} note${stats.notes_added !== 1 ? "s" : ""}, asked ${stats.questions_asked} question${stats.questions_asked !== 1 ? "s" : ""}, and formed ${stats.connections_formed} new connection${stats.connections_formed !== 1 ? "s" : ""}. Your brain kept working. Keep going.`;
      }
    }

    // Save report to DB
    const { data: saved, error: saveError } = await supabase
      .from("weekly_reports")
      .upsert({
        user_id,
        week_start,
        week_end,
        report_text: reportText,
        stats,
      }, { onConflict: "user_id,week_start" })
      .select()
      .maybeSingle();

    if (saveError) throw saveError;

    return new Response(
      JSON.stringify({ report: saved }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
