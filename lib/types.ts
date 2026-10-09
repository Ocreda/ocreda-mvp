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
export interface NoteInsight {
  /** Verbatim passage of the searched text the insight is about. Empty when none could be matched. */
  anchor: string;
  intent: InsightIntent;
  text: string;
  action: string;
  /** The notes the insight rests on, all of them among the results. */
  note_ids: string[];
  /** The section the insight is about. Missing from servers that predate sections. */
  section_id?: string;
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
