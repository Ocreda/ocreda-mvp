export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

export interface Note {
  id: string;
  user_id: string;
  raw_text: string;
  summary: string | null;
  target_date: string | null;
  time_of_day: TimeOfDay | null;
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
