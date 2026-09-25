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
export type NoteRelationType = 'supports' | 'extends' | 'contradicts' | 'question' | 'parallel';

export interface RelevanceResult {
  note_id: string;
  relevance_score: number;
  /** Null when semantic retrieval has not classified the relationship. */
  relation_type: NoteRelationType | null;
  /** One-sentence summary of the note itself. Empty when the model omitted it. */
  gist: string;
  /** How the note bears on the draft. */
  explanation: string;
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

export interface RelevantNotesResponse {
  results: RelevanceResult[];
  coverage: RelevanceCoverage;
  /** A short synthesis of the related notes as a group, when available. */
  summary?: string;
}
