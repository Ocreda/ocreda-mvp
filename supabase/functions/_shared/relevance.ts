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
 * content first would give the calls nothing in common to cache.
 */
export function buildPrompt(draft: string, notes: NoteLike[]): string {
  const candidates = notes
    .map((note) => `ID: ${note.id}\n${truncate((note.summary || note.raw_text).trim(), MAX_NOTE_CHARS)}`)
    .join("\n\n---\n\n");

  return `You will be given a draft that someone is writing, followed by a set of notes from their knowledge base. Decide which of those notes are genuinely relevant to the draft, and score each one on its own merits.

A draft is not always an argument. It may be a claim, a decision, a plan, a memory, a worry, or a half-formed reflection. Judge relevance against whatever the draft is actually doing, not against whether it makes a provable point.

SCORING - judge each note against the draft in absolute terms. Do NOT score a note relative to the other candidates you were given. If every candidate here is irrelevant, return an empty array; that is a normal and correct outcome.

Score the strength of the connection, NOT how similar the subject matter is. A note about something else entirely can score high if the link it reveals is strong and specific.

0.90-1.00 - Reading this note would change what the user writes next. It speaks straight to what the draft is working out, or shows them something about it they had not seen.
0.70-0.89 - A clear, specific connection that adds something real: evidence, a concrete example, a counterweight, an unresolved snag, or a pattern the draft turns out to be an instance of.
0.50-0.69 - A real but looser connection: it shares the draft's underlying concern or stance and is worth having nearby, without changing anything.
Below 0.50 - Leave it out of your response entirely.

RELATION TYPE - pick exactly one:
"supports" (shown as "Helps") - the note does not give a definitive answer, but contains a concrete observation or possibility that might help the person decide what to try. Suggest the useful possibility; never order the person to do it.
"extends" (shown as "Extension") - the note is on the same subject and supplies information the draft lacks. Use the smallest, safest addition that can continue the thought. State the missing information itself; never turn it into an instruction or tell the person what to do.
"contradicts" - the note pulls against the draft: it states something incompatible, names a cost the draft ignores, or records a position the draft is reversing.
"question" (shown as "Solution") - the draft contains an open question or unresolved problem and the note supplies a clear answer to it. Do not use this type merely because a note raises another question.
"parallel" (shown as "Insight") - the note belongs to an unrelated domain, but the same specific structure appears in both notes. Explain the shared structure without prescribing an action.

GIST - exactly one short sentence: what the note actually says, in your own words. These are the person's own notes, so say it back to them in the second person, the way a friend recapping it would: "You noticed...", "You decided...", "You're worried that...". Never call them "the author", "the writer", "the user", or "this person". Anyone else in the note keeps their name ("Maya told you..."). Keep its specifics (names, numbers, decisions). Do not mention the draft here; this must make sense on its own as a summary of the note.

EXPLANATION - one or two short sentences, in plain language, written to the person who wrote the draft: how the note bears on the draft, naming the specific thing in the draft it touches. Do not restate the gist; the reader sees them separately.
Write both the way you would explain it to a friend. Address them as "you" and call the draft "your draft". No jargon, no academic register, and never open with "This note highlights/underscores/demonstrates".
Do the thinking for them: spell the connection out rather than gesturing at it. Never say two things are "both about X" without saying what about X ties them together.
For Helps, Extensions, and Insights, describe the possibility, missing information, or shared structure without imperatives such as "do", "try", "practice", "use", or "incorporate". Ocreda surfaces the connection; the person decides what to do.

CRITICAL RULES:
- Many candidate notes will be irrelevant. Returning [] is correct when nothing connects. Do not pad your response.
- Never include a note merely because it shares words, names, or a broad category with the draft. The connection must be about substance.
- A "parallel" must name the specific shared structure. An abstraction that both notes merely belong to - "both are about time", "both express awe" - is not a parallel. If the same explanation could be written about a dozen other pairs of notes, leave the note out.
- An "extends" result must be about the same subject and add information the draft is missing. A merely adjacent idea is not an extension.
- A "question" result must actually answer an unresolved question in the draft. If it only offers something potentially useful, classify it as "supports" instead.
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
</draft>

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
  const { draft, notes, agentCount, concurrency, generate, isRetryable, onAgentSettled } = options;
  const chunks = dealIntoChunks(notes, agentCount);

  const settled = await runWithConcurrency(chunks, concurrency, async (chunk, index) => {
    const prompt = buildPrompt(draft, chunk);
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
    }
  | { type: "error"; error: string };

export interface StreamSearchOptions extends Omit<RunAgentsOptions, "onAgentSettled"> {
  maxResults: number;
  /** Optional synthesis of the final matches; failure must not hide the matches. */
  summarize?: (results: RelevanceResult[]) => Promise<string>;
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
  const { maxResults, summarize, allFailedMessage, failedMessage, onError, ...agentOptions } = options;
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
          const summary = results.length && summarize
            ? await summarize(results).catch((error) => { onError?.(error); return ""; })
            : "";
          send({
            type: "done",
            results,
            coverage: { notes_searched: notesSearched, notes_total: notesTotal, complete: notesSearched === notesTotal },
            ...(summary ? { summary } : {}),
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
