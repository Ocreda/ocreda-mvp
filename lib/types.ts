export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

export interface Note {
  id: string;
  user_id: string;
  raw_text: string;
  summary: string | null;
  target_date: string | null;
  time_of_day: TimeOfDay | null;
  category: string | null;
  category_updated_at: string | null;
  created_at: string;
  /** Part of the sample vault, or written while exploring it. */
  is_sample?: boolean;
}

export interface NoteImportInput {
  rawText: string;
  category: string;
}

export interface Question {
  id: string;
  user_id: string;
  question: string;
  answer: string | null;
  relevant_note_ids: string[];
  created_at: string;
}

export interface ConversationMessage {
  id: string;
  question_id: string;
  user_id: string;
  role: 'user' | 'assistant';
  content: string;
  relevant_note_ids: string[];
  created_at: string;
}

/**
 * How a related note stands in relation to the draft it was matched against.
 * "parallel" is the one that is not topical: the same pattern or way of seeing
 * turning up somewhere else in the person's life.
 */
export type NoteRelationType = 'supports' | 'extends' | 'contradicts' | 'question' | 'parallel' | 'helps' | 'solves';

/**
 * Which way help flows. "inbound": the related note helps the one being read.
 * "outbound": the note being read (a lesson or solution) helps the related
 * one, usually an earlier problem it applies to.
 */
export type NoteDirection = 'inbound' | 'outbound';

export interface RelevanceResult {
  note_id: string;
  relevance_score: number;
  /** Null when semantic retrieval has not classified the relationship. */
  relation_type: NoteRelationType | null;
  /** Missing from similarity-only results, which do not judge direction. */
  direction?: NoteDirection;
  /** One-sentence summary of the note itself. Empty when the model omitted it. */
  gist: string;
  /** How the note bears on the draft. */
  explanation: string;
  /** Exact words from the related note that the retrieval decision relied on. */
  matched_text?: string;
  /** Which of the draft's sections the note bears on, or "whole". Missing from similarity-only results. */
  section_id?: string;
}

/**
 * One idea in the searched text, as the server split it. Sections are in
 * reading order, do not overlap, and offsets index into the searched text.
 */
export interface RelevanceSection {
  id: string;
  /** A few words naming the idea; empty when the text was split by paragraphs. */
  label: string;
  start: number;
  end: number;
  text: string;
}

/**
 * How much of the note corpus actually got searched. When an agent fails both
 * of its attempts its notes go unread, and the user is told rather than being
 * shown a silently incomplete result.
 */
export interface RelevanceCoverage {
  notes_searched: number;
  notes_total: number;
  complete: boolean;
}

/** Live progress of a relevance search, reported as each reader finishes. */
export interface RelevanceProgress {
  agents_done: number;
  agents_total: number;
  /** Distinct notes scored relevant so far, before the final cap. */
  matches: number;
  notes_total: number;
}

/** What the note being written is doing; it decides which kind of action helps. */
export type InsightIntent = 'stuck' | 'planning' | 'deciding' | 'capturing' | 'reflecting' | 'learning';

/** The one thing from past notes that should change what the person does next. */
/** What a card offers, which decides its action. Matches CARD_KINDS on the server. */
export type CardKind = 'solution' | 'helps' | 'extension' | 'contradiction' | 'pattern';

/** Words copied exactly from one of the person's past notes. */
export interface InsightQuote {
  note_id: string;
  text: string;
}

export interface NoteInsight {
  /** Verbatim passage of the searched text the insight is about. Empty when none could be matched. */
  anchor: string;
  intent: InsightIntent;
  /** Missing from servers that predate card kinds; the card then goes by its notes' relation. */
  kind?: CardKind;
  /** One sentence; {1}, {2}, ... stand for `quotes` in order. Older servers send plain text. */
  text: string;
  /** The person's own words that fill the sentence's placeholders. */
  quotes?: InsightQuote[];
  /**
   * For a solution or an extension: the answer or detail, word for word. An
   * empty note_id means the words are from the searched note itself, as for
   * an outbound solution.
   */
  answer?: InsightQuote | null;
  /** "outbound" when the searched note is the lesson and the cited notes are where it applies. */
  direction?: NoteDirection;
  /** For an outbound solution: the earlier note's problem, word for word. */
  problem?: InsightQuote | null;
  /** The answer's text, the idea for helps, the pattern for a pattern; empty for a contradiction. */
  action: string;
  /** The notes the insight rests on, all of them among the results. */
  note_ids: string[];
  /** The section the insight is about. Missing from servers that predate sections. */
  section_id?: string;
}

/** How a card shows. Pattern cards show as "insight". */
export type SuggestionKind = 'contradiction' | 'solution' | 'helps' | 'extension' | 'insight';

/**
 * What the person did with a card. A choice is drawn over the note, never
 * written into its text, so the note always stays exactly as they wrote it.
 */
export type CardChoice =
  /** Solution: the answer shows in a box beside the sentence. */
  | 'solved'
  /** Solution dismissed: the card carries on as a Helps card, and nothing is added. */
  | 'downgraded'
  /** Helps: the idea shows in a box beside the sentence. */
  | 'helped'
  /** Extension: their words from the other note show below the sentence. */
  | 'merged'
  /** Contradiction: what they wrote today stands. */
  | 'today'
  /** Contradiction: the earlier note still holds. */
  | 'earlier'
  /** Contradiction: both are true. */
  | 'both'
  /** Pattern: confirmed. */
  | 'confirmed'
  /** Any card they waved off. */
  | 'rejected';

export interface CardDecision {
  choice: CardChoice;
  /** The kind the card shows as now; a dismissed solution becomes a Helps card. */
  kind: SuggestionKind;
  /** The card as it was when they chose, so their choice stays on the note after a new search. */
  insight: NoteInsight;
  /** The merged words, which are theirs to edit, or why both are true. */
  text?: string;
  /** Another note this choice also marks, such as the earlier note an answer solved. */
  targetNoteId?: string;
}

/** A choice made on another note's card that marks this note. */
export interface IncomingCardDecision extends CardDecision {
  cardId: string;
  /** The note the card was on, which is where the answer came from. */
  fromNoteId: string;
}

/** The Domain a search is made from, and what the person said they want from it. */
export interface DomainGoal {
  name: string;
  goal: string;
}

export interface RelevantNotesResponse {
  results: RelevanceResult[];
  coverage: RelevanceCoverage;
  /** The searched text's ideas. Missing from similarity search and from servers that predate sections. */
  sections?: RelevanceSection[];
  /** A short synthesis of the related notes as a group, when the server has it switched on. */
  summary?: string;
  /**
   * Each about a different passage: up to three for a single idea, one per
   * idea otherwise. Undefined when the server
   * ran no insight step (similar-notes mode, or an older server); empty when
   * it ran and found nothing worth saying.
   */
  insights?: NoteInsight[];
  /** Guesses at the Domain's goal, offered only when it has none. */
  goal_suggestions?: string[];
  /** What the note is doing, even when there are no insights. Null when the step was skipped or failed. */
  note_intent?: InsightIntent | null;
  /** The insight step errored, as opposed to finding nothing worth saying. */
  insight_failed?: boolean;
}
