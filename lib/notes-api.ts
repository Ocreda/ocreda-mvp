import { supabase } from './supabase';
import { getOwnerId } from './user';
import { Note, Question, ConversationMessage } from './types';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** The user's local calendar date (YYYY-MM-DD), not UTC — this is what "today"/"tomorrow" resolve against. */
export function getLocalDateString(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export async function getNotes(): Promise<Note[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('id, user_id, raw_text, summary, target_date, time_of_day, created_at')
    .eq('user_id', await getOwnerId())
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as Note[];
}

/** Save from the dedicated note editor without running question/note classification. */
export async function createNote(rawText: string): Promise<Note> {
  const { data, error } = await supabase
    .from('notes')
    .insert({ user_id: await getOwnerId(), raw_text: rawText })
    .select('id, user_id, raw_text, summary, target_date, time_of_day, created_at')
    .single();
  if (error) throw error;
  return data as Note;
}

export async function getGuidedChatReaction(previousAnswer: string, nextQuestion: string): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/guided-chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ previous_answer: previousAnswer, next_question: nextQuestion }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return data.message;
}

export interface GuidedNoteDraft {
  title: string;
  body: string;
  source_answer: number;
}

export async function extractGuidedNotes(answers: string[]): Promise<GuidedNoteDraft[]> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/guided-notes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ answers }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return data.notes;
}

export async function getNoteById(noteId: string): Promise<Note> {
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('id', noteId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Note not found');
  return data as Note;
}

export async function updateNote(noteId: string, rawText: string): Promise<Note> {
  const { data, error } = await supabase
    .from('notes')
    .update({ raw_text: rawText })
    .eq('id', noteId)
    .select()
    .single();
  if (error) throw error;
  return data as Note;
}

export async function deleteNote(noteId: string): Promise<void> {
  const { error } = await supabase.from('notes').delete().eq('id', noteId);
  if (error) throw error;
}

/** Fire-and-forget after a note is saved: finds related notes. */
export async function processNote(noteId: string): Promise<{ relations_count: number }> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/process-note`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ note_id: noteId, user_id: await getOwnerId() }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

/** The single entry point for the "My Brain" input: classifies the text as a note to save or a question to answer. */
export async function handleMessage(rawText: string): Promise<
  | { type: 'note'; note: Note }
  | {
      type: 'question';
      answer: string;
      relevant_notes: Array<{ id: string; summary: string | null; raw_text: string; connection_count: number }>;
      question_id: string;
      key_points: string[];
      inline_sources: Array<{ marker: string; noteId: string }>;
      note_title_map: Record<string, { id: string; title: string }>;
    }
> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/handle-message`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: await getOwnerId(), raw_text: rawText, local_date: getLocalDateString() }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function getNoteRelations(
  noteId: string
): Promise<Array<{ id: string; related_note_id: string; reason: string | null; confidence?: number; weight?: number; related_note: { id: string; summary: string | null; raw_text: string } }>> {
  const enhanced = await supabase
    .from('note_relations')
    .select('id, related_note_id, reason, confidence, weight, related_note:notes!related_note_id(id, summary, raw_text)')
    .eq('note_id', noteId);
  // The fallback keeps clients working while the connection-learning migration rolls out.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any[] | null = enhanced.data;
  let error = enhanced.error;
  if (error) {
    const fallback = await supabase
      .from('note_relations')
      .select('id, related_note_id, reason, related_note:notes!related_note_id(id, summary, raw_text)')
      .eq('note_id', noteId);
    data = fallback.data;
    error = fallback.error;
  }
  if (error) throw error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data || []).map((r: any) => ({
    ...r,
    related_note: Array.isArray(r.related_note) ? r.related_note[0] : r.related_note,
  })).sort((a, b) => ((b.confidence ?? 1) * (b.weight ?? 1)) - ((a.confidence ?? 1) * (a.weight ?? 1)));
}

export async function applyConnectionFeedback(noteId: string, relatedNoteId: string, accepted: boolean): Promise<void> {
  const { error } = await supabase.rpc('apply_connection_feedback', {
    p_note_id: noteId,
    p_related_note_id: relatedNoteId,
    p_multiplier: accepted ? 1.5 : 0.7,
    p_feedback: accepted ? 'accepted' : 'rejected',
  });
  if (error) throw error;
}

export async function getQuestions(): Promise<Question[]> {
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('user_id', await getOwnerId())
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data as Question[];
}

export async function deleteQuestion(questionId: string): Promise<void> {
  const { error } = await supabase.from('questions').delete().eq('id', questionId);
  if (error) throw error;
}

export async function getConversationMessages(questionId: string): Promise<ConversationMessage[]> {
  const { data, error } = await supabase
    .from('conversation_messages')
    .select('*')
    .eq('question_id', questionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data as ConversationMessage[];
}

export async function sendChatMessage(
  questionId: string,
  message: string
): Promise<{
  reply: string;
  relevant_notes: Array<{ id: string; summary: string | null; raw_text: string; connection_count: number }>;
  messages: ConversationMessage[];
}> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/chat-message`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      question_id: questionId,
      user_id: await getOwnerId(),
      message,
      local_date: getLocalDateString(),
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
