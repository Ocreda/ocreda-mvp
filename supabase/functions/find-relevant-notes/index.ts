import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  addTokenUsage,
  corsHeaders,
  emptyTokenUsage,
  generateWithGeminiResult,
  isRetryableGeminiError,
  modelForTier,
  readModelTier,
  type ModelTier,
  type TokenUsage,
} from "../_shared/gemini.ts";
import {
  findDraftSections,
  findInsight,
  FAILED_INSIGHT,
  readGoalContext,
  searchRelevance,
  searchResponseFields,
  streamRelevanceSearch,
  DEFAULT_AGENT_CONCURRENCY,
  DEFAULT_AGENT_COUNT,
  MAX_RESULTS_PER_SECTION,
  MIN_DRAFT_CHARS,
  type DraftSection,
  type GoalContext,
  type InsightOutcome,
  type NoteLike,
  type RelevanceResult,
} from "../_shared/relevance.ts";

const MAX_NOTES = 1000;

/**
 * The combined "Summary of related notes" is switched off: the insight card
 * replaced it. The code is kept so it can come back without a redeploy - set
 * the RELEVANCE_COMBINED_SUMMARY secret to "on". It costs one extra model call
 * per search while on.
 */
const COMBINED_SUMMARY_ENABLED = Deno.env.get("RELEVANCE_COMBINED_SUMMARY") === "on";

/**
 * Same reasoning as SUMMARY_TOKEN_BUDGET below: headroom for a thinking model.
 * Higher than the summary's because a draft with many ideas gets a card for
 * each, and a cut-off reply loses every card, not just the last.
 */
const INSIGHT_TOKEN_BUDGET = 8000;
/** The split returns a few words per idea; the rest is room for reasoning. */
const SECTION_TOKEN_BUDGET = 3000;
const SECTION_SYSTEM_PROMPT =
  "You divide a person's note into the separate ideas it contains. You respond with a JSON object and nothing else.";
const INSIGHT_SYSTEM_PROMPT =
  "You help a person act on their own past notes. You respond with a JSON object and nothing else.";
/**
 * A ceiling, not a target: only generated tokens are billed, and the summary
 * itself needs ~150. The headroom is for a thinking model's reasoning, which
 * shares this budget - at 320 the reasoning consumed it and the summary arrived
 * cut off after one line. Kept finite only so a runaway generation cannot bill
 * indefinitely.
 */
const SUMMARY_TOKEN_BUDGET = 3000;

const BASE_NOTE_COLUMNS = "id, raw_text, summary, created_at";

/** The same test lib/notes-api.ts uses to detect a notes table without the category column. */
function isMissingCategoryColumn(error: { message?: string; code?: string }): boolean {
  const message = (error.message ?? "").toLowerCase();
  return error.code === "42703" ||
    (message.includes("category") && (message.includes("does not exist") || message.includes("schema cache")));
}

/**
 * Supabase errors are plain objects rather than Error instances, so reading
 * only Error.message logged them as "Unknown error" and hid the cause.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

const AGENT_SYSTEM_PROMPT =
  "You identify meaningful relationships between a person's notes. You respond with a JSON array and nothing else.";

/**
 * One line per search in the Supabase function logs, so cost can be measured
 * on real traffic. Operator-only: never add this to a response body. It holds
 * counts only, no note text and no user id.
 */
function logUsage(usage: TokenUsage, notesTotal: number, sectionsTotal: number, startedAt: number, context: GoalContext, tier: ModelTier): void {
  console.log(JSON.stringify({
    event: "find_relevant_notes_usage",
    notes_total: notesTotal,
    sections_total: sectionsTotal,
    has_goal: Boolean(context.goal),
    model_tier: tier,
    llm_calls: usage.calls,
    input_tokens: usage.inputTokens,
    cached_input_tokens: usage.cachedInputTokens,
    output_tokens: usage.outputTokens,
    reasoning_tokens: usage.reasoningTokens,
    cost_usd: Number(usage.costUsd.toFixed(6)),
    duration_ms: Date.now() - startedAt,
  }));
}

async function findMatchInsight(
  draft: string,
  context: GoalContext,
  notes: NoteLike[],
  results: RelevanceResult[],
  sections: DraftSection[],
  excludeNoteId: string | null,
  apiKey: string,
  usage: TokenUsage,
  model: string,
): Promise<InsightOutcome> {
  try {
    return await findInsight({
      draft,
      context,
      notes,
      results,
      sections,
      excludeNoteId,
      generate: async (prompt) => {
        const { text, truncated, usage: callUsage } = await generateWithGeminiResult(
          INSIGHT_SYSTEM_PROMPT,
          [{ role: "user", content: prompt }],
          apiKey,
          model,
          { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: INSIGHT_TOKEN_BUDGET },
        );
        addTokenUsage(usage, callUsage);
        // Cut-off JSON will not parse, which drops the insight; say why in the logs.
        if (truncated) console.error("find-relevant-notes insight hit the token budget");
        return text;
      },
    });
  } catch (error) {
    // The matches are still worth showing without an insight.
    console.error("find-relevant-notes insight failed:", error instanceof Error ? error.message : error);
    return FAILED_INSIGHT;
  }
}

async function summarizeMatches(results: RelevanceResult[], apiKey: string, usage: TokenUsage, model: string): Promise<string> {
  // The reading workspace displays eight related notes, so summarize that same
  // set rather than describing results the user cannot see.
  const gists = results.slice(0, 8).map((result) => result.gist.trim()).filter(Boolean);
  if (!gists.length) return "";
  const fallback = gists.join(" ");
  try {
    const { text, truncated, usage: callUsage } = await generateWithGeminiResult(
      "These are the person's own notes. Talk to them about what the notes add up to, the way a thoughtful friend would, in 2-4 plain sentences. Speak directly to them in the second person: \"you wrote\", \"you keep coming back to\", \"you seem torn between\". Never call them \"the author\", \"the writer\", or \"the user\", and never describe the notes from the outside (\"these notes discuss\"). Anyone else mentioned keeps their name. Cover the distinct ideas across all of them, including any tension between them. Use only the supplied facts. Do not mention the search, relevance scores, or the act of summarizing. Return only the summary text.",
      [{ role: "user", content: gists.map((gist, index) => `Note ${index + 1}: ${gist}`).join("\n") }],
      apiKey,
      model,
      // The budget covers the model's reasoning as well as the sentences the
      // reader sees. A thinking model spent most of 320 on reasoning and left
      // the summary cut off after one line, so keep the ceiling well clear of
      // the handful of sentences actually asked for.
      { temperature: 0.2, maxOutputTokens: SUMMARY_TOKEN_BUDGET },
    );
    addTokenUsage(usage, callUsage);
    const summary = text.trim();
    // Half a sentence reads as a bug. The gists are whole, so prefer them.
    if (!summary || truncated) {
      if (truncated) console.error("find-relevant-notes summary hit the token budget; using gists");
      return fallback;
    }
    return summary.slice(0, 1600);
  } catch (error) {
    console.error("find-relevant-notes summary failed:", error instanceof Error ? error.message : error);
    return fallback;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    // The caller's own JWT scopes every read below through RLS. The user id is
    // never read from the request body, so a caller cannot fetch someone else's
    // notes by passing a different id.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization header" }, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Invalid or expired session" }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => null);
    const draftText = typeof body?.draft_text === "string" ? body.draft_text.trim() : "";
    const excludeNoteId = typeof body?.exclude_note_id === "string" ? body.exclude_note_id : null;
    const goalContext = readGoalContext(body?.domain);
    const tier = readModelTier(body?.model_tier);
    const model = modelForTier(tier);

    if (draftText.length < MIN_DRAFT_CHARS) {
      return json({ error: "Write a little more before searching for related notes." }, 400);
    }

    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) return json({ error: "Relevance search is not configured." }, 500);

    const loadNotes = (columns: string) => {
      let query = supabase
        .from("notes")
        .select(columns)
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(MAX_NOTES);
      if (excludeNoteId) query = query.neq("id", excludeNoteId);
      return query;
    };

    // The rebuilt notes table (20260723080000_rebuild_as_second_brain.sql) has
    // no category column, so fall back without it, as lib/notes-api.ts does.
    // The goal still applies; only the Domain's recent notes go missing.
    let loaded = await loadNotes(`${BASE_NOTE_COLUMNS}, category`);
    if (loaded.error && isMissingCategoryColumn(loaded.error)) loaded = await loadNotes(BASE_NOTE_COLUMNS);
    if (loaded.error) throw new Error(`Loading notes failed: ${loaded.error.message}`);

    const notes = (loaded.data ?? []) as unknown as NoteLike[];
    if (notes.length === 0) {
      return json({
        results: [],
        coverage: { notes_searched: 0, notes_total: 0, complete: true },
      });
    }

    const startedAt = Date.now();
    const usage = emptyTokenUsage();
    // The whole draft goes to every agent, however long: cutting its middle
    // would hide the ideas there from the search.
    const draft = draftText;
    const summarize = COMBINED_SUMMARY_ENABLED
      ? (results: RelevanceResult[]) => summarizeMatches(results, apiKey, usage, model)
      : undefined;
    const insightFor = (results: RelevanceResult[], sections: DraftSection[]) =>
      findMatchInsight(draft, goalContext, notes, results, sections, excludeNoteId, apiKey, usage, model);
    let sectionsTotal = 0;
    const findSections = async (text: string) => {
      const sections = await findDraftSections({
        draft: text,
        generate: async (prompt) => {
          const { text: reply, truncated, usage: callUsage } = await generateWithGeminiResult(
            SECTION_SYSTEM_PROMPT,
            [{ role: "user", content: prompt }],
            apiKey,
            model,
            { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: SECTION_TOKEN_BUDGET },
          );
          addTokenUsage(usage, callUsage);
          if (truncated) console.error("find-relevant-notes idea split hit the token budget");
          return reply;
        },
        // The search goes on by paragraph; the log says why.
        onError: (error) => console.error("find-relevant-notes idea split failed:", errorMessage(error)),
      });
      sectionsTotal = sections.length;
      return sections;
    };
    const searchOptions = {
      maxPerSection: MAX_RESULTS_PER_SECTION,
      findSections,
      summarize,
      findInsight: insightFor,
      draft,
      notes,
      goal: goalContext.goal,
      agentCount: DEFAULT_AGENT_COUNT,
      concurrency: DEFAULT_AGENT_CONCURRENCY,
      isRetryable: isRetryableGeminiError,
      generate: async (prompt: string) => {
        try {
          const { text, usage: callUsage } = await generateWithGeminiResult(
            AGENT_SYSTEM_PROMPT,
            [{ role: "user", content: prompt }],
            apiKey,
            model,
            { responseMimeType: "application/json", temperature: 0.2 },
          );
          addTokenUsage(usage, callUsage);
          return text;
        } catch (error) {
          // Otherwise a dead key or empty balance only ever surfaces as
          // "unavailable"; this line says which (401, 402, 429...).
          console.error("find-relevant-notes agent call failed:", errorMessage(error));
          throw error;
        }
      },
    };

    // Callers that ask for it get progress as each agent finishes. Anyone who
    // doesn't still gets the single JSON response below.
    if (body?.stream === true) {
      const stream = streamRelevanceSearch({
        ...searchOptions,
        allFailedMessage: "Relevance search is unavailable right now. Please try again.",
        failedMessage: "Relevance search failed. Please try again.",
        onError: (error) =>
          console.error("find-relevant-notes stream failed:", error instanceof Error ? error.message : error),
      });
      // Log once the stream has ended, when every call has been counted.
      const logged = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        flush: () => logUsage(usage, notes.length, sectionsTotal, startedAt, goalContext, tier),
      }));
      return new Response(logged, {
        headers: { ...corsHeaders, "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
      });
    }

    const outcome = await searchRelevance({
      ...searchOptions,
      onError: (error) => console.error("find-relevant-notes follow-up failed:", errorMessage(error)),
    });
    logUsage(usage, notes.length, sectionsTotal, startedAt, goalContext, tier);

    // Every agent failed: report an outage rather than an empty result set,
    // which would read as "nothing in your notes is related".
    if (outcome.notesSearched === 0) {
      return json({ error: "Relevance search is unavailable right now. Please try again." }, 502);
    }
    return json(searchResponseFields(outcome));
  } catch (error) {
    console.error("find-relevant-notes failed:", errorMessage(error));
    return json({ error: "Relevance search failed. Please try again." }, 500);
  }
});
