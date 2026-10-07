/**
 * Pure logic behind the find-relevant-notes fan-out: chunking, prompt
 * construction, response validation, and merging. Kept free of Deno, Supabase,
 * and network calls so it can be exercised directly by tests.
 */

export const RELATION_TYPES = ["supports", "extends", "contradicts", "question", "parallel", "helps", "solves"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * Each relation has its own bar, set by the cost of being wrong rather than by
 * how often it occurs: a false contradiction makes the app look broken, while
 * a slightly-off "extends" costs almost nothing. Quality is tuned by moving
 * these numbers, not by rewriting the prompt. Anything under its bar is
 * dropped, never relabelled as something weaker and shown anyway.
 */
export const RELATION_MIN_SCORE: Record<RelationType, number> = {
  contradicts: 0.85,
  parallel: 0.8,
  solves: 0.7,
  helps: 0.7,
  question: 0.7,
  supports: 0.65,
  extends: 0.6,
};

/**
 * How much each earlier pick of the same relation costs a candidate, so three
 * notes that all "support" do not crowd out a slightly weaker contradiction.
 */
export const VARIETY_PENALTY = 0.05;

/**
 * Chunking policy, shared by the Edge Function, the local dev route, and the
 * try:relevance harness so none of them can drift from the others.
 *
 * Count and concurrency are equal so every agent runs in one wave; raising the
 * count alone just adds a second wave.
 *
 * These numbers are measured, not reasoned. On a 100-note corpus:
 *   10 agents x 10 notes, concurrency 10 -> 14.3s
 *    5 agents x 20 notes, concurrency  5 -> 17.8s
 * Fewer, larger chunks lose, because latency here is dominated by *output*
 * generation, which is serial within a call. Concentrating the hits into fewer
 * calls makes each one generate more text; spreading them across more parallel
 * calls is what actually helps. Anything that only shrinks input — prefix
 * caching, a smaller MAX_NOTE_CHARS — barely moves the number.
 *
 * Concurrency 10 means a burst of 10 requests per click, which fits a single
 * user on Gemini's free tier (~15 RPM) but will start returning 429s with
 * several users at once. Lower it if you see rate limiting.
 */
export const DEFAULT_AGENT_COUNT = 10;
export const DEFAULT_AGENT_CONCURRENCY = 10;

export const MAX_NOTE_CHARS = 800;
export const MAX_DRAFT_CHARS = 6000;
export const MIN_DRAFT_CHARS = 20;
/** Up to two plain sentences rather than one clipped clause, so this is roomier. */
export const MAX_EXPLANATION_CHARS = 320;
/** One sentence restating the note, shown when the card is flipped to its summary. */
export const MAX_GIST_CHARS = 220;

export interface NoteLike {
  id: string;
  raw_text: string;
  summary: string | null;
  created_at: string;
  /** The note's Domain name. Only read when building an insight's context. */
  category?: string | null;
}

/**
 * What the person is working toward in the Domain the draft belongs to. The
 * goal is the Domain's description, which lives in the browser, so the caller
 * sends it with each search rather than the server reading it.
 */
export interface GoalContext {
  domain: string | null;
  goal: string | null;
}

export const MAX_GOAL_CHARS = 300;
export const MAX_DOMAIN_NAME_CHARS = 80;

/** Cleans a caller-supplied goal context. Anything malformed becomes null. */
export function readGoalContext(raw: unknown): GoalContext {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const clean = (value: unknown, limit: number) =>
    typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, limit) : null;
  return { domain: clean(row.name, MAX_DOMAIN_NAME_CHARS), goal: clean(row.goal, MAX_GOAL_CHARS) };
}

/**
 * Which way help flows between a note and the draft. "inbound": the note helps
 * the draft (the draft is a situation, the note a solution, lesson, or
 * counterpoint). "outbound": the draft helps the note (the draft is a
 * solution or lesson, the note a problem it applies to). It belongs to the
 * pair, not the note: the same book quote can go either way.
 */
export const DIRECTIONS = ["inbound", "outbound"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface RelevanceResult {
  note_id: string;
  relevance_score: number;
  relation_type: RelationType;
  direction: Direction;
  /** What the note itself says. Empty when the model left it out. */
  gist: string;
  /** How the note bears on the draft. */
  explanation: string;
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

/**
 * Long drafts get repeated into every agent prompt, so cap them — but keep the
 * tail as well as the head, since the thought a writer is currently developing
 * tends to live at the end of what they have written so far.
 */
export function condenseDraft(text: string): string {
  if (text.length <= MAX_DRAFT_CHARS) return text;
  return `${text.slice(0, 4000)}\n\n[...]\n\n${text.slice(-2000)}`;
}

/**
 * Deal notes out round-robin rather than in contiguous slices. Notes arrive
 * ordered by creation date, so slicing would hand one agent an entire era of
 * the user's thinking while another gets nothing on topic.
 */
export function dealIntoChunks<T>(items: T[], chunkCount: number): T[][] {
  const chunks: T[][] = Array.from({ length: Math.min(chunkCount, items.length) }, () => []);
  if (chunks.length === 0) return [];
  items.forEach((item, index) => chunks[index % chunks.length].push(item));
  return chunks;
}

/**
 * The instructions come first and the draft and notes last, so that every agent
 * in a fan-out sends an identical multi-thousand-character prefix. That is what
 * makes the provider's implicit prefix caching usable; putting the variable
 * content first would give the calls nothing in common to cache. The goal is
 * variable too, so it sits beside the draft; only its instructions are fixed.
 */
export function buildPrompt(draft: string, notes: NoteLike[], goal: string | null = null): string {
  const candidates = notes
    .map((note) => `ID: ${note.id}\n${truncate((note.summary || note.raw_text).trim(), MAX_NOTE_CHARS)}`)
    .join("\n\n---\n\n");
  const goalBlock = goal
    ? `\n\nWhat they are working toward in this area:\n<goal>\n${goal}\n</goal>`
    : "";

  return `You will be given a draft that someone is writing, followed by a set of notes from their knowledge base. Decide which of those notes are genuinely relevant to the draft, and score each one on its own merits.

A draft is not always an argument. It may be a claim, a decision, a plan, a memory, a worry, or a half-formed reflection. Judge relevance against whatever the draft is actually doing, not against whether it makes a provable point.

SCORING - judge each note against the draft in absolute terms. Do NOT score a note relative to the other candidates you were given. If every candidate here is irrelevant, return an empty array; that is a normal and correct outcome.

Score the strength of the connection, NOT how similar the subject matter is. A note about something else entirely can score high if the link it reveals is strong and specific.

0.90-1.00 - Reading this note would change what the user writes next. It speaks straight to what the draft is working out, or shows them something about it they had not seen.
0.70-0.89 - A clear, specific connection that adds something real: evidence, a concrete example, a counterweight, an unresolved snag, or a pattern the draft turns out to be an instance of.
0.50-0.69 - A real but looser connection: it shares the draft's underlying concern or stance and is worth having nearby, without changing anything.
Below 0.50 - Leave it out of your response entirely.

GOAL - you may also be told what the person is working toward in this area. When you are, a note that would help them toward it - a past attempt and how it went, advice they recorded, a decision they made, a fact that changes the picture - deserves a higher score than one that is merely on the same subject. Never include a note only because it matches the goal; it must still bear on the draft.

RELATION TYPE - pick exactly one:
"solves" - the note answers the problem or open question the draft raises: a fix, a method, or an answer that would settle it.
"helps" - the note is useful toward what the draft is trying to do without settling it: advice, a technique, a lesson, or a past attempt and how it went.
"supports" - the note gives grounds for what the draft says or feels: evidence, an example, a lived experience, or reasoning that makes it sturdier.
"extends" - the note stands on the same ground and carries it further: more detail, a consequence, a next step, or a fuller version of the same thought.
"contradicts" - the note pulls against the draft: it states something incompatible, names a cost the draft ignores, or records a position the draft is reversing.
"question" - the note raises something the draft leaves open: an obstacle, a tension, or a question it brushes past without settling.
"parallel" - the note is about something else entirely, but the same shape shows up in it: the same pattern, tension, or way of seeing, appearing in a different part of the person's life. The link is structural, not topical.

DIRECTION - which way the help flows between this note and the draft. Decide it for each note on its own; the same note can go either way against different drafts.
"inbound" - the note helps the draft. Usually the draft describes a situation (a problem, a project, an open question, a plan, what happened) and the note brings something to it: a solution, advice, a lesson, evidence, a counterpoint, or a past attempt.
"outbound" - the draft helps the note. Usually the draft is a solution or a lesson (a book quote, an article, a principle, a rule, advice, a technique that worked) and the note describes a situation it applies to: a problem it solves, a question it answers, a plan it changes. Read the relation from that side: "solves" with "outbound" means the draft solves the problem in the note.
When both could fit, pick the one that better serves what they are working toward. For an outbound note, prefer problems that still look open; skip one that a later note shows was already resolved.

GIST - exactly one short sentence: what the note actually says, in your own words. These are the person's own notes, so say it back to them in the second person, the way a friend recapping it would: "You noticed...", "You decided...", "You're worried that...". Never call them "the author", "the writer", "the user", or "this person". Anyone else in the note keeps their name ("Maya told you..."). Keep its specifics (names, numbers, decisions). Do not mention the draft here; this must make sense on its own as a summary of the note.

EXPLANATION - one or two short sentences, in plain language, written to the person who wrote the draft: how the note bears on the draft, naming the specific thing in the draft it touches. Do not restate the gist; the reader sees them separately.
Write both the way you would explain it to a friend. Address them as "you" and call the draft "your draft". No jargon, no academic register, and never open with "This note highlights/underscores/demonstrates".
Do the thinking for them: spell the connection out rather than gesturing at it. Never say two things are "both about X" without saying what about X ties them together.

CRITICAL RULES:
- Many candidate notes will be irrelevant. Returning [] is correct when nothing connects. Do not pad your response.
- Never include a note merely because it shares words, names, or a broad category with the draft. The connection must be about substance.
- Leave out echoes. A note that says what the draft already says, without adding a fact, example, outcome, consequence, or counterpoint the draft lacks, tells the person nothing new however close the topic is. A note is not an echo if it shows the same thing actually happening, or happening before.
- Only call a note "contradicts" when the two really cannot both be true, or the note records a position the draft reverses. A difference in emphasis is not a contradiction.
- A "parallel" must name the specific shared structure. An abstraction that both notes merely belong to - "both are about time", "both express awe" - is not a parallel. If the same explanation could be written about a dozen other pairs of notes, leave the note out.
- Use the exact ID string as given. Never invent an ID, and never return one that is not listed above.

Worked examples:
- Draft: "From The Mom Test: ask people about what they did in the past, not what they would do in the future." Candidate note: "Tester interviews keep going nowhere - everyone says they'd use it, then nobody does." Score 0.91, relation_type "solves", direction "outbound", gist: "Your tester interviews keep ending with people saying they'd use it and then never doing.", explanation: "Your draft is the fix for this: those interviews asked what testers would do, which is exactly the question the book says gets you polite yeses."
- Draft: "Charging per seat punishes teams for adding people, so we should move to usage-based pricing." Candidate note: "Talked to Maya - she stopped adding teammates to the tool because each one cost another $12/mo." Score 0.94, relation_type "supports", gist: "You talked to Maya, a customer, who stopped adding teammates to the tool because each extra seat cost another $12 a month.", explanation: "That is the exact thing your draft argues, already happening to someone real - the problem with per-seat pricing isn't theoretical, she felt it and acted on it."
- Draft: "I'm always running late, however early I start." Candidate note: "I'm the last one in my friend group to get married. Good things seem to reach me last." Score 0.84, relation_type "parallel", gist: "You're the last of your friends to get married, and feel like good things tend to reach you last.", explanation: "It's not about punctuality at all, but it's the same shape as your draft - being behind turns up in two different corners of your life, one you cause and one you don't, which is worth sitting with."
- Draft: the pricing one again. Candidate note: "Pricing page redesign - make the CTA green and move testimonials above the fold." Omitted entirely: it shares the word "pricing" but has nothing to do with the draft's argument.

OUTPUT - a JSON array and nothing else, in this shape:
[{"note_id": "<exact id>", "relevance_score": <number>, "relation_type": "<solves|helps|supports|extends|contradicts|question|parallel>", "direction": "<inbound|outbound>", "gist": "<one sentence>", "explanation": "<one or two short sentences>"}]

========================================

Here is the draft:
<draft>
${draft}
</draft>${goalBlock}

Here are the candidate notes:

${candidates}

Now respond with ONLY the JSON array described above, no prose before or after it.`;
}

/**
 * The array counterpart of `extractJson` in ./gemini.ts, which only matches a
 * top-level object and so can never parse an agent's array response.
 */
export function extractJsonArray(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const bare = candidate.match(/\[[\s\S]*\]/);
  return bare ? bare[0] : null;
}

/**
 * Turns one agent's raw text into trustworthy results. Anything malformed is
 * dropped rather than repaired, and ids are checked against what this agent was
 * actually shown so hallucinated UUIDs cannot reach the user.
 */
export function parseAgentResponse(raw: string, allowedIds: Set<string>): RelevanceResult[] {
  const jsonText = extractJsonArray(raw);
  if (!jsonText) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const results: RelevanceResult[] = [];

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;

    const noteId = typeof row.note_id === "string" ? row.note_id : null;
    if (!noteId || !allowedIds.has(noteId) || seen.has(noteId)) continue;

    const relationType = RELATION_TYPES.includes(row.relation_type as RelationType)
      ? (row.relation_type as RelationType)
      : "extends";

    const score = Number(row.relevance_score);
    if (!Number.isFinite(score) || score < RELATION_MIN_SCORE[relationType]) continue;

    const explanation = typeof row.explanation === "string" ? row.explanation.trim() : "";
    if (!explanation) continue;
    // A missing gist is not worth losing a relevant note over; the UI just
    // won't offer the summary side for it.
    const gist = typeof row.gist === "string" ? row.gist.trim() : "";

    seen.add(noteId);
    results.push({
      note_id: noteId,
      relevance_score: Math.min(1, Math.max(0, score)),
      relation_type: relationType,
      // Most matches bring something to the draft, so that is the safe default.
      direction: DIRECTIONS.includes(row.direction as Direction) ? (row.direction as Direction) : "inbound",
      gist: truncate(gist, MAX_GIST_CHARS),
      explanation: truncate(explanation, MAX_EXPLANATION_CHARS),
    });
  }

  return results;
}

export interface AgentOutcome {
  chunkSize: number;
  /** null when the agent failed both attempts, so its notes went unread. */
  results: RelevanceResult[] | null;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

export interface RunAgentsOptions {
  draft: string;
  notes: NoteLike[];
  /** The Domain's stated goal, if the person gave one. */
  goal?: string | null;
  agentCount: number;
  concurrency: number;
  /** Injected so this module stays free of any particular model client. */
  generate: (prompt: string) => Promise<string>;
  /** Decides whether a thrown error is worth a second attempt. */
  isRetryable: (error: unknown) => boolean;
  onAgentSettled?: (index: number, outcome: AgentOutcome) => void;
}

/**
 * Fans the corpus out across agents and collects their verdicts. An agent that
 * fails both attempts yields a null result rather than throwing, so one bad
 * chunk degrades coverage instead of failing the whole search.
 */
export async function runRelevanceAgents(
  options: RunAgentsOptions
): Promise<{ chunks: NoteLike[][]; outcomes: AgentOutcome[] }> {
  const { draft, notes, goal, agentCount, concurrency, generate, isRetryable, onAgentSettled } = options;
  const chunks = dealIntoChunks(notes, agentCount);

  const settled = await runWithConcurrency(chunks, concurrency, async (chunk, index) => {
    const prompt = buildPrompt(draft, chunk, goal ?? null);
    const allowedIds = new Set(chunk.map((n) => n.id));
    // Reported the moment this agent finishes rather than after all of them, so
    // a caller can show progress while the rest are still running. Called
    // outside the try below, so a throwing callback is never mistaken for a
    // model failure and retried.
    const settle = (results: RelevanceResult[] | null) =>
      onAgentSettled?.(index, { chunkSize: chunk.length, results });

    for (let attempt = 0; ; attempt++) {
      let results: RelevanceResult[];
      try {
        results = parseAgentResponse(await generate(prompt), allowedIds);
      } catch (error) {
        if (attempt === 1 || !isRetryable(error)) {
          settle(null);
          throw error;
        }
        // Backoff with jitter so the agents don't all retry in lockstep.
        await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 700));
        continue;
      }
      settle(results);
      return results;
    }
  });

  const outcomes: AgentOutcome[] = settled.map((outcome, index) => ({
    chunkSize: chunks[index].length,
    results: outcome.status === "fulfilled" ? outcome.value : null,
  }));

  return { chunks, outcomes };
}

/**
 * Combines the agents' verdicts into one ranked list, and reports how many
 * notes were actually read. A failed agent contributes nothing to the count,
 * which is what lets the UI tell the user coverage was incomplete instead of
 * quietly presenting a partial search as a complete one.
 */
export function mergeAgentResults(
  outcomes: AgentOutcome[],
  createdAtById: Map<string, string>,
  maxResults: number,
  now: number = Date.now(),
): { results: RelevanceResult[]; notesSearched: number } {
  let notesSearched = 0;
  const merged = new Map<string, RelevanceResult>();

  for (const outcome of outcomes) {
    if (!outcome.results) continue;
    notesSearched += outcome.chunkSize;
    for (const result of outcome.results) {
      const existing = merged.get(result.note_id);
      if (!existing || result.relevance_score > existing.relevance_score) {
        merged.set(result.note_id, result);
      }
    }
  }

  const rankScore = new Map(
    Array.from(merged.values()).map((result) => [
      result.note_id,
      result.relevance_score + recencyBoost(result, createdAtById.get(result.note_id), now),
    ]),
  );
  const scoreOf = (result: RelevanceResult) => rankScore.get(result.note_id) ?? result.relevance_score;
  const ranked = Array.from(merged.values()).sort((a, b) => scoreOf(b) - scoreOf(a));

  return { results: diversifyByRelation(ranked, maxResults, VARIETY_PENALTY, scoreOf), notesSearched };
}

const DAY_MS = 86_400_000;

/**
 * Recency is a boost, never a filter, and only where age means something.
 * When the draft is the lesson (outbound), a recent problem is more likely
 * still open, so it edges ahead of an equally strong old one. When the draft
 * is the situation (inbound), the notes are solutions, and a principle does
 * not expire. Contradictions ignore recency entirely: "you believed the
 * opposite two years ago" is as valuable as last week.
 */
export function recencyBoost(result: RelevanceResult, createdAt: string | undefined, now: number): number {
  if (result.direction !== "outbound" || result.relation_type === "contradicts" || !createdAt) return 0;
  const ageDays = (now - Date.parse(createdAt)) / DAY_MS;
  if (!Number.isFinite(ageDays)) return 0;
  if (ageDays <= 30) return 0.03;
  if (ageDays <= 90) return 0.015;
  return 0;
}

/**
 * Re-picks an already ranked list so one relation cannot fill the top: each
 * earlier pick of the same relation costs a candidate VARIETY_PENALTY. A
 * clearly stronger match still wins; only near-ties give way to variety.
 * Equal adjusted scores keep their incoming order. Stops after `limit` picks.
 */
export function diversifyByRelation(
  ranked: RelevanceResult[],
  limit = ranked.length,
  penalty = VARIETY_PENALTY,
  scoreOf: (result: RelevanceResult) => number = (result) => result.relevance_score,
): RelevanceResult[] {
  const remaining = [...ranked];
  const picked: RelevanceResult[] = [];
  const counts = new Map<RelationType, number>();
  while (remaining.length && picked.length < limit) {
    let best = 0;
    let bestScore = -Infinity;
    remaining.forEach((result, index) => {
      const adjusted = scoreOf(result) - penalty * (counts.get(result.relation_type) ?? 0);
      if (adjusted > bestScore) { bestScore = adjusted; best = index; }
    });
    const [chosen] = remaining.splice(best, 1);
    picked.push(chosen);
    counts.set(chosen.relation_type, (counts.get(chosen.relation_type) ?? 0) + 1);
  }
  return picked;
}

// ------------------------------------------------------------------ insight

/**
 * What the draft is doing. It shapes which kind of action is useful: a way
 * forward when stuck, a missing consideration when deciding, a follow-up when
 * logging what happened.
 */
export const INSIGHT_INTENTS = ["stuck", "planning", "deciding", "capturing", "reflecting", "learning"] as const;
export type InsightIntent = (typeof INSIGHT_INTENTS)[number];

/**
 * The one thing from the person's past notes that should change what they do
 * next, tied to the passage of the draft it is about.
 */
export interface Insight {
  /** Verbatim text from the draft. Empty when the model's quote was not found in it. */
  anchor: string;
  intent: InsightIntent;
  /** What their past notes add, in one or two sentences. */
  text: string;
  /** One concrete next step. */
  action: string;
  /** The notes the insight rests on; always a subset of the search results. */
  note_ids: string[];
}

export interface InsightOutcome {
  /**
   * Up to MAX_INSIGHTS, each about a different passage of the draft. Empty
   * means nothing in the notes would change their next step.
   */
  insights: Insight[];
  /** Guesses at the Domain's goal, only when it has none. */
  goal_suggestions: string[];
  /**
   * What the draft is doing, even when there are no insights, so an empty
   * result can be worded for it. Null when the step was skipped or failed.
   */
  intent: InsightIntent | null;
  /**
   * The insight call errored or its reply could not be read. Distinct from an
   * empty list, which means the model looked and found nothing worth saying.
   */
  failed: boolean;
}

/** No strong matches, so the insight call never ran. */
export const SKIPPED_INSIGHT: InsightOutcome = { insights: [], goal_suggestions: [], intent: null, failed: false };
/** The insight call errored or returned something unreadable. */
export const FAILED_INSIGHT: InsightOutcome = { insights: [], goal_suggestions: [], intent: null, failed: true };

/** Only strong matches are worth building an insight on. */
export const INSIGHT_MIN_SCORE = 0.7;
/** One trigger per issue the draft raises, but never a margin full of them. */
export const MAX_INSIGHTS = 3;
export const MAX_INSIGHT_NOTES = 6;
export const MAX_DOMAIN_CONTEXT_NOTES = 10;
const MAX_CONTEXT_NOTE_CHARS = 200;
const MAX_ANCHOR_CHARS = 240;
const MIN_ANCHOR_CHARS = 8;
const MAX_INSIGHT_TEXT_CHARS = 420;
const MAX_ACTION_CHARS = 260;
const MAX_GOAL_SUGGESTION_CHARS = 60;
const MAX_GOAL_SUGGESTIONS = 3;

/** Folds the differences a model introduces when it copies text: case, curly quotes, dashes. */
function foldChar(ch: string): string {
  if (ch === "‘" || ch === "’") return "'";
  if (ch === "“" || ch === "”") return '"';
  if (ch === "–" || ch === "—") return "-";
  return ch.toLowerCase();
}

/** Lowercased, whitespace-collapsed text, with a map back to original offsets. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let lastWasSpace = true;
  for (let i = 0; i < text.length; i++) {
    const isSpace = /\s/.test(text[i]);
    if (isSpace && lastWasSpace) continue;
    folded += isSpace ? " " : foldChar(text[i]);
    map.push(i);
    lastWasSpace = isSpace;
  }
  return { folded, map };
}

/**
 * Locates a quoted passage in the text it was quoted from, forgiving case,
 * spacing, curly quotes, and a stray wrapping quote or ellipsis. Returns
 * offsets into the original text, or null when the quote is not really there.
 */
export function findAnchor(text: string, anchor: string): { start: number; end: number } | null {
  const trimmed = anchor.trim().replace(/^["'“‘.…\s]+|["'”’…\s]+$/g, "").replace(/\.{3}$/, "").trim();
  if (trimmed.length < MIN_ANCHOR_CHARS) return null;
  const needle = foldWithMap(trimmed).folded.trim();
  const { folded, map } = foldWithMap(text);
  const at = folded.indexOf(needle);
  if (at === -1) return null;
  return { start: map[at], end: map[at + needle.length - 1] + 1 };
}

export interface InsightMatch {
  note: NoteLike;
  result: RelevanceResult;
}

/** The strongest matches, in rank order, that an insight may draw on. */
export function selectInsightMatches(results: RelevanceResult[], notes: NoteLike[]): InsightMatch[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  return results
    .filter((result) => result.relevance_score >= INSIGHT_MIN_SCORE && byId.has(result.note_id))
    .slice(0, MAX_INSIGHT_NOTES)
    .map((result) => ({ note: byId.get(result.note_id)!, result }));
}

/**
 * The Domain's most recent notes, newest first. When the person has not stated
 * a goal, these are the best evidence of what they are working on.
 */
export function recentDomainNotes(notes: NoteLike[], domain: string | null, excludeId: string | null): NoteLike[] {
  if (!domain) return [];
  const key = domain.trim().toLowerCase();
  return notes
    .filter((note) => note.id !== excludeId && (note.category ?? "").trim().toLowerCase() === key)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_DOMAIN_CONTEXT_NOTES);
}

export interface InsightPromptInput {
  draft: string;
  context: GoalContext;
  recentNotes: NoteLike[];
  matches: InsightMatch[];
}

export function buildInsightPrompt({ draft, context, recentNotes, matches }: InsightPromptInput): string {
  const askForGoal = Boolean(context.domain && !context.goal);
  const recent = recentNotes.length
    ? recentNotes
      .map((note) => `- ${note.created_at.slice(0, 10)}: ${truncate((note.summary || note.raw_text).trim().replace(/\s+/g, " "), MAX_CONTEXT_NOTE_CHARS)}`)
      .join("\n")
    : "(none)";
  const related = matches
    .map(({ note, result }) =>
      `ID: ${note.id}\nWritten: ${note.created_at.slice(0, 10)}\nDirection: ${result.direction === "outbound" ? "outbound (the note being written helps this one)" : "inbound (this note helps the one being written)"}\nHow it relates: ${result.relation_type} - ${result.explanation}\n${truncate(note.raw_text.trim(), MAX_NOTE_CHARS)}`)
    .join("\n\n---\n\n");

  return `Someone is writing a note. You have the past notes of theirs that relate to it. Decide whether anything in those past notes should change what they do next, and if so, tell them in one short card.

INTENT - first work out what the note is doing. Pick exactly one:
"stuck" - they describe a problem they have not solved.
"planning" - they are laying out what they will do.
"deciding" - they are weighing options, or have just chosen.
"capturing" - they are logging what happened or what someone said.
"reflecting" - they are thinking something through, with no action in view.
"learning" - they are recording a lesson or a solution: a book quote, an article, a principle, advice, or a technique that worked.

WHAT COUNTS AS USEFUL - one of these, taken from their past notes:
- a past attempt at the same thing, and how it went
- advice they recorded from a book, a person, or another source
- a decision or conclusion they reached before, especially one this note contradicts or seems to have forgotten
- a pattern across several notes that this note is another instance of
- a number or fact that changes the picture
- when the note being written is a lesson or a solution: an earlier problem, question, or plan of theirs that it answers (these are marked outbound)
A past note that says the same thing as the draft is NOT useful. Reminding someone of what they just wrote is worthless, however on-topic it is.

GOAL - if they have said what they are working toward in this area, use it to decide what helps. If not, infer it from the draft and their recent notes in the area. If you still cannot tell, offer only something that helps whatever the goal is: a contradiction, a repeated pattern, or a hard number.

HOW MANY - a note can raise several separate issues. Give one insight per issue that clears the bar, at most ${MAX_INSIGHTS}, strongest first. Each must be about a different passage of the note, and must not repeat another insight's point. One insight is often right, and an empty list is a normal, frequent, and correct answer. Do not stretch to fill the slots.

For each insight:
ANCHOR - copy, word for word, the shortest phrase or sentence from the note being written that this insight is about, at most 25 words. Copy it exactly: do not paraphrase, fix typos, or add quotation marks. Two insights never share or overlap an anchor.
TEXT - one or two plain sentences saying what their past notes add. Name the specifics: people, numbers, what happened. Do not restate the note being written.
ACTION - one concrete next step, starting with a verb, that they could do this week. Fit it to the intent: for "stuck", a way forward; for "planning", something to add or check; for "deciding", the consideration they are missing; for "capturing", what to do with this (a follow-up, a question for next time); for "reflecting", a question worth answering; for "learning", where to apply it. Never generic advice like "keep going" or "reflect on this".
NOTE_IDS - the IDs of the past notes this insight rests on, only from the list given.
OUTBOUND - when the notes an insight rests on are outbound, the insight is about where this lesson applies. TEXT names that earlier situation and when it was ("On Sept 12 you were stuck on..."), and ACTION applies the lesson to it.
${askForGoal ? `
GOAL_SUGGESTIONS - they have not said what this area is for. Offer 2 or 3 short guesses at it, 2 to 6 words each and starting with a verb ("Validate pricing", "Find first 10 users"), based on the note and their recent notes in the area. Include these even when there are no insights.
` : ""}
VOICE - these are their own notes. Speak to them as "you", like a friend who remembers everything they have written. Plain words, no jargon. Never say "the user", "the author", or "this note highlights".

OUTPUT - a JSON object and nothing else, in this shape:
{"intent": "<stuck|planning|deciding|capturing|reflecting|learning>", "insights": [{"anchor": "<exact quote>", "text": "<one or two sentences>", "action": "<one step>", "note_ids": ["<id>"]}]${askForGoal ? ', "goal_suggestions": ["<guess>"]' : ""}}
with "insights" as [] when nothing clears the bar.

========================================

Area: ${context.domain ?? "(none)"}
What they are working toward in this area: ${context.goal ?? "(not stated)"}

Their most recent notes in this area:
${recent}

The note they are writing:
<note>
${draft}
</note>

Their related past notes:

${related}

Now respond with ONLY the JSON object described above.`;
}

/** Pulls a JSON object out of a model response, tolerating a fence or prose around it. */
function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const bare = candidate.match(/\{[\s\S]*\}/);
  return bare ? bare[0] : null;
}

function cleanLine(value: unknown, limit: number): string {
  return typeof value === "string" ? truncate(value.trim().replace(/\s+/g, " "), limit) : "";
}

/**
 * Turns the insight model's reply into something safe to show. An insight
 * without text, an action, or a single real citation is dropped rather than
 * shown half-formed. A quote that is not actually in the draft only loses its
 * highlight, since the card is still worth showing. An insight whose passage
 * overlaps an earlier one is about the same issue, so it is dropped.
 * Older replies with a single "insight" object are still read.
 */
export function parseInsightResponse(
  raw: string,
  { draft, allowedNoteIds, askForGoal }: { draft: string; allowedNoteIds: Set<string>; askForGoal: boolean },
): InsightOutcome {
  // A reply that cannot be read, including one cut off at the token budget,
  // is a failure rather than a verdict of "nothing useful".
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return FAILED_INSIGHT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return FAILED_INSIGHT;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return FAILED_INSIGHT;
  const row = parsed as Record<string, unknown>;

  const goalSuggestions = askForGoal && Array.isArray(row.goal_suggestions)
    ? [...new Set(row.goal_suggestions.map((item) => cleanLine(item, MAX_GOAL_SUGGESTION_CHARS)).filter(Boolean))]
      .slice(0, MAX_GOAL_SUGGESTIONS)
    : [];

  const statedIntent = INSIGHT_INTENTS.includes(row.intent as InsightIntent) ? (row.intent as InsightIntent) : null;
  const intent = statedIntent ?? "reflecting";
  const cards = Array.isArray(row.insights) ? row.insights : row.insight ? [row.insight] : [];

  const insights: Insight[] = [];
  const spans: { start: number; end: number }[] = [];
  const seenText = new Set<string>();
  for (const entry of cards) {
    if (insights.length >= MAX_INSIGHTS) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const card = entry as Record<string, unknown>;

    const text = cleanLine(card.text, MAX_INSIGHT_TEXT_CHARS);
    const action = cleanLine(card.action, MAX_ACTION_CHARS);
    const noteIds = Array.isArray(card.note_ids)
      ? [...new Set(card.note_ids.filter((id): id is string => typeof id === "string" && allowedNoteIds.has(id)))]
      : [];
    if (!text || !action || noteIds.length === 0 || seenText.has(text.toLowerCase())) continue;

    const quoted = typeof card.anchor === "string" ? card.anchor : "";
    const found = findAnchor(draft, quoted.slice(0, MAX_ANCHOR_CHARS * 2));
    const span = found && found.end - found.start <= MAX_ANCHOR_CHARS ? found : null;
    if (span && spans.some((taken) => span.start < taken.end && taken.start < span.end)) continue;
    if (span) spans.push(span);
    seenText.add(text.toLowerCase());

    const cardIntent = INSIGHT_INTENTS.includes(card.intent as InsightIntent) ? (card.intent as InsightIntent) : intent;
    insights.push({ anchor: span ? draft.slice(span.start, span.end) : "", intent: cardIntent, text, action, note_ids: noteIds });
  }

  return { insights, goal_suggestions: goalSuggestions, intent: statedIntent, failed: false };
}

/** The response fields for an insight outcome, including the single-insight field older clients read. */
export function insightFields(outcome: InsightOutcome): {
  insights: Insight[]; insight: Insight | null; goal_suggestions: string[]; note_intent: InsightIntent | null; insight_failed: boolean;
} {
  return {
    insights: outcome.insights,
    insight: outcome.insights[0] ?? null,
    goal_suggestions: outcome.goal_suggestions,
    note_intent: outcome.intent,
    insight_failed: outcome.failed,
  };
}

export interface FindInsightOptions {
  draft: string;
  context: GoalContext;
  /** Every note that was searched, so matches and the Domain's recent notes can be looked up. */
  notes: NoteLike[];
  results: RelevanceResult[];
  excludeNoteId: string | null;
  /** Injected so this module stays free of any particular model client. */
  generate: (prompt: string) => Promise<string>;
}

/**
 * The step that replaces the combined summary: one model call over the strong
 * matches. Skipped entirely, at no cost, when nothing matched strongly enough.
 */
export async function findInsight(options: FindInsightOptions): Promise<InsightOutcome> {
  const { draft, context, notes, results, excludeNoteId, generate } = options;
  const matches = selectInsightMatches(results, notes);
  if (!matches.length) return SKIPPED_INSIGHT;
  const prompt = buildInsightPrompt({
    draft,
    context,
    recentNotes: recentDomainNotes(notes, context.domain, excludeNoteId),
    matches,
  });
  return parseInsightResponse(await generate(prompt), {
    draft,
    allowedNoteIds: new Set(matches.map((match) => match.note.id)),
    askForGoal: Boolean(context.domain && !context.goal),
  });
}

/**
 * One line of the newline-delimited JSON stream a caller gets when it asks for
 * progress. "start" and "progress" drive the loading UI; exactly one "done" or
 * "error" ends the stream.
 */
export type RelevanceStreamEvent =
  | { type: "start"; notes_total: number; agents_total: number }
  | { type: "progress"; agents_done: number; agents_total: number; matches: number }
  | {
      type: "done";
      results: RelevanceResult[];
      coverage: { notes_searched: number; notes_total: number; complete: boolean };
      summary?: string;
      /** Present whenever an insight step ran; empty means it found nothing worth saying. */
      insights?: Insight[];
      /** The first insight, for clients from before there could be several. */
      insight?: Insight | null;
      goal_suggestions?: string[];
      /** What the draft is doing, even with no insights; null when the step was skipped or failed. */
      note_intent?: InsightIntent | null;
      /** The insight step errored, as opposed to finding nothing. */
      insight_failed?: boolean;
    }
  | { type: "error"; error: string };

export interface StreamSearchOptions extends Omit<RunAgentsOptions, "onAgentSettled"> {
  maxResults: number;
  /** Optional synthesis of the final matches; failure must not hide the matches. */
  summarize?: (results: RelevanceResult[]) => Promise<string>;
  /** Optional insight from the final matches; like the summary, failure must not hide the matches. */
  findInsight?: (results: RelevanceResult[]) => Promise<InsightOutcome>;
  /** Shown when every agent failed, which would otherwise read as "nothing related". */
  allFailedMessage: string;
  /** Shown when the search throws outright; the error itself goes to onError. */
  failedMessage: string;
  onError?: (error: unknown) => void;
}

/**
 * Runs the same fan-out and merge as the buffered path, but reports each agent
 * as it finishes. Written against web-standard ReadableStream and TextEncoder
 * so the Deno Edge Function and the Node dev route can both return it as is.
 */
export function streamRelevanceSearch(options: StreamSearchOptions): ReadableStream<Uint8Array> {
  const { maxResults, summarize, findInsight, allFailedMessage, failedMessage, onError, ...agentOptions } = options;
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: RelevanceStreamEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      const notesTotal = agentOptions.notes.length;
      const agentsTotal = dealIntoChunks(agentOptions.notes, agentOptions.agentCount).length;
      const matched = new Set<string>();
      let agentsDone = 0;

      send({ type: "start", notes_total: notesTotal, agents_total: agentsTotal });

      try {
        const { outcomes } = await runRelevanceAgents({
          ...agentOptions,
          onAgentSettled: (_index, outcome) => {
            agentsDone++;
            outcome.results?.forEach((result) => matched.add(result.note_id));
            send({ type: "progress", agents_done: agentsDone, agents_total: agentsTotal, matches: matched.size });
          },
        });

        const createdAtById = new Map(agentOptions.notes.map((note) => [note.id, note.created_at]));
        const { results, notesSearched } = mergeAgentResults(outcomes, createdAtById, maxResults);

        if (notesSearched === 0) {
          send({ type: "error", error: allFailedMessage });
        } else {
          // Both follow-ups read the same matches, so run them side by side.
          const [summary, outcome] = await Promise.all([
            results.length && summarize
              ? summarize(results).catch((error) => { onError?.(error); return ""; })
              : Promise.resolve(""),
            findInsight
              ? findInsight(results).catch((error): InsightOutcome => {
                onError?.(error);
                return FAILED_INSIGHT;
              })
              : Promise.resolve(null),
          ]);
          send({
            type: "done",
            results,
            coverage: { notes_searched: notesSearched, notes_total: notesTotal, complete: notesSearched === notesTotal },
            ...(summary ? { summary } : {}),
            ...(outcome ? insightFields(outcome) : {}),
          });
        }
      } catch (error) {
        onError?.(error);
        send({ type: "error", error: failedMessage });
      }
      controller.close();
    },
  });
}
