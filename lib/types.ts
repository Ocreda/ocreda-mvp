export interface Note {
  id: string;
  user_id: string;
  title: string;
  content: string;
  tags: string[];
  image_url?: string | null;
  image_description?: string | null;
  embedding?: number[];
  category?: string | null;
  category_updated_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteConnection {
  id: string;
  note_id_a: string;
  note_id_b: string;
  similarity_score: number;
  created_at: string;
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

export interface MatchedNote {
  id: string;
  title: string;
  content: string;
  tags: string[];
  similarity: number;
}

export interface NoteMemoryStrength {
  id: string;
  user_id: string;
  note_id: string;
  score: number;
  last_accessed: string;
  access_count: number;
  updated_at: string;
}

export interface WeeklyReport {
  id: string;
  user_id: string;
  week_start: string;
  week_end: string;
  report_text: string;
  stats: {
    notes_added: number;
    questions_asked: number;
    connections_formed: number;
    notes_reviewed: number;
  };
  created_at: string;
}

export interface DailyReviewSession {
  id: string;
  user_id: string;
  review_date: string;
  note_ids: string[];
  created_at: string;
}

export type NoteType = 'idea' | 'fact' | 'quote' | 'memory' | 'goal' | 'reference';

export const NOTE_TYPE_CONFIG: Record<NoteType, { label: string; color: string; bg: string }> = {
  idea: { label: 'Idea', color: 'text-amber-600', bg: 'bg-amber-50' },
  fact: { label: 'Fact', color: 'text-blue-600', bg: 'bg-blue-50' },
  quote: { label: 'Quote', color: 'text-emerald-600', bg: 'bg-emerald-50' },
  memory: { label: 'Memory', color: 'text-rose-600', bg: 'bg-rose-50' },
  goal: { label: 'Goal', color: 'text-violet-700', bg: 'bg-violet-50' },
  reference: { label: 'Reference', color: 'text-stone-600', bg: 'bg-stone-50' },
};
