/**
 * Pure logic behind the find-relevant-notes fan-out: chunking, prompt
 * construction, response validation, and merging. Kept free of Deno, Supabase,
 * and network calls so it can be exercised directly by tests.
 */

export const RELATION_TYPES = ["supports", "extends", "contradicts", "question", "parallel"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

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
export const SCORE_FLOOR = 0.5;

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

export interface RelevanceResult {
  note_id: string;
  relevance_score: number;
  relation_type: RelationType;
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
"supports" - the note gives grounds for what the draft says or feels: evidence, an example, a lived experience, or reasoning that makes it sturdier.
"extends" - the note stands on the same ground and carries it further: more detail, a consequence, a next step, or a fuller version of the same thought.
"contradicts" - the note pulls against the draft: it states something incompatible, names a cost the draft ignores, or records a position the draft is reversing.
"question" - the note raises something the draft leaves open: an obstacle, a tension, or a question it brushes past without settling.
"parallel" - the note is about something else entirely, but the same shape shows up in it: the same pattern, tension, or way of seeing, appearing in a different part of the person's life. The link is structural, not topical.

GIST - exactly one short sentence: what the note actually says, in your own words. These are the person's own notes, so say it back to them in the second person, the way a friend recapping it would: "You noticed...", "You decided...", "You're worried that...". Never call them "the author", "the writer", "the user", or "this person". Anyone else in the note keeps their name ("Maya told you..."). Keep its specifics (names, numbers, decisions). Do not mention the draft here; this must make sense on its own as a summary of the note.

EXPLANATION - one or two short sentences, in plain language, written to the person who wrote the draft: how the note bears on the draft, naming the specific thing in the draft it touches. Do not restate the gist; the reader sees them separately.
Write both the way you would explain it to a friend. Address them as "you" and call the draft "your draft". No jargon, no academic register, and never open with "This note highlights/underscores/demonstrates".
Do the thinking for them: spell the connection out rather than gesturing at it. Never say two things are "both about X" without saying what about X ties them together.

CRITICAL RULES:
- Many candidate notes will be irrelevant. Returning [] is correct when nothing connects. Do not pad your response.
- Never include a note merely because it shares words, names, or a broad category with the draft. The connection must be about substance.
- Leave out echoes. A note that says what the draft already says, without adding a fact, example, outcome, consequence, or counterpoint the draft lacks, tells the person nothing new however close the topic is. A note is not an echo if it shows the same thing actually happening, or happening before.
- A "parallel" must name the specific shared structure. An abstraction that both notes merely belong to - "both are about time", "both express awe" - is not a parallel. If the same explanation could be written about a dozen other pairs of notes, leave the note out.
- Use the exact ID string as given. Never invent an ID, and never return one that is not listed above.

Worked examples:
- Draft: "Charging per seat punishes teams for adding people, so we should move to usage-based pricing." Candidate note: "Talked to Maya - she stopped adding teammates to the tool because each one cost another $12/mo." Score 0.94, relation_type "supports", gist: "You talked to Maya, a customer, who stopped adding teammates to the tool because each extra seat cost another $12 a month.", explanation: "That is the exact thing your draft argues, already happening to someone real - the problem with per-seat pricing isn't theoretical, she felt it and acted on it."
- Draft: "I'm always running late, however early I start." Candidate note: "I'm the last one in my friend group to get married. Good things seem to reach me last." Score 0.84, relation_type "parallel", gist: "You're the last of your friends to get married, and feel like good things tend to reach you last.", explanation: "It's not about punctuality at all, but it's the same shape as your draft - being behind turns up in two different corners of your life, one you cause and one you don't, which is worth sitting with."
- Draft: the pricing one again. Candidate note: "Pricing page redesign - make the CTA green and move testimonials above the fold." Omitted entirely: it shares the word "pricing" but has nothing to do with the draft's argument.

OUTPUT - a JSON array and nothing else, in this shape:
[{"note_id": "<exact id>", "relevance_score": <number>, "relation_type": "<supports|extends|contradicts|question|parallel>", "gist": "<one sentence>", "explanation": "<one or two short sentences>"}]

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

    const score = Number(row.relevance_score);
    if (!Number.isFinite(score) || score < SCORE_FLOOR) continue;

    const relationType = RELATION_TYPES.includes(row.relation_type as RelationType)
      ? (row.relation_type as RelationType)
      : "extends";

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
  maxResults: number
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

  const results = Array.from(merged.values())
    .sort(
      (a, b) =>
        b.relevance_score - a.relevance_score ||
        (createdAtById.get(b.note_id) ?? "").localeCompare(createdAtById.get(a.note_id) ?? "")
    )
    .slice(0, maxResults);

  return { results, notesSearched };
}

// ------------------------------------------------------------------ insight

/**
 * What the draft is doing. It shapes which kind of action is useful: a way
 * forward when stuck, a missing consideration when deciding, a follow-up when
 * logging what happened.
 */
export const INSIGHT_INTENTS = ["stuck", "planning", "deciding", "capturing", "reflecting"] as const;
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
  /** null means nothing in the notes would change their next step. */
  insight: Insight | null;
  /** Guesses at the Domain's goal, only when it has none. */
  goal_suggestions: string[];
}

/** Only strong matches are worth building an insight on. */
export const INSIGHT_MIN_SCORE = 0.7;
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
      `ID: ${note.id}\nWritten: ${note.created_at.slice(0, 10)}\nHow it relates: ${result.relation_type} - ${result.explanation}\n${truncate(note.raw_text.trim(), MAX_NOTE_CHARS)}`)
    .join("\n\n---\n\n");

  return `Someone is writing a note. You have the past notes of theirs that relate to it. Decide whether anything in those past notes should change what they do next, and if so, tell them in one short card.

INTENT - first work out what the note is doing. Pick exactly one:
"stuck" - they describe a problem they have not solved.
"planning" - they are laying out what they will do.
"deciding" - they are weighing options, or have just chosen.
"capturing" - they are logging what happened or what someone said.
"reflecting" - they are thinking something through, with no action in view.

WHAT COUNTS AS USEFUL - one of these, taken from their past notes:
- a past attempt at the same thing, and how it went
- advice they recorded from a book, a person, or another source
- a decision or conclusion they reached before, especially one this note contradicts or seems to have forgotten
- a pattern across several notes that this note is another instance of
- a number or fact that changes the picture
A past note that says the same thing as the draft is NOT useful. Reminding someone of what they just wrote is worthless, however on-topic it is.

GOAL - if they have said what they are working toward in this area, use it to decide what helps. If not, infer it from the draft and their recent notes in the area. If you still cannot tell, offer only something that helps whatever the goal is: a contradiction, a repeated pattern, or a hard number.

If nothing clears that bar, set "insight" to null. That is a normal, frequent, and correct answer. Do not stretch.

When something does:
ANCHOR - copy, word for word, the shortest phrase or sentence from the note being written that your insight is about, at most 25 words. Copy it exactly: do not paraphrase, fix typos, or add quotation marks.
TEXT - one or two plain sentences saying what their past notes add. Name the specifics: people, numbers, what happened. Do not restate the note being written.
ACTION - one concrete next step, starting with a verb, that they could do this week. Fit it to the intent: for "stuck", a way forward; for "planning", something to add or check; for "deciding", the consideration they are missing; for "capturing", what to do with this (a follow-up, a question for next time); for "reflecting", a question worth answering. Never generic advice like "keep going" or "reflect on this".
NOTE_IDS - the IDs of the past notes your insight rests on, only from the list given.
${askForGoal ? `
GOAL_SUGGESTIONS - they have not said what this area is for. Offer 2 or 3 short guesses at it, 2 to 6 words each and starting with a verb ("Validate pricing", "Find first 10 users"), based on the note and their recent notes in the area. Include these even when insight is null.
` : ""}
VOICE - these are their own notes. Speak to them as "you", like a friend who remembers everything they have written. Plain words, no jargon. Never say "the user", "the author", or "this note highlights".

OUTPUT - a JSON object and nothing else, in this shape:
{"intent": "<stuck|planning|deciding|capturing|reflecting>", "insight": null${askForGoal ? ', "goal_suggestions": ["<guess>"]' : ""}}
or
{"intent": "<...>", "insight": {"anchor": "<exact quote>", "text": "<one or two sentences>", "action": "<one step>", "note_ids": ["<id>"]}${askForGoal ? ', "goal_suggestions": ["<guess>"]' : ""}}

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
 * highlight, since the card is still worth showing.
 */
export function parseInsightResponse(
  raw: string,
  { draft, allowedNoteIds, askForGoal }: { draft: string; allowedNoteIds: Set<string>; askForGoal: boolean },
): InsightOutcome {
  const empty: InsightOutcome = { insight: null, goal_suggestions: [] };
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const row = parsed as Record<string, unknown>;

  const goalSuggestions = askForGoal && Array.isArray(row.goal_suggestions)
    ? [...new Set(row.goal_suggestions.map((item) => cleanLine(item, MAX_GOAL_SUGGESTION_CHARS)).filter(Boolean))]
      .slice(0, MAX_GOAL_SUGGESTIONS)
    : [];

  const intent = INSIGHT_INTENTS.includes(row.intent as InsightIntent) ? (row.intent as InsightIntent) : "reflecting";
  const card = row.insight && typeof row.insight === "object" && !Array.isArray(row.insight)
    ? (row.insight as Record<string, unknown>)
    : null;
  if (!card) return { insight: null, goal_suggestions: goalSuggestions };

  const text = cleanLine(card.text, MAX_INSIGHT_TEXT_CHARS);
  const action = cleanLine(card.action, MAX_ACTION_CHARS);
  const noteIds = Array.isArray(card.note_ids)
    ? [...new Set(card.note_ids.filter((id): id is string => typeof id === "string" && allowedNoteIds.has(id)))]
    : [];
  if (!text || !action || noteIds.length === 0) return { insight: null, goal_suggestions: goalSuggestions };

  const quoted = typeof card.anchor === "string" ? card.anchor : "";
  const span = findAnchor(draft, quoted.slice(0, MAX_ANCHOR_CHARS * 2));
  const anchor = span && span.end - span.start <= MAX_ANCHOR_CHARS ? draft.slice(span.start, span.end) : "";

  return { insight: { anchor, intent, text, action, note_ids: noteIds }, goal_suggestions: goalSuggestions };
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
  if (!matches.length) return { insight: null, goal_suggestions: [] };
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
      /** Present whenever an insight step ran; null means it found nothing worth saying. */
      insight?: Insight | null;
      goal_suggestions?: string[];
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
                return { insight: null, goal_suggestions: [] };
              })
              : Promise.resolve(null),
          ]);
          send({
            type: "done",
            results,
            coverage: { notes_searched: notesSearched, notes_total: notesTotal, complete: notesSearched === notesTotal },
            ...(summary ? { summary } : {}),
            ...(outcome ? { insight: outcome.insight, goal_suggestions: outcome.goal_suggestions } : {}),
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
