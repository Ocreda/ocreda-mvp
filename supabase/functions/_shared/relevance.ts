/**
 * Pure logic behind the find-relevant-notes fan-out: chunking, prompt
 * construction, response validation, and merging. Kept free of Deno, Supabase,
 * and network calls so it can be exercised directly by tests.
 */

export const RELATION_TYPES = ["supports", "extends", "contradicts", "question", "parallel", "helps", "solves"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** The levels an agent gives a note, from 1 (shares only words) to 5 (changes what they do next). */
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 5;

/**
 * The lowest level each relation must reach. The prompt states the same
 * minimums and asks the agents to leave weaker notes out; this enforces them
 * in case one does not. Anything under its minimum is dropped, never
 * relabelled as something weaker and shown anyway.
 */
export const RELATION_MIN_LEVEL: Record<RelationType, number> = {
  solves: 4,
  helps: 4,
  supports: 4,
  contradicts: 4,
  question: 4,
  parallel: 4,
  extends: 3,
};

/**
 * Ranking works on a 0-1 value, so a level becomes level / 5: 1.0, 0.8, 0.6.
 * Levels stay 0.2 apart, so the small adjustments made while ranking (variety
 * between relations, a recent problem first) only ever reorder notes of the
 * same level.
 */
export function rankValueOfLevel(level: number): number {
  return level / MAX_LEVEL;
}

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
export const MIN_DRAFT_CHARS = 20;
/**
 * How many related notes the panel lists per idea before "Show more", and how
 * many more each click adds. Display only: the search keeps every match that
 * clears its bar, and the insight call reads all of them.
 */
export const RELATED_NOTES_PAGE_SIZE = 3;
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
  /**
   * Set on a note someone else shared with the person: who shared it. A
   * shared note can inform their draft, but nothing is ever marked on it.
   */
  shared_by?: string | null;
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
  /** The agent's level for the note, 1 to 5. */
  level: number;
  /** The level as a 0-1 ranking value (see rankValueOfLevel). */
  relevance_score: number;
  relation_type: RelationType;
  direction: Direction;
  /** What the note itself says. Empty when the model left it out. */
  gist: string;
  /** How the note bears on the draft. */
  explanation: string;
  /** Exact words copied from the candidate note that support the match. */
  matched_text: string;
  /** The draft section (one of its ideas) the note bears on, or WHOLE_DRAFT. */
  section_id: string;
  /**
   * Set when this note was added because the person marked it as what solved
   * an earlier problem, and that problem note matched the draft: the id of the
   * problem note. See applyCardRules.
   */
  solved_problem_note_id?: string;
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

// ---------------------------------------------------------------- sections

/**
 * What an idea in the draft is doing, which decides what may be offered to it.
 * "situation" - a problem, worry, question, plan, or what happened: it can be
 * given solutions and help. "solution" - a lesson, advice, a quote, a rule, or
 * a fix that worked: it is the answer, so it is never given a solution or help
 * of its own, only earlier problems it answers. "other" - anything else.
 */
export const IDEA_KINDS = ["situation", "solution", "other"] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number];

/**
 * One idea in the draft. Sections are in reading order and do not overlap, and
 * together they hold every non-blank character of the draft, so any passage
 * belongs to exactly one of them. Offsets index into the draft as searched.
 */
export interface DraftSection {
  /** "1", "2", ... in reading order. */
  id: string;
  /** A few words naming the idea. Empty when the draft was split by paragraphs instead. */
  label: string;
  start: number;
  end: number;
  text: string;
  /**
   * What the idea is doing. Given by the call that splits the draft; for a
   * draft that skips that call it is inferred from the matches (see
   * inferIdeaKinds), and missing when there is nothing to infer it from.
   */
  kind?: IdeaKind;
}

/** A match that bears on the draft as a whole rather than on any one idea in it. */
export const WHOLE_DRAFT = "whole";

/**
 * A single paragraph this short is one idea, so the call that splits a draft
 * into ideas is skipped for it. It only saves a call; it never cuts text. Kept
 * low because a paragraph of a few sentences can already change subject.
 */
export const SINGLE_IDEA_CHARS = 300;

/** Trims a span to its non-blank text, or returns null when nothing is left. */
function trimmedSpan(text: string, start: number, end: number): { start: number; end: number } | null {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? { start, end } : null;
}

function toSections(text: string, spans: { start: number; end: number; label: string; kind?: IdeaKind }[]): DraftSection[] {
  const sections: DraftSection[] = [];
  for (const span of spans) {
    const trimmed = trimmedSpan(text, span.start, span.end);
    if (!trimmed) continue;
    sections.push({
      id: String(sections.length + 1),
      label: span.label,
      ...trimmed,
      text: text.slice(trimmed.start, trimmed.end),
      ...(span.kind ? { kind: span.kind } : {}),
    });
  }
  return sections;
}

/** The draft as one section, for a draft with a single idea. */
export function wholeDraftSection(draft: string): DraftSection[] {
  return toSections(draft, [{ start: 0, end: draft.length, label: "" }]);
}

/**
 * Splits at blank lines. The fallback when the model's split cannot be used,
 * and what the app shows before any search has run.
 */
export function splitIntoParagraphs(draft: string): DraftSection[] {
  const spans: { start: number; end: number; label: string }[] = [];
  for (const match of draft.matchAll(/\S(?:[\s\S]*?\S)?(?=\n\s*\n|\s*$)/g)) {
    const start = match.index ?? 0;
    spans.push({ start, end: start + match[0].length, label: "" });
  }
  return toSections(draft, spans);
}

export function buildSectionPrompt(draft: string): string {
  return `Split a note into its separate ideas, so that each idea can be matched against the person's other notes on its own.

An idea is one thing the note works on: a problem, a decision, a plan, a question, an observation, a lesson. A new idea starts where the note moves on to something different. That is usually at a paragraph break, but not always.
- Keep consecutive paragraphs together when they develop the same idea. A problem and the reasons behind it, or a plan and its steps, are one idea.
- Split inside a paragraph only when it clearly changes subject partway through.
- A note about one thing is one idea. That is a normal answer; never split just to have more.

For each idea, in the order they appear:
STARTS_WITH - copy, word for word, the first 6 to 12 words of the idea exactly as they appear in the note. Do not paraphrase, fix typos, or add quotation marks.
LABEL - 2 to 6 plain words naming the idea, such as "Tester pricing feedback".
KIND - what the idea is doing. Pick exactly one:
"situation" - a problem, a worry, a question, a plan, a decision still to make, or something that happened.
"solution" - a lesson, advice, a quote, a principle, a rule, or a fix that worked, with nothing in it left open.
"other" - anything else, such as an observation, a memory, or a note to self.
When an idea mixes a lesson with something still unresolved ("cold emails got nothing, so next I'll try referrals"), it is a "situation".

OUTPUT - a JSON object and nothing else, in this shape:
{"ideas": [{"starts_with": "<exact opening words>", "label": "<a few words>", "kind": "<situation|solution|other>"}]}

========================================

<note>
${draft}
</note>

Now respond with ONLY the JSON object described above.`;
}

const MAX_SECTION_LABEL_CHARS = 60;

/**
 * Turns the model's list of ideas into sections of the draft. Each idea runs
 * from where its opening words are found to where the next idea starts, and
 * the first one also takes anything before it, so no text is ever lost. An
 * idea whose opening words are not in the draft, or are out of order, is
 * folded into the one before it. Null when nothing usable came back.
 */
export function parseSectionResponse(raw: string, draft: string): DraftSection[] | null {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const ideas = parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).ideas)
    ? (parsed as { ideas: unknown[] }).ideas
    : null;
  if (!ideas) return null;

  const starts: { start: number; label: string; kind?: IdeaKind }[] = [];
  let cursor = 0;
  for (const entry of ideas) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const opening = typeof row.starts_with === "string" ? row.starts_with : "";
    // Searching on from the previous idea keeps them in order, even when the
    // same opening words also appear earlier in the note.
    const found = findAnchor(draft.slice(cursor), opening);
    if (!found) continue;
    const start = cursor + found.start;
    if (starts.length && start <= starts[starts.length - 1].start) continue;
    const kind = IDEA_KINDS.includes(row.kind as IdeaKind) ? (row.kind as IdeaKind) : undefined;
    starts.push({ start, label: cleanLine(row.label, MAX_SECTION_LABEL_CHARS), kind });
    cursor = start + 1;
  }
  if (!starts.length) return null;

  const sections = toSections(draft, starts.map((item, index) => ({
    start: index === 0 ? 0 : item.start,
    end: index + 1 < starts.length ? starts[index + 1].start : draft.length,
    label: item.label,
    kind: item.kind,
  })));
  return sections.length ? sections : null;
}

export interface FindSectionsOptions {
  draft: string;
  /** Injected so this module stays free of any particular model client. */
  generate: (prompt: string) => Promise<string>;
  onError?: (error: unknown) => void;
}

/**
 * Splits the draft into its ideas with one model call, before any notes are
 * read. A short single paragraph skips the call. When the call fails or its
 * reply is unusable, paragraphs stand in for ideas: worse boundaries, but
 * every part of the draft still gets searched.
 */
export async function findDraftSections({ draft, generate, onError }: FindSectionsOptions): Promise<DraftSection[]> {
  const paragraphs = splitIntoParagraphs(draft);
  if (paragraphs.length <= 1 && draft.length < SINGLE_IDEA_CHARS) return wholeDraftSection(draft);
  try {
    const sections = parseSectionResponse(await generate(buildSectionPrompt(draft)), draft);
    if (sections) return sections;
    onError?.(new Error("the idea split came back unusable; using paragraphs"));
  } catch (error) {
    onError?.(error);
  }
  return paragraphs.length ? paragraphs : wholeDraftSection(draft);
}

/** The draft as the agents see it: whole, with each idea marked and numbered when there are several. */
function renderDraft(draft: string, sections: DraftSection[]): string {
  if (sections.length <= 1) return draft;
  return sections
    .map((section) => `<idea id="${section.id}"${section.label ? ` label="${section.label.replace(/"/g, "'")}"` : ""}${section.kind ? ` kind="${section.kind}"` : ""}>\n${section.text}\n</idea>`)
    .join("\n\n");
}

/** Which section a draft offset falls in, or null when it is outside all of them. */
export function sectionAt(sections: DraftSection[], offset: number): DraftSection | null {
  return sections.find((section) => offset >= section.start && offset < section.end) ?? null;
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
 * variable too, so it sits beside the draft; only its instructions are fixed,
 * and so are the instructions about ideas, whether or not the draft has several.
 */
/** The line that marks a note someone else wrote and shared with the person. */
function sharedByLine(note: NoteLike): string {
  return note.shared_by ? `\nShared by: ${truncate(note.shared_by.replace(/\s+/g, " ").trim(), 80)}` : "";
}

export function buildPrompt(draft: string, notes: NoteLike[], goal: string | null = null, sections: DraftSection[] = []): string {
  const candidates = notes
    .map((note) => `ID: ${note.id}${sharedByLine(note)}\n${truncate((note.summary || note.raw_text).trim(), MAX_NOTE_CHARS)}`)
    .join("\n\n---\n\n");
  const sharedBlock = notes.some((note) => note.shared_by)
    ? `\n\nSome notes are marked "Shared by": someone else wrote them and shared them with this person. Judge them exactly like the rest, but in their gist and explanation name that person ("Alice found…", "Alice's note…") instead of saying the person did or wrote it.`
    : "";
  const goalBlock = goal
    ? `\n\nWhat they are working toward in this area:\n<goal>\n${goal}\n</goal>`
    : "";

  return `You will be given a draft that someone is writing, followed by a set of notes from their knowledge base. Decide which of those notes are genuinely relevant to the draft, and give each one a level on its own merits.

A draft is not always an argument. It may be a claim, a decision, a plan, a memory, a worry, or a half-formed reflection. Judge relevance against whatever the draft is actually doing, not against whether it makes a provable point.

LEVEL - give each note a level from 1 to 5. Start at 5 and work down; the note's level is the first one that is true. Judge each note against the draft alone, never against the other candidates you were given. If every candidate here is irrelevant, return no results; that is a normal and correct outcome.

Judge the strength of the connection, NOT how similar the subject matter is. A note about something else entirely can reach a high level if the link it reveals is strong and specific.

5 - It changes what they do next. The note holds a specific answer, decision, number, method, or fact that settles what the draft is working out, or shows them something about it they had not seen, and they could act on it as written.
4 - It is usable here. The note gives something specific - a technique, a method, a past attempt and how it went, a concrete fact or example - that applies to the draft's situation exactly as the draft states it.
3 - It is on point but general. The note bears on what the draft is really about, but only in general terms: the same explanation would fit many other drafts (motivation, "keep going", "act instead of thinking", broad principles).
2 - It needs a stretch. The connection only holds if you assume something the draft does not say, such as that something failed, that they are overthinking, or that they feel unqualified.
1 - It shares only words or a topic.

If your explanation needs "if", "might", or "could", or describes a situation the draft does not state, the note is level 2.

MINIMUM LEVEL - return a note only if it reaches the minimum for its relation type: level 4 for solves, helps, supports, contradicts, question, and parallel; level 3 for extends. Leave everything below its minimum out of your response entirely.

What level 4 means for each relation type:
"solves" - a specific fix, method, or answer to the problem the draft raises.
"helps" - a specific technique, method, or past attempt that applies to the draft's situation as stated.
"supports" - a concrete example, piece of evidence, or lived experience of what the draft says, not a restatement of it.
"extends" - a specific detail, consequence, or next step the draft does not have.
"contradicts" - a specific statement that cannot be true alongside the draft, or a position the draft reverses.
"question" - a specific obstacle or open question the draft has not addressed.
"parallel" - a named shared structure (the same tension or pattern) in a different part of their life, not a broad theme.
Level 5 is any of these that would change what they do next. Level 3 is a general version of any of these.

IDEAS - a long draft can work on several separate ideas at once, and each one deserves its own matches. When the draft is marked into numbered <idea> blocks, judge every note against each idea, not only against the draft's main point: a note that speaks to a small idea is as worth returning as one that speaks to the big one. A note must serve what that idea is trying to do, not merely share its topic. Still read the whole draft, because what the person is getting at overall decides what would help each idea.
Give each note the number of the one idea it bears on most, as "idea". Use "whole" when it bears on the draft as a whole and on no single idea more than the others, and whenever the draft is not marked into ideas.

GOAL - you may also be told what the person is working toward in this area. When you are, a note that would help them toward it - a past attempt and how it went, advice they recorded, a decision they made, a fact that changes the picture - deserves a higher level than one that is merely on the same subject. Never include a note only because it matches the goal; it must still bear on the draft.

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
"outbound" - the draft helps the note. Usually the draft is a solution or a lesson (a book quote, an article, a principle, a rule, advice, a technique that worked) and the note describes a situation it applies to: a problem it solves, a question it answers, a plan it changes. Read the relation from that side: "solves" with "outbound" means the draft solves the problem in the note. For an outbound note, the explanation says the draft helps this note ("Your new note is the fix for this"), never that this note helps the draft.
When both could fit, pick the one that better serves what they are working toward. For an outbound note, prefer problems that still look open; skip one that a later note shows was already resolved.
An idea marked kind="solution" is already an answer: never return an inbound "solves" or "helps" note for it, because there is nothing in it to fix. Look for the earlier problems it answers instead.

GIST - exactly one short sentence: what the note actually says, in your own words. These are the person's own notes, so say it back to them in the second person, the way a friend recapping it would: "You noticed...", "You decided...", "You're worried that...". Never call them "the author", "the writer", "the user", or "this person". Anyone else in the note keeps their name ("Maya told you..."). Keep its specifics (names, numbers, decisions). Do not mention the draft here; this must make sense on its own as a summary of the note.

EXPLANATION - one or two short sentences, in plain language, written to the person who wrote the draft: how the note bears on the draft, naming the specific thing in the draft it touches. Do not restate the gist; the reader sees them separately.
Write both the way you would explain it to a friend. Address them as "you" and call the draft "your new note". No jargon, no academic register, and never open with "This note highlights/underscores/demonstrates".
Do the thinking for them: spell the connection out rather than gesturing at it. Never say two things are "both about X" without saying what about X ties them together.

MATCHED TEXT - copy, word for word, the shortest sentence or passage from the candidate note that you actually used to make this match. Do not paraphrase, fix typos, or add quotation marks. Keep it under 45 words.

CRITICAL RULES:
- Many candidate notes will be irrelevant. Returning {"results": []} is correct when nothing connects. Do not pad your response.
- Never include a note merely because it shares words, names, or a broad category with the draft. The connection must be about substance.
- Leave out echoes. A note that says what the draft already says, without adding a fact, example, outcome, consequence, or counterpoint the draft lacks, tells the person nothing new however close the topic is. A note is not an echo if it shows the same thing actually happening, or happening before.
- Only call a note "contradicts" when the two really cannot both be true, or the note records a position the draft reverses. A difference in emphasis is not a contradiction.
- A "parallel" must name the specific shared structure. An abstraction that both notes merely belong to - "both are about time", "both express awe" - is not a parallel. If the same explanation could be written about a dozen other pairs of notes, leave the note out.
- Use the exact ID string as given. Never invent an ID, and never return one that is not listed above.

Worked examples:
- Draft: "From The Mom Test: ask people about what they did in the past, not what they would do in the future." Candidate note: "Tester interviews keep going nowhere - everyone says they'd use it, then nobody does." Level 5, relation_type "solves", direction "outbound", gist: "Your tester interviews keep ending with people saying they'd use it and then never doing.", explanation: "Your new note is the fix for this: those interviews asked what testers would do, which is exactly the question the book says gets you polite yeses.", matched_text: "everyone says they'd use it, then nobody does"
- Draft: "Charging per seat punishes teams for adding people, so we should move to usage-based pricing." Candidate note: "Talked to Maya - she stopped adding teammates to the tool because each one cost another $12/mo." Level 5, relation_type "supports", gist: "You talked to Maya, a customer, who stopped adding teammates to the tool because each extra seat cost another $12 a month.", explanation: "That is the exact thing your new note argues, already happening to someone real - the problem with per-seat pricing isn't theoretical, she felt it and acted on it."
- Draft: "I'm always running late, however early I start." Candidate note: "I'm the last one in my friend group to get married. Good things seem to reach me last." Level 4, relation_type "parallel", gist: "You're the last of your friends to get married, and feel like good things tend to reach you last.", explanation: "It's not about punctuality at all, but it's the same shape as your new note - being behind turns up in two different corners of your life, one you cause and one you don't, which is worth sitting with."
- Draft: "I can't decide whether to take the design job or stay freelance." Candidate note: "Never stop believing in yourself." Omitted: level 3, general encouragement that would fit almost any draft, under the minimum of 4 for "helps".
- Draft: the design job one again. Candidate note: "When a launch flops, treat it as data and move on." Omitted: level 2, it only connects if you assume something in the draft failed, and the draft says nothing failed.
- Draft: the pricing one again. Candidate note: "Pricing page redesign - make the CTA green and move testimonials above the fold." Omitted: level 1, it shares the word "pricing" but has nothing to do with the draft's argument.

OUTPUT - a JSON object and nothing else, with one entry in "results" per note that reaches its minimum level, in this shape:
{"results": [{"note_id": "<exact id>", "idea": "<idea number, or whole>", "level": <integer 1-5>, "relation_type": "<solves|helps|supports|extends|contradicts|question|parallel>", "direction": "<inbound|outbound>", "gist": "<one sentence>", "explanation": "<one or two short sentences>", "matched_text": "<exact quote from candidate note>"}]}

========================================

Here is the draft:
<draft>
${renderDraft(draft, sections)}
</draft>${goalBlock}${sharedBlock}

Here are the candidate notes:

${candidates}

Now respond with ONLY the JSON object described above, no prose before or after it.`;
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
 * An agent's list of results, however the model shaped it. Agents are asked
 * for {"results": [...]}, because providers that honour JSON-object mode
 * strictly cannot return a bare array: one sent its single strongest match as
 * a lone object instead, and the rest were lost. A bare array, a lone result,
 * or a list under another key are all still read.
 */
function readAgentResults(raw: string): unknown[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  const parse = (value: string | null | undefined): unknown => {
    if (!value) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };
  const parsed = parse(text) ?? parse(text.match(/\{[\s\S]*\}/)?.[0]) ?? parse(extractJsonArray(text));
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  const row = parsed as Record<string, unknown>;
  if (Array.isArray(row.results)) return row.results;
  if (typeof row.note_id === "string") return [row];
  const list = Object.values(row).find((value) => Array.isArray(value));
  return Array.isArray(list) ? list : [];
}

/**
 * Turns one agent's raw text into trustworthy results. Anything malformed is
 * dropped rather than repaired, and ids are checked against what this agent was
 * actually shown so hallucinated UUIDs cannot reach the user. With a single
 * section every match is about it; otherwise an idea the draft does not have
 * means the note is taken as bearing on the draft as a whole.
 */
/** A match an agent returned under its relation's minimum level, kept only for measuring. */
export interface BelowBarMatch {
  note_id: string;
  relation_type: RelationType;
  level: number;
}

export function parseAgentResponse(
  raw: string,
  allowedIds: Set<string>,
  sectionIds: string[] = [],
  /** Receives the matches dropped for scoring under their relation's bar. */
  belowBar?: BelowBarMatch[],
): RelevanceResult[] {
  const sectionOf = (value: unknown): string => {
    if (sectionIds.length <= 1) return sectionIds[0] ?? WHOLE_DRAFT;
    const id = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
    return sectionIds.includes(id) ? id : WHOLE_DRAFT;
  };
  const parsed = readAgentResults(raw);

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

    const rawLevel = Number(row.level);
    if (!Number.isFinite(rawLevel)) continue;
    const level = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(rawLevel)));
    if (level < RELATION_MIN_LEVEL[relationType]) {
      belowBar?.push({ note_id: noteId, relation_type: relationType, level });
      continue;
    }

    const explanation = typeof row.explanation === "string" ? row.explanation.trim() : "";
    if (!explanation) continue;
    // A missing gist is not worth losing a relevant note over; the UI just
    // won't offer the summary side for it.
    const gist = typeof row.gist === "string" ? row.gist.trim() : "";
    const matchedText = typeof row.matched_text === "string" ? row.matched_text.trim() : "";

    seen.add(noteId);
    results.push({
      note_id: noteId,
      level,
      relevance_score: rankValueOfLevel(level),
      relation_type: relationType,
      // Most matches bring something to the draft, so that is the safe default.
      direction: DIRECTIONS.includes(row.direction as Direction) ? (row.direction as Direction) : "inbound",
      gist: truncate(gist, MAX_GIST_CHARS),
      explanation: truncate(explanation, MAX_EXPLANATION_CHARS),
      matched_text: truncate(matchedText, 500),
      section_id: sectionOf(row.idea),
    });
  }

  return results;
}

export interface AgentOutcome {
  chunkSize: number;
  /** null when the agent failed both attempts, so its notes went unread. */
  results: RelevanceResult[] | null;
  /** What the agent returned under the bars, for the search funnel. */
  belowBar?: BelowBarMatch[];
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
  /** The draft's ideas. Every agent sees the same ones, so their matches can be grouped. */
  sections?: DraftSection[];
  agentCount: number;
  concurrency: number;
  /** Injected so this module stays free of any particular model client. The signal is the search's own. */
  generate: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /** Decides whether a thrown error is worth a second attempt. */
  isRetryable: (error: unknown) => boolean;
  onAgentSettled?: (index: number, outcome: AgentOutcome) => void;
  /** Cancels the search: no agent starts or retries after it fires. */
  signal?: AbortSignal;
}

/** Thrown once a cancelled search reaches its next step. */
export class SearchCancelledError extends Error {
  constructor() {
    super("The search was cancelled.");
    this.name = "SearchCancelledError";
  }
}

function stopIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SearchCancelledError();
}

/**
 * Fans the corpus out across agents and collects their verdicts. An agent that
 * fails both attempts yields a null result rather than throwing, so one bad
 * chunk degrades coverage instead of failing the whole search.
 */
export async function runRelevanceAgents(
  options: RunAgentsOptions
): Promise<{ chunks: NoteLike[][]; outcomes: AgentOutcome[] }> {
  const { draft, notes, goal, sections = [], agentCount, concurrency, generate, isRetryable, onAgentSettled, signal } = options;
  const chunks = dealIntoChunks(notes, agentCount);
  const sectionIds = sections.map((section) => section.id);

  const settled = await runWithConcurrency(chunks, concurrency, async (chunk, index) => {
    const prompt = buildPrompt(draft, chunk, goal ?? null, sections);
    const allowedIds = new Set(chunk.map((n) => n.id));
    // Reported the moment this agent finishes rather than after all of them, so
    // a caller can show progress while the rest are still running. Called
    // outside the try below, so a throwing callback is never mistaken for a
    // model failure and retried.
    const settle = (results: RelevanceResult[] | null, belowBar: BelowBarMatch[] = []) =>
      onAgentSettled?.(index, { chunkSize: chunk.length, results, belowBar });

    for (let attempt = 0; ; attempt++) {
      let results: RelevanceResult[];
      const belowBar: BelowBarMatch[] = [];
      try {
        stopIfCancelled(signal);
        results = parseAgentResponse(await generate(prompt, signal), allowedIds, sectionIds, belowBar);
      } catch (error) {
        if (attempt === 1 || signal?.aborted || !isRetryable(error)) {
          settle(null);
          throw error;
        }
        // Backoff with jitter so the agents don't all retry in lockstep.
        await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 700));
        continue;
      }
      settle(results, belowBar);
      return { results, belowBar };
    }
  });

  const outcomes: AgentOutcome[] = settled.map((outcome, index) => ({
    chunkSize: chunks[index].length,
    results: outcome.status === "fulfilled" ? outcome.value.results : null,
    belowBar: outcome.status === "fulfilled" ? outcome.value.belowBar : [],
  }));

  return { chunks, outcomes };
}

/**
 * Combines the agents' verdicts into one ranked list, and reports how many
 * notes were actually read. A failed agent contributes nothing to the count,
 * which is what lets the UI tell the user coverage was incomplete instead of
 * quietly presenting a partial search as a complete one.
 *
 * Every match that cleared its bar is kept, ordered within each idea with some
 * variety between relations. `maxPerSection` caps each idea only when given;
 * the app gives none.
 */
export function mergeAgentResults(
  outcomes: AgentOutcome[],
  createdAtById: Map<string, string>,
  maxPerSection = Infinity,
  now: number = Date.now(),
): { results: RelevanceResult[]; notesSearched: number; cutByCap: RelevanceResult[] } {
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
  const bySection = new Map<string, RelevanceResult[]>();
  for (const result of ranked) bySection.set(result.section_id, [...(bySection.get(result.section_id) ?? []), result]);
  const picked = Array.from(bySection.values())
    .flatMap((group) => diversifyByRelation(group, maxPerSection, VARIETY_PENALTY, scoreOf));
  // Within a section the variety order is kept; across sections, strongest first.
  const order = new Map(picked.map((result, index) => [result.note_id, index]));
  const best = new Map<string, number>();
  for (const result of picked) best.set(result.section_id, Math.max(best.get(result.section_id) ?? -Infinity, scoreOf(result)));

  return {
    results: picked.sort((a, b) =>
      a.section_id === b.section_id ? order.get(a.note_id)! - order.get(b.note_id)! : best.get(b.section_id)! - best.get(a.section_id)!),
    notesSearched,
    cutByCap: ranked.filter((result) => !order.has(result.note_id)),
  };
}

/**
 * Where a search's matches went, step by step, so the bars and caps can be
 * tuned from what actually happens rather than guessed at. Holds counts and
 * levels only, never note text, so it is safe to log.
 */
export interface SearchFunnel {
  /** Matches the agents returned, before any bar. */
  returned: number;
  /** Dropped for falling under their relation's minimum level, with each level, by relation. */
  below_bar: Partial<Record<RelationType, number[]>>;
  /** Cleared their bar. */
  passed_bar: number;
  /** Cleared their minimum but lost to stronger matches for the same idea, with each level. Empty unless a cap is set. */
  cut_by_cap: number[];
  /** Shown: cleared the bar and the cap. */
  kept: number;
  /** Cards written; null when the insight step did not run or failed. */
  cards: number | null;
  /** Dropped by applyCardRules, by rule. */
  dropped_by_rules?: CardRulesOutcome["dropped"];
  /** Notes added by applyCardRules because they solved an earlier problem that matched. */
  added_solvers?: number;
}

export function searchFunnel(
  outcomes: AgentOutcome[],
  kept: RelevanceResult[],
  cutByCap: RelevanceResult[],
  insight: InsightOutcome | null,
  rules?: Pick<CardRulesOutcome, "dropped" | "added_solvers">,
): SearchFunnel {
  const below_bar: Partial<Record<RelationType, number[]>> = {};
  let belowCount = 0;
  let passed = 0;
  for (const outcome of outcomes) {
    passed += outcome.results?.length ?? 0;
    for (const miss of outcome.belowBar ?? []) {
      (below_bar[miss.relation_type] ??= []).push(miss.level);
      belowCount++;
    }
  }
  return {
    returned: passed + belowCount,
    below_bar,
    passed_bar: passed,
    cut_by_cap: cutByCap.map((result) => result.level),
    kept: kept.length,
    cards: insight && !insight.failed ? insight.insights.length : null,
    ...(rules ? { dropped_by_rules: rules.dropped, added_solvers: rules.added_solvers } : {}),
  };
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

// ------------------------------------------------------------ card history

/**
 * A problem in one note that the person already settled with another note, by
 * choosing Solved or accepting a Helps card. Read from note_card_decisions.
 */
export interface SettledProblem {
  problem_note_id: string;
  /** The problem's words in that note, when the card recorded them; "" otherwise. */
  problem_text: string;
  /** The note that settled it. */
  by_note_id: string;
  /** The answer or idea they accepted; "" when the card did not record it. */
  answer_text: string;
  choice: "solved" | "helped";
}

/** A card the person waved off: the notes it offered, and the passage it was for. */
export interface TurnedDown {
  /** The note the card was shown on. */
  shown_on_note_id: string;
  note_ids: string[];
  /** The words of that note the card was about; "" when unknown. */
  passage: string;
}

export interface CardHistory {
  settled: SettledProblem[];
  turned_down: TurnedDown[];
}

export const EMPTY_CARD_HISTORY: CardHistory = { settled: [], turned_down: [] };

/** How many past choices a search reads. Newest first, so the oldest go when there are more. */
export const MAX_CARD_HISTORY_ROWS = 2000;
const MAX_PASSAGE_CHARS = 500;

/**
 * Reads note_card_decisions rows (from Supabase, or from the browser in local
 * mode) into what retrieval needs. Each row is { note_id, target_note_id,
 * choice, kind, insight }, where insight is the card as it was when chosen.
 * Anything malformed is skipped.
 */
export function readCardHistory(rows: unknown): CardHistory {
  const history: CardHistory = { settled: [], turned_down: [] };
  if (!Array.isArray(rows)) return history;
  const text = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, MAX_PASSAGE_CHARS) : "");
  const id = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : "");
  const quote = (value: unknown) => {
    const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return { note_id: id(row.note_id), text: text(row.text) };
  };

  for (const entry of rows.slice(0, MAX_CARD_HISTORY_ROWS)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const shownOn = id(row.note_id);
    const insight = row.insight && typeof row.insight === "object" ? (row.insight as Record<string, unknown>) : null;
    if (!shownOn || !insight) continue;
    const noteIds = Array.isArray(insight.note_ids) ? insight.note_ids.map(id).filter(Boolean) : [];
    const anchor = text(insight.anchor);
    const outbound = insight.direction === "outbound";
    const answer = quote(insight.answer);
    const problem = quote(insight.problem);
    const quotes = Array.isArray(insight.quotes) ? insight.quotes.map(quote) : [];
    const add = (problemNoteId: string, problemText: string, byNoteId: string, answerText: string, choice: SettledProblem["choice"]) => {
      if (problemNoteId && byNoteId && problemNoteId !== byNoteId) {
        history.settled.push({ problem_note_id: problemNoteId, problem_text: problemText, by_note_id: byNoteId, answer_text: answerText, choice });
      }
    };

    if (row.choice === "solved") {
      // Outbound: the note the card was on answered an earlier note's problem.
      if (outbound) add(id(row.target_note_id) || problem.note_id, problem.text, shownOn, answer.text, "solved");
      // Inbound: an earlier note answered the problem in the note the card was on.
      else add(shownOn, anchor, answer.note_id || noteIds[0] || "", answer.text, "solved");
    } else if (row.choice === "helped") {
      const idea = text(insight.action);
      if (outbound) {
        for (const problemNoteId of noteIds) {
          add(problemNoteId, quotes.find((item) => item.note_id === problemNoteId)?.text ?? "", shownOn, idea, "helped");
        }
      } else {
        add(shownOn, anchor, noteIds[0] ?? "", idea, "helped");
      }
    } else if (row.choice === "rejected" && noteIds.length) {
      history.turned_down.push({ shown_on_note_id: shownOn, note_ids: noteIds, passage: anchor });
    }
  }
  return history;
}

/** Which paragraph of `text` a passage is in, or null when it cannot be found there. */
function paragraphOf(text: string, passage: string): number | null {
  if (!passage) return null;
  const span = findAnchor(text, passage);
  if (!span) return null;
  const index = splitIntoParagraphs(text).findIndex((paragraph) => span.start >= paragraph.start && span.start < paragraph.end);
  return index === -1 ? null : index;
}

/**
 * Whether two passages of a note are about the same part of it. Notes are not
 * stored split by idea, so a paragraph stands in for one. When either passage
 * cannot be placed, they are taken to be the same, so a settled problem is
 * never offered again just because a quote was copied loosely.
 */
function samePart(text: string, a: string, b: string): boolean {
  const first = paragraphOf(text, a);
  const second = paragraphOf(text, b);
  return first === null || second === null || first === second;
}

/**
 * Fills in the kind of any idea the split did not label: a draft short enough
 * to skip the split, or one split by paragraphs after the call failed. The
 * agents already said which way each match points, so an idea whose solves and
 * helps matches mostly point outbound (the draft answers those notes) is a
 * solution. A tie, or no such matches, says nothing, and the kind stays unset.
 */
export function inferIdeaKinds(sections: DraftSection[], results: RelevanceResult[]): DraftSection[] {
  return sections.map((section) => {
    if (section.kind) return section;
    const helping = results.filter((result) =>
      (result.section_id === section.id || (sections.length === 1 && result.section_id === WHOLE_DRAFT))
      && (result.relation_type === "solves" || result.relation_type === "helps"));
    const outbound = helping.filter((result) => result.direction === "outbound").length;
    const inbound = helping.length - outbound;
    if (outbound === inbound) return section;
    return { ...section, kind: outbound > inbound ? "solution" : "situation" };
  });
}

/** Whether a match's section is a solution. A match on the whole draft is, only when every idea is one. */
export function isSolutionSection(sections: DraftSection[], sectionId: string): boolean {
  if (sectionId === WHOLE_DRAFT) return sections.length > 0 && sections.every((section) => section.kind === "solution");
  return sections.find((section) => section.id === sectionId)?.kind === "solution";
}

/** Relations that mean an earlier note is facing the same problem as the draft, rather than a similar shape elsewhere. */
const SAME_PROBLEM_RELATIONS: RelationType[] = ["solves", "helps", "supports", "extends", "question"];

export interface CardRulesInput {
  draft: string;
  results: RelevanceResult[];
  sections: DraftSection[];
  notes: NoteLike[];
  history: CardHistory;
  /** The saved note the draft is, when it is one. Its own past choices apply to it. */
  draftNoteId: string | null;
}

export interface CardRulesOutcome {
  results: RelevanceResult[];
  /** The sections, with any kind the split left out inferred. */
  sections: DraftSection[];
  dropped: { help_for_solution: number; already_settled: number; turned_down: number; onto_shared: number };
  /** Notes added because they solved an earlier problem that matched. */
  added_solvers: number;
}

/**
 * Rules applied to the merged matches before any card is written:
 *
 * 1. A solution gets no solutions. In an idea that is itself a solution or a
 *    lesson, inbound "solves" and "helps" matches are dropped: there is
 *    nothing in it to fix. Its outbound matches (earlier problems it answers)
 *    stay.
 * 2. One solution per situation. An outbound "solves" or "helps" match is
 *    dropped when the person already settled that part of the earlier note
 *    with a different note. A solution note itself can still be offered to
 *    any number of problems.
 * 3. Turned-down notes stay down. A note the person rejected on a card shown
 *    on this same note is not offered again for the same idea. Rejections on
 *    other notes are left to the insight call, which is told about them.
 * 4. Solved before. When a match is an earlier note facing the same problem,
 *    and the person marked another note as what solved it, that solving note
 *    is added right after it, so the card can say they solved this before.
 * 5. Shared notes are never the target. An outbound match says the draft
 *    helps or answers an earlier note, and acting on it marks that note. A
 *    note someone else shared is theirs, so those matches are dropped; shared
 *    notes only ever inform the draft (docs/shared-note-vaults-plan.md).
 */
export function applyCardRules({ draft, results, sections: given, notes, history, draftNoteId }: CardRulesInput): CardRulesOutcome {
  const sections = inferIdeaKinds(given, results);
  const textById = new Map(notes.map((note) => [note.id, note.raw_text]));
  const sharedIds = new Set(notes.filter((note) => note.shared_by).map((note) => note.id));
  const dropped = { help_for_solution: 0, already_settled: 0, turned_down: 0, onto_shared: 0 };
  const helping = (result: RelevanceResult) => result.relation_type === "solves" || result.relation_type === "helps";

  // Which section of this draft each rejection on it was about. A passage no
  // longer in the draft says nothing about where, so it covers every section.
  const turnedDownHere = history.turned_down
    .filter((item) => draftNoteId && item.shown_on_note_id === draftNoteId)
    .map((item) => {
      const span = item.passage ? findAnchor(draft, item.passage) : null;
      return { note_ids: item.note_ids, section_id: span ? sectionAt(sections, span.start)?.id ?? null : null };
    });

  const kept = results.filter((result) => {
    if (result.direction === "outbound" && sharedIds.has(result.note_id)) {
      dropped.onto_shared++;
      return false;
    }
    if (result.direction === "inbound" && helping(result) && isSolutionSection(sections, result.section_id)) {
      dropped.help_for_solution++;
      return false;
    }
    if (result.direction === "outbound" && helping(result)) {
      const text = textById.get(result.note_id) ?? "";
      const settled = history.settled.some((item) =>
        item.problem_note_id === result.note_id
        && item.by_note_id !== draftNoteId
        && samePart(text, item.problem_text, result.matched_text));
      if (settled) {
        dropped.already_settled++;
        return false;
      }
    }
    const turnedDown = turnedDownHere.some((item) =>
      item.note_ids.includes(result.note_id)
      && (item.section_id === null || sections.length <= 1 || item.section_id === result.section_id));
    if (turnedDown) {
      dropped.turned_down++;
      return false;
    }
    return true;
  });

  const out: RelevanceResult[] = [];
  const placed = new Set(kept.map((result) => result.note_id));
  let addedSolvers = 0;
  for (const result of kept) {
    out.push(result);
    if (result.direction !== "inbound" || !SAME_PROBLEM_RELATIONS.includes(result.relation_type)) continue;
    if (isSolutionSection(sections, result.section_id)) continue;
    // "You solved this before" is about their own problems only.
    if (sharedIds.has(result.note_id)) continue;
    const text = textById.get(result.note_id) ?? "";
    const solved = history.settled.find((item) =>
      item.choice === "solved"
      && item.problem_note_id === result.note_id
      && item.by_note_id !== draftNoteId
      && textById.has(item.by_note_id)
      && samePart(text, item.problem_text, result.matched_text));
    if (!solved) continue;
    const problemNote = notes.find((note) => note.id === result.note_id);
    const title = problemNote ? (splitNoteTitle(problemNote.raw_text).title || (problemNote.summary ?? "").trim()) : "";
    const explanation = `You had this same problem before${title ? ` in "${truncate(title, 80)}"` : ""}, and marked this note as what solved it.`;
    if (placed.has(solved.by_note_id)) {
      // Already a match: say why it matters, without moving it.
      const index = out.findIndex((item) => item.note_id === solved.by_note_id);
      const existing = index === -1 ? kept.find((item) => item.note_id === solved.by_note_id) : out[index];
      if (existing && !existing.solved_problem_note_id) {
        const marked = { ...existing, solved_problem_note_id: result.note_id };
        if (index === -1) kept[kept.indexOf(existing)] = marked;
        else out[index] = marked;
      }
      continue;
    }
    placed.add(solved.by_note_id);
    addedSolvers++;
    out.push({
      note_id: solved.by_note_id,
      level: result.level,
      relevance_score: result.relevance_score,
      relation_type: "solves",
      direction: "inbound",
      gist: "",
      explanation,
      matched_text: solved.answer_text,
      section_id: result.section_id,
      solved_problem_note_id: result.note_id,
    });
  }

  return { results: out, sections, dropped, added_solvers: addedSolvers };
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
 * What a card offers, which decides its action:
 * "solution" - a past note holds a clear, specific answer; Solved or Dismiss.
 * "helps" - a past note suggests an idea worth trying; accept or reject.
 * "extension" - a past note holds a detail that completes this one; merge it.
 * "contradiction" - this note goes against an earlier decision; pick which stands.
 * "pattern" - the same thing has shown up before; confirm or reject.
 */
export const CARD_KINDS = ["solution", "helps", "extension", "contradiction", "pattern"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/** Words copied exactly from one of the person's past notes. */
export interface InsightQuote {
  note_id: string;
  /** Taken from the note itself, not from the model, so it is exactly what they wrote. */
  text: string;
}

/**
 * One past note's part in a card: a few words naming the role it plays, and a
 * sentence or two built around its own words saying what they found there and
 * why it came back for the note being written (decided Nov 26, from the
 * cofounder's card design).
 */
export interface InsightEvidence {
  note_id: string;
  /** A few plain words naming the note's part, such as "What got you out last time". */
  heading: string;
  /** Written around quotes: {1}, {2}, ... stand for the card's `quotes`, as in its `text`. */
  text: string;
}

/**
 * The one thing from the person's past notes that should change what they do
 * next, tied to the passage of the draft it is about. The model writes only the
 * sentence that connects; everything taken from their notes is their own words.
 */
export interface Insight {
  /** Verbatim text from the draft. Empty when the model's quote was not found in it. */
  anchor: string;
  intent: InsightIntent;
  kind: CardKind;
  /**
   * One sentence written around the person's own words: {1}, {2}, ... stand
   * for `quotes` in order, and are shown as quotes that open their note.
   */
  text: string;
  quotes: InsightQuote[];
  /**
   * For a solution or an extension: the answer or the detail, word for word.
   * It comes from a past note, except for an outbound solution, where the note
   * being written is the answer: then it is from the draft and `note_id` is "".
   */
  answer: InsightQuote | null;
  /**
   * "outbound" when every note the card rests on is one the draft helps, so the
   * draft is the lesson and those notes are where it applies.
   */
  direction: Direction;
  /** For an outbound solution: the earlier note's problem, word for word, which the draft answers. */
  problem: InsightQuote | null;
  /**
   * For a solution: one sentence in the model's own words saying what to do
   * about the problem, so the card reads as an answer to it rather than as a
   * line lifted from another note (decided Nov 24). It is the conclusion of
   * every note the card rests on, not a rewording of one answer (decided
   * Nov 26). The past notes' own words stay in `answer`, the quotes and
   * `evidence`. Empty when the model gave none, and then the card shows the
   * answer itself.
   */
  solution: string;
  /** Each cited note's part in the card, in the order given. Empty when the model gave none. */
  evidence: InsightEvidence[];
  /**
   * What the action box shows: the answer's text for a solution or an
   * extension, the idea for helps (it completes "Might help to ..."), the
   * pattern for a pattern, and nothing for a contradiction.
   */
  action: string;
  /** The notes the insight rests on; always a subset of the search results. */
  note_ids: string[];
  /** The draft section the insight is about: where its passage is, else where its notes point. */
  section_id: string;
}

export interface InsightOutcome {
  /**
   * Each about a different passage of the draft: up to MAX_INSIGHTS for a
   * draft with one idea, one per idea (and one for the whole) otherwise. Empty
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

/**
 * For a draft with a single idea: one trigger per issue it raises, but never a
 * margin full of them. A draft with several ideas gets one per idea instead.
 */
export const MAX_INSIGHTS = 3;
export const MAX_DOMAIN_CONTEXT_NOTES = 10;
const MAX_CONTEXT_NOTE_CHARS = 200;
const MAX_ANCHOR_CHARS = 240;
const MIN_ANCHOR_CHARS = 8;
const MAX_INSIGHT_TEXT_CHARS = 420;
/** A quote inside the card's sentence is a phrase, not a paragraph. */
const MAX_QUOTE_CHARS = 150;
/** An answer or an extension is the sentence or two that make the point, never a whole note. */
const MAX_ANSWER_CHARS = 250;
/**
 * A quote that takes in this much of a note's text is the note, not the part
 * that matters. Notes shorter than WHOLE_NOTE_MIN_CHARS are exempt: a
 * one-sentence note can only be quoted whole.
 */
const WHOLE_NOTE_SHARE = 0.8;
const WHOLE_NOTE_MIN_CHARS = 160;

/** How many words of a note make its title when the person gave it none. */
export const DEFAULT_TITLE_WORDS = 5;
/** Longer than this, a first line is the start of the note, not a title someone typed. */
const MAX_TITLE_WORDS = 12;
const MAX_TITLE_CHARS = 90;

function titleWords(text: string): string[] {
  return text
    .replace(/^[\s>]*(?:#{1,6}|[-*+•]|\d+\.)[ \t]+/gm, "")
    .replace(/[*_`~]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The title a note gets when the person gave it none: its first five words,
 * with "..." when the note goes on past them.
 */
export function defaultNoteTitle(text: string): string {
  const words = titleWords(text);
  if (words.length <= DEFAULT_TITLE_WORDS) return words.join(" ");
  return `${words.slice(0, DEFAULT_TITLE_WORDS).join(" ").replace(/[\s,.;:!?…\-–—]+$/, "")}...`;
}

/** Lowercased words only, to tell when a title is just the start of the text. */
function titleKey(text: string): string {
  return titleWords(text).join(" ").toLowerCase().replace(/(?:\.\.\.|…)$/, "").replace(/[^\p{L}\p{N} ]+/gu, "");
}

/**
 * A note's title and body. The first line is the title, as the app stores it,
 * unless it is plainly not one, which is how notes saved without a title look:
 * - the whole note is one long line, so the title would be the entire note;
 * - the first line is a sentence or paragraph, far longer than a title;
 * - the first line is just the start of the body, as an older import wrote it.
 * Then the title is the note's first five words and the body is all its text,
 * so nothing reads as if it were written in the title. `written` is false for
 * a title made this way.
 */
export function readNoteTitle(rawText: string): { title: string; body: string; written: boolean } {
  const text = rawText.trim();
  if (!text) return { title: "", body: "", written: false };
  const newline = text.indexOf("\n");
  const first = (newline === -1 ? text : text.slice(0, newline)).trim();
  const rest = newline === -1 ? "" : text.slice(newline + 1).trim();
  const isHeading = /^#{1,6}\s+\S/.test(first);
  const words = titleWords(first).length;
  if (!rest) {
    return isHeading || words <= DEFAULT_TITLE_WORDS
      ? { title: first, body: "", written: true }
      : { title: defaultNoteTitle(text), body: text, written: false };
  }
  if (!isHeading && (words > MAX_TITLE_WORDS || first.length > MAX_TITLE_CHARS)) {
    return { title: defaultNoteTitle(text), body: text, written: false };
  }
  // A title that only repeats how the body starts was made for the note, not by
  // its writer: a whole first sentence, or five words and "...". A short title
  // someone typed can share the body's first word or two, so that alone is not enough.
  const key = titleKey(first);
  const madeUp = words > DEFAULT_TITLE_WORDS || /(?:\.\.\.|…)$/.test(first);
  if (key && madeUp && titleKey(rest).startsWith(key)) return { title: defaultNoteTitle(rest), body: rest, written: false };
  return { title: first, body: rest, written: true };
}

/**
 * A note's title and its text. The title is a label, never something to
 * quote; a note with no title of its own is all text.
 */
export function splitNoteTitle(rawText: string): { title: string; text: string } {
  const { title, body, written } = readNoteTitle(rawText);
  if (!body) return { title: "", text: title };
  return { title: written ? title : "", text: body };
}
const MAX_IDEA_CHARS = 160;
const MAX_SOLUTION_CHARS = 220;
const MAX_EVIDENCE_HEADING_CHARS = 60;
const MAX_EVIDENCE_TEXT_CHARS = 420;
const MAX_PATTERN_CHARS = 260;
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

/**
 * Every match, in rank order, that an insight may draw on. Each already
 * cleared its relation's bar, so none is held back here: the insight call
 * decides which, if any, are worth a card.
 */
export function selectInsightMatches(results: RelevanceResult[], notes: NoteLike[]): InsightMatch[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  return results
    .filter((result) => byId.has(result.note_id))
    .map((result) => ({ note: byId.get(result.note_id)!, result }));
}

/** How many insights a draft may get: one per idea, plus one about it as a whole. */
export function maxInsightsFor(sections: DraftSection[]): number {
  return sections.length > 1 ? sections.length + 1 : MAX_INSIGHTS;
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
  /** The draft's ideas; with more than one, insights are given per idea. */
  sections?: DraftSection[];
  /** Cards the person waved off before; each related note lists the ones that offered it. */
  turnedDown?: TurnedDown[];
}

/** How many past rejections a related note lists, newest first. */
const MAX_TURNED_DOWN_PER_NOTE = 3;
const MAX_TURNED_DOWN_PASSAGE_CHARS = 160;

export function buildInsightPrompt({ draft, context, recentNotes, matches, sections = [], turnedDown = [] }: InsightPromptInput): string {
  const askForGoal = Boolean(context.domain && !context.goal);
  const byIdea = sections.length > 1;
  const recent = recentNotes.length
    ? recentNotes
      .map((note) => `- ${note.created_at.slice(0, 10)}: ${truncate((note.summary || note.raw_text).trim().replace(/\s+/g, " "), MAX_CONTEXT_NOTE_CHARS)}`)
      .join("\n")
    : "(none)";
  const ideaLine = (result: RelevanceResult) => {
    if (!byIdea) return "";
    const section = sections.find((item) => item.id === result.section_id);
    return `\nIdea: ${section ? `${section.id}${section.label ? ` (${section.label})` : ""}` : "the note as a whole"}`;
  };
  const writtenOn = new Map(matches.map(({ note }) => [note.id, note.created_at.slice(0, 10)]));
  const solvedBeforeLine = (result: RelevanceResult) => {
    if (!result.solved_problem_note_id) return "";
    const when = writtenOn.get(result.solved_problem_note_id);
    return `\nSolved before: they marked this note as what solved their problem in note ${result.solved_problem_note_id}${when ? ` (written ${when})` : ""}.`;
  };
  const turnedDownLines = (noteId: string) => turnedDown
    .filter((item) => item.passage && item.note_ids.includes(noteId))
    .slice(0, MAX_TURNED_DOWN_PER_NOTE)
    .map((item) => `\nTurned down before: as a suggestion for "${truncate(item.passage.replace(/\s+/g, " "), MAX_TURNED_DOWN_PASSAGE_CHARS)}"`)
    .join("");
  // The title is shown as a label apart from the text, since quotes may only
  // come from the text.
  const related = matches
    .map(({ note, result }) => {
      const { title, text } = splitNoteTitle(note.raw_text);
      return `ID: ${note.id}\nTitle: ${title || "(none)"}\nWritten: ${note.created_at.slice(0, 10)}${note.shared_by ? `\nWritten by: ${truncate(note.shared_by.replace(/\s+/g, " ").trim(), 80)} (someone else, who shared this note with them)` : ""}${ideaLine(result)}\nDirection: ${result.direction === "outbound" ? "outbound (the note being written helps this one)" : "inbound (this note helps the one being written)"}\nHow it relates: ${result.relation_type} - ${result.explanation}${solvedBeforeLine(result)}${turnedDownLines(note.id)}\nText:\n${truncate(text, MAX_NOTE_CHARS)}`;
    })
    .join("\n\n---\n\n");
  const solutionIdeas = sections.filter((section) => section.kind === "solution");
  const solutionLine = !solutionIdeas.length
    ? "(none)"
    : byIdea
      ? `ideas ${solutionIdeas.map((section) => section.id).join(", ")}`
      : "the whole note";
  const howMany = byIdea
    ? `HOW MANY - the note works on ${sections.length} separate ideas, marked as numbered <idea> blocks, and each related note says which idea it bears on. Give at most one insight per idea, built on that idea's related notes, plus at most one about the note as a whole. Skip any idea where nothing clears the bar; an idea with no insight is a normal, frequent, and correct outcome. Do not stretch to cover every idea.`
    : `HOW MANY - a note can raise several separate issues. Give one insight per issue that clears the bar, at most ${MAX_INSIGHTS}, strongest first. Each must be about a different passage of the note, and must not repeat another insight's point. One insight is often right, and an empty list is a normal, frequent, and correct answer. Do not stretch to fill the slots.`;

  const sharedNames = Array.from(new Set(matches.map(({ note }) => note.shared_by?.trim()).filter((name): name is string => Boolean(name))));
  const sharedRule = sharedNames.length
    ? `
SOMEONE ELSE'S NOTES - a related note with "Written by" was written by that person (${sharedNames.join(", ")}) and shared with them; every other note is their own. Quote it word for word like any note, but never present it as theirs: no "you wrote", "you said", "your note", "you solved this before", "you changed your mind". Name the person instead: "Alice's note says {1}", "Alice found that {1}". A contradiction with someone else's note is a difference of view, not a change of mind: "Alice sees it differently: {1}". A card can rest on both their own notes and someone else's; say whose each quote is.
`
    : "";
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

${howMany}

THEIR WORDS, NOT YOURS - a card is their own past words, connected by you. You write only the short sentence that links those words to the note; everything taken from a past note appears inside it exactly as they wrote it, so the card sounds familiar. The one exception is a solution's SOLUTION line, below.
${sharedRule}
For each insight:
KIND - pick exactly one, by what the past notes actually offer:
"solution" - a past note holds a clear, specific answer to a question or problem in the note being written: a number, a name, a decision, a fix. Whenever such an answer exists, give this card; it is the most valuable one, so never water it down to "helps".
"helps" - a past note suggests an idea that might be useful here, such as a strategy or a technique, but not a specific answer.
"extension" - a past note holds a fact or detail that makes the note being written more complete.
"contradiction" - the note being written goes against a decision or belief they wrote down before. Point out the change; do not judge it.
"pattern" - the same thing has happened or shown up before, and the note being written is another instance of it.
ANCHOR - copy, word for word, the key part of the sentence in the note being written that needs this card, at most 25 words${byIdea ? ", taken from inside the idea it is about" : ""}: the words that ask the question, state the problem, or make the claim. Copy it exactly: do not paraphrase, fix typos, or add quotation marks. Two insights never share or overlap an anchor.
TEXT - one short sentence, written by you, with their past words placed inside it as {1}, {2}, ... in the order of QUOTES. Write only the connecting words; the quotes carry the content. Say where or with whom it was if that helps them place it, but never write a date or a day: the card already shows when each note was written. Never put your own paraphrase in quotation marks, and never restate the note being written. Examples: "Your weekend test got {1}, with {2}." / "The same manager told you they {1}. That's a turnover problem too, and you had {2}."
QUOTES - one entry per placeholder used in TEXT or EVIDENCE, numbered in the order of first use: the ID of the past note and the exact words copied from its Text, 3 to 15 words: only the phrase that carries the point, not the sentence around it. Copy them character for character; never shorten them in the middle, fix them, or reword them. Never quote a Title, and never quote a whole note: the card names the note for them, so a quote only needs the part that matters.
ANSWER - for "solution" and "extension" only: the exact words from a past note's Text that answer the question or add the detail, copied word for word, with the ID of that note. Take only what answers it, usually one sentence and at most 40 words, never the Title and never the whole note. For a solution this is the answer itself and nothing else.
SOLUTION - required on every "solution" card, and only there: one sentence in your own plain words saying what to do about the problem. It is the card's headline, the first thing they read, so it is the conclusion that all the past notes this card rests on add up to, not a rewording of one of them. When more than one related note speaks to the same problem (a time it worked, a lesson, advice they recorded, what happened when they waited), rest the card on all of them and draw them together into one answer; when only one note speaks to it, one is fine. It must make sense as the answer to that problem on its own: name their situation and the step to take ("In your next tester calls, ask what they actually did last week instead of whether they would use it."). For an outbound solution, it says what to do about the earlier note's problem. This is the one line you write in your own words: do not copy ANSWER, do not put anything in quotation marks, and add nothing the past notes do not support.
IDEA -for "helps" only: a short phrase, in plain words, that completes "Might help to ...", starting with a lowercase verb, such as "say the price and just wait".
PATTERN - for "pattern" only: one or two short sentences naming what repeats, such as "Both times, price was what they said. Trust was what they asked about."
NOTE_IDS - the IDs of the past notes this insight rests on, only from the list given.
EVIDENCE - one entry per past note in NOTE_IDS, in the order they matter, showing what each one brings and why it came back now:
  HEADING - 2 to 6 plain words naming the part this note plays in the card, as a reader would put it, such as "What got you out last time" or "What actually gave you answers". Not the note's title, no quotation marks, no date.
  TEXT - one or two short sentences, written by you, with that note's own words placed inside as {1}, {2}, ... from QUOTES (add to QUOTES any words you need from it; the same numbering as the card's TEXT). Say what they found or did there, then why it came back: the part of the new note it answers ("It came back because your new note ..."). Never write a date or a day. Same voice as TEXT.
Leave out EVIDENCE for a past note you cannot quote.
OUTBOUND - when the notes an insight rests on are outbound, the note being written is the lesson and the past note is where it applies. TEXT places that earlier situation with its own words and says the note being written is what helps it, so it can never read as advice for the note being written ("Your new note is the fix for when you were stuck on {1}.").
- When the note being written answers a problem or open question in that past note, give "solution", and as clearly as any other solution: PROBLEM is the exact words from the past note's Text that state the problem, with its ID, and ANSWER is the exact words from the note being written that answer it, with "note_id": "this". ANCHOR is the key part of that answer.
- Otherwise use "helps" or "pattern", never "extension": IDEA says what that earlier situation could do with this lesson, such as "test your hypotheses by watching what people do in the product".

SOLUTIONS GET NO SOLUTIONS - a part of the note that is itself a solution or lesson (listed below as "Already a solution") is the answer. Never give it a "solution" or "helps" card built on inbound notes: there is nothing in it to fix. For that part, look only for earlier problems it answers (outbound).
SOLVED BEFORE - a related note marked "Solved before" is the one they already chose as the answer to that same problem in an earlier note. When the note being written faces that same problem again, give a "solution" card that says they solved this before: TEXT places the earlier problem with its own words from the problem note, and ANSWER is the answer from the note marked "Solved before". Example TEXT: "You solved this before, when you were stuck on {1}."
TURNED DOWN - a related note marked "Turned down before" was offered to them for that passage and they said no. Do not build a card on it for the same problem again; use it only for something clearly different.
${askForGoal ? `
GOAL_SUGGESTIONS - they have not said what this area is for. Offer 2 or 3 short guesses at it, 2 to 6 words each and starting with a verb ("Validate pricing", "Find first 10 users"), based on the note and their recent notes in the area. Include these even when there are no insights.
` : ""}
VOICE - these are their own notes. Speak to them as "you", and when you mention the note being written, call it "your new note", like a friend who remembers everything they have written. Plain words, no jargon. Never say "the user", "the author", or "this note highlights".

OUTPUT - a JSON object and nothing else, in this shape:
{"intent": "<stuck|planning|deciding|capturing|reflecting|learning>", "insights": [{"kind": "<solution|helps|extension|contradiction|pattern>", "anchor": "<exact words from the note being written>", "text": "<one sentence with {1}, {2}...>", "quotes": [{"note_id": "<id>", "text": "<exact words from that note>"}], "answer": {"note_id": "<id, or this>", "text": "<exact words>"}, "problem": {"note_id": "<id>", "text": "<exact words>"}, "solution": "<solution only, your own words>", "idea": "<helps only>", "pattern": "<pattern only>", "note_ids": ["<id>"], "evidence": [{"note_id": "<id>", "heading": "<a few words>", "text": "<one or two sentences with {1}, {2}...>"}]}]${askForGoal ? ', "goal_suggestions": ["<guess>"]' : ""}}
Leave out "answer", "problem", "solution", "idea", and "pattern" where they do not apply; a "solution" card always has both "answer" and "solution". "insights" is [] when nothing clears the bar.

========================================

Area: ${context.domain ?? "(none)"}
What they are working toward in this area: ${context.goal ?? "(not stated)"}
Already a solution: ${solutionLine}

Their most recent notes in this area:
${recent}

The note they are writing:
<note>
${renderDraft(draft, sections)}
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

/** Where a card falls back to when the model names no kind: the relation of the note it rests on. */
const KIND_FOR_RELATION: Record<RelationType, CardKind> = {
  solves: "solution",
  helps: "helps",
  question: "helps",
  extends: "extension",
  supports: "extension",
  contradicts: "contradiction",
  parallel: "pattern",
};

/**
 * Turns the insight model's reply into something safe to show. Every quote,
 * and every answer, must really be in the past note it names; the text shown
 * is then taken from that note, so a small slip in the model's copy (case,
 * curly quotes, spacing) never reaches the person. A card whose sentence uses
 * a quote that is not really there is dropped rather than shown with words
 * the person never wrote, and so is one missing what its kind needs: an answer
 * for a solution or an extension, an idea for helps, a pattern for a pattern.
 * A passage that is not actually in the draft only loses its highlight, since
 * the card is still worth showing. An insight whose passage overlaps an
 * earlier one is about the same issue, so it is dropped.
 *
 * Each insight belongs to the section its passage is in. Without a passage it
 * goes where the notes it cites point, and failing that to the first section.
 */
export function parseInsightResponse(
  raw: string,
  { draft, allowedNoteIds, askForGoal, sections = [], sectionOfNote = new Map(), noteTextById = new Map(), relationOfNote = new Map(), directionOfNote = new Map() }: {
    draft: string;
    allowedNoteIds: Set<string>;
    askForGoal: boolean;
    sections?: DraftSection[];
    /** Which section each cited note was matched to. */
    sectionOfNote?: Map<string, string>;
    /** The text of every note a card may quote, without its title, to check quotes against. */
    noteTextById?: Map<string, string>;
    /** Each cited note's relation, for a card that names no kind. */
    relationOfNote?: Map<string, RelationType>;
    /** Each cited note's direction, to tell when the draft is the lesson. */
    directionOfNote?: Map<string, Direction>;
  },
): InsightOutcome {
  /** Words copied from the draft itself, for the answer of an outbound solution. "" marks the draft. */
  const draftQuote = (value: unknown): InsightQuote | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const words = (value as Record<string, unknown>).text;
    if (typeof words !== "string") return null;
    const span = findAnchor(draft, words.slice(0, MAX_ANSWER_CHARS * 2));
    return span && span.end - span.start <= MAX_ANSWER_CHARS ? { note_id: "", text: draft.slice(span.start, span.end) } : null;
  };
  const maxInsights = maxInsightsFor(sections);
  const quoteFrom = (value: unknown, limit: number): InsightQuote | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const noteId = typeof row.note_id === "string" ? row.note_id : "";
    const source = allowedNoteIds.has(noteId) ? noteTextById.get(noteId) : undefined;
    if (!source || typeof row.text !== "string") return null;
    const span = findAnchor(source, row.text.slice(0, limit * 2));
    if (!span || span.end - span.start > limit) return null;
    // The card names the note already; quoting all of it buries the point.
    const wholeNote = source.length >= WHOLE_NOTE_MIN_CHARS && span.end - span.start >= source.length * WHOLE_NOTE_SHARE;
    return wholeNote ? null : { note_id: noteId, text: source.slice(span.start, span.end) };
  };
  const sectionIds = new Set(sections.map((section) => section.id));
  const sectionFor = (span: { start: number } | null, noteIds: string[]): string =>
    (span && sectionAt(sections, span.start)?.id)
    || noteIds.map((id) => sectionOfNote.get(id)).find((id): id is string => Boolean(id && sectionIds.has(id)))
    || sections[0]?.id
    || WHOLE_DRAFT;
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
    if (insights.length >= maxInsights) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const card = entry as Record<string, unknown>;

    // The sentence keeps only placeholders whose quote is really in its note,
    // renumbered in the order they are used.
    const offered = Array.isArray(card.quotes) ? card.quotes.map((item) => quoteFrom(item, MAX_QUOTE_CHARS)) : [];
    const quotes: InsightQuote[] = [];
    const renumbered = new Map<number, number>();
    /** A sentence with its placeholders renumbered into `quotes`; null when one names a quote that is not really there. */
    const withQuotes = (value: unknown, limit: number): string | null => {
      let quoteMissing = false;
      const used: number[] = [];
      const cleaned = cleanLine(value, limit)
        // The interface draws the quotation marks, so drop any the model added.
        .replace(/["'‘’“”]?(\{\d+\})["'‘’“”]?/g, "$1");
      cleaned.replace(/\{(\d+)\}/g, (_match, digits: string) => {
        const index = Number(digits) - 1;
        if (!offered[index]) quoteMissing = true;
        else used.push(index);
        return "";
      });
      if (quoteMissing) return null;
      for (const index of used) {
        if (!renumbered.has(index)) { quotes.push(offered[index] as InsightQuote); renumbered.set(index, quotes.length); }
      }
      return cleaned.replace(/\{(\d+)\}/g, (_match, digits: string) => `{${renumbered.get(Number(digits) - 1)}}`);
    };
    const text = withQuotes(card.text, MAX_INSIGHT_TEXT_CHARS);
    if (!text || quotes.length === 0 || seenText.has(text.toLowerCase())) continue;

    const listedIds = Array.isArray(card.note_ids)
      ? card.note_ids.filter((id): id is string => typeof id === "string" && allowedNoteIds.has(id))
      : [];
    const answerQuote = quoteFrom(card.answer, MAX_ANSWER_CHARS);
    const problemQuote = quoteFrom(card.problem, MAX_ANSWER_CHARS);
    const noteIds = [...new Set([
      ...listedIds,
      ...quotes.map((quote) => quote.note_id),
      ...(answerQuote ? [answerQuote.note_id] : []),
      ...(problemQuote ? [problemQuote.note_id] : []),
    ])];
    const direction: Direction = noteIds.length > 0 && noteIds.every((id) => directionOfNote.get(id) === "outbound") ? "outbound" : "inbound";
    const fallbackKind = noteIds.map((id) => relationOfNote.get(id)).find(Boolean);
    const kind: CardKind | null = CARD_KINDS.includes(card.kind as CardKind)
      ? (card.kind as CardKind)
      : fallbackKind ? KIND_FOR_RELATION[fallbackKind] : null;
    if (!kind || (direction === "outbound" && kind === "extension")) continue;

    // An outbound solution has two sides: the earlier note's problem, and the
    // words of the draft that answer it. Both must really be there.
    const outboundSolution = kind === "solution" && direction === "outbound";
    const problem = outboundSolution ? problemQuote : null;
    const answer = outboundSolution
      ? draftQuote(card.answer)
      : kind === "solution" || kind === "extension" ? answerQuote : null;
    if (outboundSolution && !problem) continue;
    const idea = kind === "helps"
      ? cleanLine(card.idea, MAX_IDEA_CHARS).replace(/^might help(?: to)?[\s:.…-]*/i, "").replace(/^([A-Z])(?![A-Z])/, (letter) => letter.toLowerCase())
      : "";
    const pattern = kind === "pattern" ? cleanLine(card.pattern, MAX_PATTERN_CHARS) : "";
    // The interface draws no quotation marks around it; drop any the model added.
    const solution = kind === "solution" ? cleanLine(card.solution, MAX_SOLUTION_CHARS).replace(/^["'‘’“”]+|["'‘’“”]+$/g, "").trim() : "";
    const action = answer?.text ?? (idea || pattern);
    if (kind !== "contradiction" && !action) continue;
    // One entry per cited note, each with at least one of its own words that
    // are really there; an entry that misquotes is dropped, not the card.
    const evidence: InsightEvidence[] = [];
    for (const item of Array.isArray(card.evidence) ? card.evidence : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const noteId = typeof row.note_id === "string" ? row.note_id : "";
      if (!noteIds.includes(noteId) || evidence.some((entry) => entry.note_id === noteId)) continue;
      const heading = cleanLine(row.heading, MAX_EVIDENCE_HEADING_CHARS).replace(/^["'‘’“”]+|["'‘’“”:.]+$/g, "").trim();
      const line = withQuotes(row.text, MAX_EVIDENCE_TEXT_CHARS);
      if (!heading || !line || !/\{\d+\}/.test(line)) continue;
      evidence.push({ note_id: noteId, heading, text: line });
    }

    const quoted = typeof card.anchor === "string" ? card.anchor : "";
    const found = findAnchor(draft, quoted.slice(0, MAX_ANCHOR_CHARS * 2));
    const span = found && found.end - found.start <= MAX_ANCHOR_CHARS ? found : null;
    if (span && spans.some((taken) => span.start < taken.end && taken.start < span.end)) continue;
    const sectionId = sectionFor(span, noteIds);
    // A part of the draft that is itself a solution is never handed one.
    if (direction === "inbound" && (kind === "solution" || kind === "helps") && isSolutionSection(sections, sectionId)) continue;
    if (span) spans.push(span);
    seenText.add(text.toLowerCase());

    const cardIntent = INSIGHT_INTENTS.includes(card.intent as InsightIntent) ? (card.intent as InsightIntent) : intent;
    insights.push({
      anchor: span ? draft.slice(span.start, span.end) : "",
      intent: cardIntent,
      kind,
      text,
      quotes,
      answer,
      direction,
      problem,
      solution,
      evidence,
      action,
      note_ids: noteIds,
      section_id: sectionId,
    });
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
  /** The draft's ideas, as the search used them. */
  sections?: DraftSection[];
  /** The person's past choices on cards; rejections are passed on to the prompt. */
  history?: CardHistory;
  /** Injected so this module stays free of any particular model client. */
  generate: (prompt: string) => Promise<string>;
}

/**
 * The step that replaces the combined summary: one model call over the strong
 * matches of every idea at once, since an insight can draw on notes that
 * different agents found. Skipped entirely, at no cost, when nothing matched
 * strongly enough.
 */
export async function findInsight(options: FindInsightOptions): Promise<InsightOutcome> {
  const { draft, context, notes, results, excludeNoteId, sections = [], history = EMPTY_CARD_HISTORY, generate } = options;
  const matches = selectInsightMatches(results, notes);
  if (!matches.length) return SKIPPED_INSIGHT;
  const prompt = buildInsightPrompt({
    draft,
    context,
    recentNotes: recentDomainNotes(notes, context.domain, excludeNoteId),
    matches,
    sections,
    // Rejections on this same note were already applied as a filter.
    turnedDown: history.turned_down.filter((item) => item.shown_on_note_id !== excludeNoteId),
  });
  return parseInsightResponse(await generate(prompt), {
    draft,
    allowedNoteIds: new Set(matches.map((match) => match.note.id)),
    askForGoal: Boolean(context.domain && !context.goal),
    sections,
    sectionOfNote: new Map(matches.map((match) => [match.note.id, match.result.section_id])),
    // Only a note's text can be quoted, never its title.
    noteTextById: new Map(matches.map((match) => [match.note.id, splitNoteTitle(match.note.raw_text).text])),
    relationOfNote: new Map(matches.map((match) => [match.note.id, match.result.relation_type])),
    directionOfNote: new Map(matches.map((match) => [match.note.id, match.result.direction])),
  });
}


export interface SearchOptions extends Omit<RunAgentsOptions, "sections"> {
  /** Caps the matches each idea keeps. The app sets none, so every match that clears its bar is kept. */
  maxPerSection?: number;
  /** Splits the draft into its ideas before any notes are read. Without it the draft is one section. */
  findSections?: (draft: string, signal?: AbortSignal) => Promise<DraftSection[]>;
  /** Optional synthesis of the final matches; failure must not hide the matches. */
  summarize?: (results: RelevanceResult[], signal?: AbortSignal) => Promise<string>;
  /** Optional insights from the final matches; like the summary, failure must not hide the matches. */
  findInsight?: (results: RelevanceResult[], sections: DraftSection[], signal?: AbortSignal) => Promise<InsightOutcome>;
  /** Failures of the optional steps, which the search itself survives. */
  onError?: (error: unknown) => void;
  /** Where the matches went, once the search finishes. */
  onFunnel?: (funnel: SearchFunnel) => void;
  /** The person's past choices on cards, for applyCardRules. */
  history?: CardHistory;
  /** The saved note being searched from, when it is one. */
  draftNoteId?: string | null;
}

export interface SearchOutcome {
  sections: DraftSection[];
  results: RelevanceResult[];
  notesSearched: number;
  notesTotal: number;
  summary: string;
  /** Null when no insight step was given, or when every agent failed. */
  insight: InsightOutcome | null;
}

/**
 * The whole search: split the draft into its ideas, read every note once
 * against all of them, keep each idea's best matches, then write insights over
 * all of them in one call. The vault is read once however many ideas the draft
 * has. When every agent fails the follow-up steps are skipped, and the caller
 * sees notesSearched === 0.
 *
 * When `signal` fires, typically because the person left the note, the search
 * stops before its next model call and throws SearchCancelledError: no agents
 * after the split, no retries, and no insight call after the agents.
 */
export async function searchRelevance(options: SearchOptions): Promise<SearchOutcome> {
  const { maxPerSection, findSections, summarize, findInsight, onError, onFunnel, history = EMPTY_CARD_HISTORY, draftNoteId = null, ...agentOptions } = options;
  const { draft, notes, signal } = agentOptions;
  stopIfCancelled(signal);
  const splitSections = findSections
    ? await findSections(draft, signal).catch((error) => {
      if (!signal?.aborted) onError?.(error);
      return splitIntoParagraphs(draft);
    })
    : wholeDraftSection(draft);

  stopIfCancelled(signal);
  const { outcomes } = await runRelevanceAgents({ ...agentOptions, sections: splitSections });
  stopIfCancelled(signal);
  const createdAtById = new Map(notes.map((note) => [note.id, note.created_at]));
  const merged = mergeAgentResults(outcomes, createdAtById, maxPerSection);
  const { notesSearched, cutByCap } = merged;
  const ruled = applyCardRules({ draft, results: merged.results, sections: splitSections, notes, history, draftNoteId });
  const { results, sections } = ruled;
  const base = { sections, results, notesSearched, notesTotal: notes.length };
  if (notesSearched === 0) return { ...base, summary: "", insight: null };

  // Both follow-ups read the same matches, so run them side by side.
  const [summary, insight] = await Promise.all([
    results.length && summarize
      ? summarize(results, signal).catch((error) => { onError?.(error); return ""; })
      : Promise.resolve(""),
    findInsight
      ? findInsight(results, sections, signal).catch((error): InsightOutcome => {
        onError?.(error);
        return FAILED_INSIGHT;
      })
      : Promise.resolve(null),
  ]);
  stopIfCancelled(signal);
  try { onFunnel?.(searchFunnel(outcomes, results, cutByCap, insight, ruled)); } catch { /* measuring never breaks a search */ }
  return { ...base, summary, insight };
}

/** The body of a finished search, shared by the streamed "done" event and the plain JSON response. */
export function searchResponseFields(outcome: SearchOutcome) {
  return {
    results: outcome.results,
    sections: outcome.sections,
    coverage: {
      notes_searched: outcome.notesSearched,
      notes_total: outcome.notesTotal,
      complete: outcome.notesSearched === outcome.notesTotal,
    },
    ...(outcome.summary ? { summary: outcome.summary } : {}),
    ...(outcome.insight ? insightFields(outcome.insight) : {}),
  };
}

/**
 * One line of the newline-delimited JSON stream a caller gets when it asks for
 * progress. "start" and "progress" drive the loading UI; exactly one "done" or
 * "error" ends the stream.
 */
export type RelevanceStreamEvent =
  | { type: "start"; notes_total: number; agents_total: number }
  | { type: "progress"; agents_done: number; agents_total: number; matches: number }
  | ({ type: "done" } & ReturnType<typeof searchResponseFields>)
  | { type: "error"; error: string };

export interface StreamSearchOptions extends Omit<SearchOptions, "onAgentSettled"> {
  /** Shown when every agent failed, which would otherwise read as "nothing related". */
  allFailedMessage: string;
  /** Shown when the search throws outright; the error itself goes to onError. */
  failedMessage: string;
  /** Told when the search stopped early because the reader went away, and how far it had got. */
  onCancelled?: (stage: string) => void;
  /** Told exactly once how the search ended, after its last model call, e.g. to record what it cost. */
  onSettled?: (outcome: "done" | "failed" | "cancelled") => void;
}

/**
 * Runs the same search as the buffered path, but reports each agent as it
 * finishes. Written against web-standard ReadableStream and TextEncoder so the
 * Deno Edge Function and the Node dev route can both return it as is.
 *
 * The search is cancelled when the reader goes away (the stream is cancelled)
 * or when the caller's own `signal` fires, so a person who leaves the note
 * stops paying for the rest of it.
 */
export function streamRelevanceSearch(options: StreamSearchOptions): ReadableStream<Uint8Array> {
  const { allFailedMessage, failedMessage, onCancelled, onSettled, signal: callerSignal, ...searchOptions } = options;
  const encoder = new TextEncoder();
  const cancel = new AbortController();
  if (callerSignal?.aborted) cancel.abort();
  else callerSignal?.addEventListener("abort", () => cancel.abort(), { once: true });

  return new ReadableStream<Uint8Array>({
    cancel() {
      cancel.abort();
    },
    async start(controller) {
      // Once the reader is gone there is no one left to tell.
      const send = (event: RelevanceStreamEvent) => {
        if (cancel.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          cancel.abort();
        }
      };

      const notesTotal = searchOptions.notes.length;
      const agentsTotal = dealIntoChunks(searchOptions.notes, searchOptions.agentCount).length;
      const matched = new Set<string>();
      let agentsDone = 0;

      send({ type: "start", notes_total: notesTotal, agents_total: agentsTotal });

      let settled: "done" | "failed" | "cancelled" = "done";
      try {
        const outcome = await searchRelevance({
          ...searchOptions,
          signal: cancel.signal,
          onAgentSettled: (_index, agent) => {
            agentsDone++;
            agent.results?.forEach((result) => matched.add(result.note_id));
            send({ type: "progress", agents_done: agentsDone, agents_total: agentsTotal, matches: matched.size });
          },
        });
        if (outcome.notesSearched === 0) {
          settled = "failed";
          send({ type: "error", error: allFailedMessage });
        } else {
          send({ type: "done", ...searchResponseFields(outcome) });
        }
      } catch (error) {
        if (error instanceof SearchCancelledError || cancel.signal.aborted) {
          settled = "cancelled";
          onCancelled?.(agentsDone === 0 ? "before the agents finished" : `after ${agentsDone} of ${agentsTotal} agents`);
        } else {
          settled = "failed";
          searchOptions.onError?.(error);
          send({ type: "error", error: failedMessage });
        }
      }
      try {
        onSettled?.(settled);
      } catch (error) {
        searchOptions.onError?.(error);
      }
      try {
        controller.close();
      } catch {
        // Already closed by the reader cancelling it.
      }
    },
  });
}
