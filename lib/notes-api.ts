import { supabase } from './supabase';
import { getOwnerId } from './user';
import { Note, NoteConnection, Question, ConversationMessage, NoteMemoryStrength, WeeklyReport, DailyReviewSession } from './types';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function getNotes(): Promise<Note[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('id, user_id, title, content, tags, image_url, image_description, category, category_updated_at, created_at, updated_at')
    .eq('user_id', getOwnerId())
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as Note[];
}

export async function uploadNoteImage(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  const userId = getOwnerId();
  const filename = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { data, error } = await supabase.storage
    .from('note-images')
    .upload(filename, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  const { data: { publicUrl } } = supabase.storage
    .from('note-images')
    .getPublicUrl(data.path);
  return publicUrl;
}

export async function createNote(
  title: string,
  content: string,
  imageUrl?: string
): Promise<Note> {
  const insert: Record<string, unknown> = {
    user_id: getOwnerId(), title, content, type: 'note', tags: [],
  };
  if (imageUrl) insert.image_url = imageUrl;
  const { data, error } = await supabase
    .from('notes')
    .insert(insert)
    .select()
    .single();
  if (error) throw error;
  return data as Note;
}

export async function updateNote(
  noteId: string,
  title: string,
  content: string,
  tags?: string[]
): Promise<Note> {
  const patch: Record<string, unknown> = { title, content };
  if (tags !== undefined) patch.tags = tags;
  const { data, error } = await supabase
    .from('notes')
    .update(patch)
    .eq('id', noteId)
    .select()
    .single();
  if (error) throw error;
  return data as Note;
}

export async function createTagRelations(noteId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  const ownerId = getOwnerId();

  // Find all other notes that share any of these tags
  const { data: matchingNotes, error } = await supabase
    .from('notes')
    .select('id')
    .eq('user_id', ownerId)
    .neq('id', noteId)
    .overlaps('tags', tags);

  if (error || !matchingNotes || matchingNotes.length === 0) return;

  // Fetch existing relations to avoid duplicates
  const { data: existing } = await supabase
    .from('note_relations')
    .select('note_id, related_note_id')
    .or(`note_id.eq.${noteId},related_note_id.eq.${noteId}`);

  const existingPairs = new Set(
    (existing || []).flatMap((r) => [
      `${r.note_id}|${r.related_note_id}`,
      `${r.related_note_id}|${r.note_id}`,
    ])
  );

  const toInsert = matchingNotes
    .filter((m) => !existingPairs.has(`${noteId}|${m.id}`))
    .map((m) => ({
      note_id: noteId,
      related_note_id: m.id,
      reason: `Shared tag: ${tags.find((t) => true) ?? ''}`,
    }));

  if (toInsert.length === 0) return;
  await supabase.from('note_relations').insert(toInsert);
}

export async function deleteNote(noteId: string): Promise<void> {
  const { error } = await supabase.from('notes').delete().eq('id', noteId);
  if (error) throw error;
}

export async function processNote(
  noteId: string,
  title: string,
  content: string,
  imageUrl?: string
): Promise<{ tags: string[]; title: string; relations_count: number }> {
  const body: Record<string, unknown> = { note_id: noteId, user_id: getOwnerId(), title, content };
  if (imageUrl) body.image_url = imageUrl;
  const response = await fetch(`${SUPABASE_URL}/functions/v1/process-note`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function answerQuestion(
  question: string
): Promise<{
  answer: string;
  relevant_notes: Array<{ id: string; title: string; similarity: number; content?: string; tags?: string[] }>;
  question_id: string;
  key_points?: string[];
  inline_sources?: Array<{ marker: string; noteId: string }>;
  note_title_map?: Record<string, { id: string; title: string }>;
}> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/answer-question`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question, user_id: getOwnerId() }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function getConnections(): Promise<NoteConnection[]> {
  const { data, error } = await supabase
    .from('note_connections')
    .select(`
      id, note_id_a, note_id_b, similarity_score, created_at,
      note_a:notes!note_id_a(id, title, type, user_id)
    `)
    .limit(300);
  if (error) throw error;
  const ownerId = getOwnerId();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered = (data || []).filter((c: any) => {
    const noteA = Array.isArray(c.note_a) ? c.note_a[0] : c.note_a;
    return noteA && noteA.user_id === ownerId;
  });
  return filtered as unknown as NoteConnection[];
}

export async function getNoteRelations(noteId: string): Promise<Array<{ id: string; related_note_id: string; reason: string; related_note: { id: string; title: string } }>> {
  const { data, error } = await supabase
    .from('note_relations')
    .select('id, related_note_id, reason, related_note:notes!related_note_id(id, title)')
    .eq('note_id', noteId);
  if (error) throw error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data || []).map((r: any) => ({
    ...r,
    related_note: Array.isArray(r.related_note) ? r.related_note[0] : r.related_note,
  }));
}

export async function getNoteRelationsFull(noteId: string): Promise<Array<{ id: string; related_note_id: string; reason: string; related_note: { id: string; title: string; content: string; tags: string[] } }>> {
  const { data, error } = await supabase
    .from('note_relations')
    .select('id, related_note_id, reason, related_note:notes!related_note_id(id, title, content, tags)')
    .eq('note_id', noteId);
  if (error) throw error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data || []).map((r: any) => ({
    ...r,
    related_note: Array.isArray(r.related_note) ? r.related_note[0] : r.related_note,
  }));
}

export async function getAllNoteRelations(): Promise<Array<{
  id: string;
  note_id: string;
  related_note_id: string;
  reason: string;
  note: { id: string; title: string; content: string; user_id: string };
  related_note: { id: string; title: string; content: string };
}>> {
  const { data, error } = await supabase
    .from('note_relations')
    .select(`
      id, note_id, related_note_id, reason,
      note:notes!note_id(id, title, content, user_id),
      related_note:notes!related_note_id(id, title, content)
    `);
  if (error) throw error;
  const ownerId = getOwnerId();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered = (data || []).filter((r: any) => {
    const n = Array.isArray(r.note) ? r.note[0] : r.note;
    return n && n.user_id === ownerId;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return filtered.map((r: any) => ({
    ...r,
    note: Array.isArray(r.note) ? r.note[0] : r.note,
    related_note: Array.isArray(r.related_note) ? r.related_note[0] : r.related_note,
  }));
}

export async function getQuestions(): Promise<Question[]> {
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('user_id', getOwnerId())
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data as Question[];
}

export async function deleteQuestion(questionId: string): Promise<void> {
  const { error } = await supabase.from('questions').delete().eq('id', questionId);
  if (error) throw error;
}

export async function updateQuestionAnswer(questionId: string, answer: string): Promise<void> {
  const { error } = await supabase
    .from('questions')
    .update({ answer })
    .eq('id', questionId);
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
  relevant_notes: Array<{ id: string; title: string; similarity: number; content: string; tags: string[] }>;
  messages: ConversationMessage[];
}> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/chat-message`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question_id: questionId, user_id: getOwnerId(), message }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export interface InsightCandidate {
  title: string;
  content: string;
  type: string;
  tags: string[];
}

export async function generateInsightCandidates(
  questionId: string
): Promise<{ candidates: InsightCandidate[]; count: number }> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/save-insights`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question_id: questionId, user_id: getOwnerId() }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function saveSelectedInsights(
  questionId: string,
  acceptedInsights: InsightCandidate[]
): Promise<{ notes: Array<{ id: string; title: string; tags: string[] }>; count: number }> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/save-insights`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question_id: questionId, user_id: getOwnerId(), accepted_insights: acceptedInsights }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

/** @deprecated Use generateInsightCandidates + saveSelectedInsights instead */
export async function saveInsights(
  questionId: string
): Promise<{ notes: Array<{ id: string; title: string; tags: string[] }>; count: number }> {
  return saveSelectedInsights(questionId, []);
}

export async function findMemory(
  fragment: string,
  conversation: Array<{ role: 'user' | 'assistant'; text: string }>,
  sessionId?: string,
  hintCategory?: string
): Promise<{
  session_id: string;
  ranked_notes: Array<{ id: string; title: string; content: string; tags: string[]; score: number; reason: string }>;
  clarifying_question: string;
  done: boolean;
}> {
  const body: Record<string, unknown> = { user_id: getOwnerId(), fragment, conversation, session_id: sessionId };
  if (hintCategory) body.hint_category = hintCategory;
  const response = await fetch(`${SUPABASE_URL}/functions/v1/find-memory`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function resolveMemorySession(sessionId: string, resolvedNoteId: string): Promise<void> {
  const { error } = await supabase
    .from('memory_sessions')
    .update({ resolved_note_id: resolvedNoteId, updated_at: new Date().toISOString() })
    .eq('id', sessionId);
  if (error) throw error;
}

export async function getMemorySessions(): Promise<Array<{
  id: string;
  fragment: string;
  resolved_note_id: string | null;
  chain_note_ids: string[];
  created_at: string;
}>> {
  const { data, error } = await supabase
    .from('memory_sessions')
    .select('id, fragment, resolved_note_id, chain_note_ids, created_at')
    .eq('user_id', getOwnerId())
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return data || [];
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

// --- Memory Strength ---

export async function getMemoryStrengths(): Promise<NoteMemoryStrength[]> {
  const { data, error } = await supabase
    .from('note_memory_strength')
    .select('*')
    .eq('user_id', getOwnerId());
  if (error) throw error;
  return (data || []) as NoteMemoryStrength[];
}

export async function reinforceMemoryStrength(noteId: string, boost = 8): Promise<void> {
  const ownerId = getOwnerId();
  const { data: existing } = await supabase
    .from('note_memory_strength')
    .select('id, score, access_count')
    .eq('user_id', ownerId)
    .eq('note_id', noteId)
    .maybeSingle();

  if (existing) {
    const newScore = Math.min(100, existing.score + boost);
    await supabase
      .from('note_memory_strength')
      .update({
        score: newScore,
        last_accessed: new Date().toISOString(),
        access_count: existing.access_count + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
  } else {
    await supabase
      .from('note_memory_strength')
      .insert({
        user_id: ownerId,
        note_id: noteId,
        score: Math.min(100, 50 + boost),
        last_accessed: new Date().toISOString(),
        access_count: 1,
      });
  }
}

// --- Daily Review ---

export async function getTodayReviewSession(): Promise<DailyReviewSession | null> {
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('daily_review_sessions')
    .select('*')
    .eq('user_id', getOwnerId())
    .eq('review_date', today)
    .maybeSingle();
  if (error) throw error;
  return data as DailyReviewSession | null;
}

export async function createDailyReviewSession(noteIds: string[]): Promise<DailyReviewSession> {
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('daily_review_sessions')
    .insert({ user_id: getOwnerId(), review_date: today, note_ids: noteIds })
    .select()
    .single();
  if (error) throw error;
  return data as DailyReviewSession;
}

export async function saveDailyReviewResponse(
  sessionId: string,
  noteId: string,
  response: 'relevant' | 'flagged'
): Promise<void> {
  const { error } = await supabase
    .from('daily_review_responses')
    .insert({ session_id: sessionId, user_id: getOwnerId(), note_id: noteId, response });
  if (error) throw error;
}

export async function getDailyReviewNotes(): Promise<Note[]> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/daily-review`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: getOwnerId() }),
  });
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  return result.notes || [];
}

// --- Weekly Reports ---

export async function getWeeklyReports(): Promise<WeeklyReport[]> {
  const { data, error } = await supabase
    .from('weekly_reports')
    .select('*')
    .eq('user_id', getOwnerId())
    .order('week_start', { ascending: false });
  if (error) throw error;
  return (data || []) as WeeklyReport[];
}

export async function generateWeeklyReport(weekStart: string, weekEnd: string): Promise<WeeklyReport> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/weekly-report`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: getOwnerId(), week_start: weekStart, week_end: weekEnd }),
  });
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  return result.report as WeeklyReport;
}

// --- Categories ---

export async function saveNoteCategories(
  assignments: Array<{ noteId: string; category: string | null }>
): Promise<void> {
  const now = new Date().toISOString();
  await Promise.all(
    assignments.map(({ noteId, category }) =>
      supabase
        .from('notes')
        .update({ category, category_updated_at: now })
        .eq('id', noteId)
    )
  );
}

export async function categorizeNotes(lastCategorizedAt?: string | null): Promise<{
  groups: Array<{ name: string; noteIds: string[] }>;
  db_total: number;
  total_notes: number;
  changed_count: number;
  categorized_count: number;
  assigned_count: number;
}> {
  const userId = getOwnerId();
  console.log('[categorizeNotes] user_id:', userId, '| lastCategorizedAt:', lastCategorizedAt);
  console.log('[categorizeNotes] endpoint:', `${SUPABASE_URL}/functions/v1/categorize-notes`);

  const response = await fetch(`${SUPABASE_URL}/functions/v1/categorize-notes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId, last_categorized_at: lastCategorizedAt ?? null }),
  });

  console.log('[categorizeNotes] response status:', response.status, response.statusText);

  if (!response.ok) {
    const errText = await response.text();
    console.error('[categorizeNotes] error body:', errText);
    throw new Error(`Categorize failed (HTTP ${response.status}): ${errText}`);
  }

  const data = await response.json();
  console.log('[categorizeNotes] success — total_notes:', data.total_notes, 'changed_count:', data.changed_count, 'groups:', data.groups?.length);
  return data;
}

export async function searchNotes(query: string): Promise<Note[]> {
  // Uses the GIN index: notes_search_idx on to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))
  const { data, error } = await supabase
    .from('notes')
    .select('id, user_id, title, content, tags, image_url, image_description, category, category_updated_at, created_at, updated_at')
    .eq('user_id', getOwnerId())
    .filter(
      "to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))",
      'fts',
      `'${query.replace(/'/g, "''")}'`
    )
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as Note[];
}

// --- User Settings ---

export async function getLastCategorizedAt(): Promise<string | null> {
  const { data } = await supabase
    .from('user_settings')
    .select('last_categorized_at')
    .eq('user_id', getOwnerId())
    .maybeSingle();
  return data?.last_categorized_at ?? null;
}

export async function setLastCategorizedAt(ts: string): Promise<void> {
  const ownerId = getOwnerId();
  const { error } = await supabase
    .from('user_settings')
    .upsert(
      { user_id: ownerId, last_categorized_at: ts, updated_at: ts },
      { onConflict: 'user_id' }
    );
  if (error) throw error;
}

export async function generateCategoryQuestions(
  category: string
): Promise<{ questions: string[] }> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/category-questions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: getOwnerId(), category }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function narrowNotes(
  query: string,
  categoryNotes: Array<{ id: string; title: string; content: string }>,
  otherNotes: Array<{ id: string; title: string; content: string; category: string | null }>
): Promise<{
  category_matches: string[];
  cross_category_matches: string[];
}> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/narrow-notes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: getOwnerId(), query, category_notes: categoryNotes, other_notes: otherNotes }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

// ─── Pinned Notes ─────────────────────────────────────────────────────────────

export interface PinnedNote {
  id: string;
  user_id: string;
  note_id: string;
  pinned_until: string | null;
  created_at: string;
  note?: { id: string; title: string; content: string; tags: string[]; category: string | null };
}

export async function getPinnedNotes(): Promise<PinnedNote[]> {
  const { data, error } = await supabase
    .from('pinned_notes')
    .select('*, note:notes!note_id(id, title, content, tags, category)')
    .eq('user_id', getOwnerId())
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data || []) as PinnedNote[]).map((p) => ({
    ...p,
    note: Array.isArray(p.note) ? p.note[0] : p.note,
  }));
}

export async function pinNote(noteId: string, pinnedUntil: string | null): Promise<PinnedNote> {
  const { data, error } = await supabase
    .from('pinned_notes')
    .upsert(
      { user_id: getOwnerId(), note_id: noteId, pinned_until: pinnedUntil },
      { onConflict: 'user_id,note_id' }
    )
    .select('*, note:notes!note_id(id, title, content, tags, category)')
    .single();
  if (error) throw error;
  return { ...data, note: Array.isArray(data.note) ? data.note[0] : data.note };
}

export async function unpinNote(noteId: string): Promise<void> {
  const { error } = await supabase
    .from('pinned_notes')
    .delete()
    .eq('user_id', getOwnerId())
    .eq('note_id', noteId);
  if (error) throw error;
}

// ─── Journal ──────────────────────────────────────────────────────────────────

export interface JournalEntry {
  id: string;
  user_id: string;
  date: string;
  content: string;
  mood: number | null;
  ai_summary: string | null;
  tomorrow_note: string | null;
  image_url: string | null;
  related_note_ids: string[];
  created_at: string;
  updated_at: string;
}

export async function getJournalEntries(year: number, month: number): Promise<JournalEntry[]> {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(year, month, 0).toISOString().split('T')[0]; // last day of month
  const { data, error } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('user_id', getOwnerId())
    .gte('date', start)
    .lte('date', end)
    .order('date', { ascending: true });
  if (error) throw error;
  return (data || []) as JournalEntry[];
}

export async function getJournalEntry(date: string): Promise<JournalEntry | null> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('user_id', getOwnerId())
    .eq('date', date)
    .maybeSingle();
  if (error) throw error;
  return data as JournalEntry | null;
}

export async function upsertJournalEntry(
  date: string,
  content: string,
  mood: number | null,
  aiSummary: string | null,
  tomorrowNote?: string | null,
  imageUrl?: string | null,
  relatedNoteIds?: string[]
): Promise<JournalEntry> {
  const ownerId = getOwnerId();
  const patch: Record<string, unknown> = {
    user_id: ownerId,
    date,
    content,
    mood,
    ai_summary: aiSummary,
    updated_at: new Date().toISOString(),
  };
  if (tomorrowNote !== undefined) patch.tomorrow_note = tomorrowNote;
  if (imageUrl !== undefined) patch.image_url = imageUrl;
  if (relatedNoteIds !== undefined) patch.related_note_ids = relatedNoteIds;
  const { data, error } = await supabase
    .from('journal_entries')
    .upsert(patch, { onConflict: 'user_id,date' })
    .select()
    .single();
  if (error) throw error;
  return data as JournalEntry;
}

export async function getRelatedNotesByIds(
  ids: string[]
): Promise<Array<{ id: string; title: string; content: string; tags: string[] }>> {
  if (!ids || ids.length === 0) return [];
  const { data, error } = await supabase
    .from('notes')
    .select('id, title, content, tags')
    .in('id', ids)
    .eq('user_id', getOwnerId());
  if (error) throw error;
  // Preserve the original ordering
  const map = new Map((data ?? []).map((n) => [n.id, n]));
  return ids.map((id) => map.get(id)).filter(Boolean) as Array<{ id: string; title: string; content: string; tags: string[] }>;
}

export async function getYesterdayTomorrowNote(date: string): Promise<string | null> {
  // Build yesterday using local date parts to avoid UTC offset shifting the date
  const [y, m, d] = date.split('-').map(Number);
  const prev = new Date(y, m - 1, d - 1);
  const yesterday = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
  const { data } = await supabase
    .from('journal_entries')
    .select('tomorrow_note')
    .eq('user_id', getOwnerId())
    .eq('date', yesterday)
    .maybeSingle();
  return data?.tomorrow_note ?? null;
}

export async function getAdjacentJournalDates(date: string): Promise<{ prev: string | null; next: string | null }> {
  const ownerId = getOwnerId();
  const [{ data: prevData }, { data: nextData }] = await Promise.all([
    supabase
      .from('journal_entries')
      .select('date')
      .eq('user_id', ownerId)
      .lt('date', date)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('journal_entries')
      .select('date')
      .eq('user_id', ownerId)
      .gt('date', date)
      .order('date', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    prev: prevData?.date ?? null,
    next: nextData?.date ?? null,
  };
}

export async function getJournalStreak(): Promise<number> {
  const ownerId = getOwnerId();
  const { data, error } = await supabase
    .from('journal_entries')
    .select('date')
    .eq('user_id', ownerId)
    .order('date', { ascending: false })
    .limit(365);
  if (error || !data || data.length === 0) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let streak = 0;
  let cursor = new Date(today);

  const dateSet = new Set(data.map((r) => r.date));

  for (let i = 0; i < 365; i++) {
    const ds = cursor.toISOString().split('T')[0];
    if (dateSet.has(ds)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      // Allow missing today (streak still active if yesterday written)
      if (i === 0) {
        cursor.setDate(cursor.getDate() - 1);
        continue;
      }
      break;
    }
  }
  return streak;
}

export async function journalAI(
  content: string,
  date: string,
  imageUrl?: string
): Promise<{ summary: string; related_notes: Array<{ id: string; title: string; content: string; tags: string[]; similarity: number }> }> {
  const body: Record<string, unknown> = { user_id: getOwnerId(), journal_content: content, date };
  if (imageUrl) body.image_url = imageUrl;
  const response = await fetch(`${SUPABASE_URL}/functions/v1/journal-ai`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function saveJournalInsights(
  content: string,
  date: string
): Promise<{ notes: Array<{ id: string; title: string; tags: string[] }>; count: number }> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/journal-insights`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: getOwnerId(), journal_content: content, date }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

// ─── Canvas Layout ─────────────────────────────────────────────────────────────

export async function getCanvasPositions(): Promise<Array<{ note_id: string; x: number; y: number }>> {
  const { data, error } = await supabase
    .from('note_canvas_positions')
    .select('note_id, x, y')
    .eq('user_id', getOwnerId());
  if (error) throw error;
  return (data || []) as Array<{ note_id: string; x: number; y: number }>;
}

export async function saveCanvasPositions(
  positions: Array<{ note_id: string; x: number; y: number }>
): Promise<void> {
  if (positions.length === 0) return;
  const ownerId = getOwnerId();
  const rows = positions.map((p) => ({
    user_id: ownerId,
    note_id: p.note_id,
    x: p.x,
    y: p.y,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from('note_canvas_positions')
    .upsert(rows, { onConflict: 'user_id,note_id' });
  if (error) throw error;
}
