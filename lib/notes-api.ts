import { supabase } from './supabase';
import { getOwnerId } from './user';
import { Note, Question, ConversationMessage } from './types';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export type DocumentExtractionMethod = 'ocr' | 'document';

const LEGACY_NOTE_FIELDS = 'id, user_id, raw_text, summary, target_date, time_of_day, created_at';
const CATEGORY_NOTE_FIELDS = `${LEGACY_NOTE_FIELDS}, category, category_updated_at`;
let categoryColumnsAvailable: boolean | null = null;

type SupabaseLikeError = { code?: string; message?: string };

function isMissingCategoryColumn(error: SupabaseLikeError | null): boolean {
  const message = error?.message?.toLowerCase() ?? '';
  return error?.code === '42703' || error?.code === 'PGRST204' ||
    (message.includes('category') && (message.includes('does not exist') || message.includes('schema cache')));
}

function normalizeNote(row: Record<string, unknown>): Note {
  return {
    ...(row as unknown as Note),
    category: typeof row.category === 'string' ? row.category : null,
    category_updated_at: typeof row.category_updated_at === 'string' ? row.category_updated_at : null,
  };
}

function normalizeNotes(rows: Array<Record<string, unknown>> | null): Note[] {
  return (rows ?? []).map(normalizeNote);
}

async function getAuthenticatedOwnerId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error('Your session has expired. Sign in again to continue.');
  }
  return data.user.id;
}

async function getAccessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (error || !accessToken) {
    throw new Error('Your session has expired. Sign in again to continue.');
  }
  return accessToken;
}

async function invokeAuthenticatedFunction<T>(functionName: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : `${functionName} failed (${response.status})`);
  }
  return payload as T;
}

export interface EmbeddingBatchResult {
  success: true;
  embedding_version: string;
  processed: number;
  failed: number;
  results: Array<{ note_id: string; status: 'ready' | 'failed' | 'skipped' | 'stale'; error?: string; reason?: string }>;
}

/**
 * Runs the idempotent semantic-embedding worker. The Edge Function derives
 * ownership from this session's JWT; no browser-supplied user id is trusted.
 */
export async function embedNotes(
  noteIds: string[] = [],
  options: { retryFailed?: boolean; retryStaleProcessing?: boolean; limit?: number } = {}
): Promise<EmbeddingBatchResult[]> {
  const batches = noteIds.length
    ? Array.from({ length: Math.ceil(noteIds.length / 20) }, (_, index) => noteIds.slice(index * 20, (index + 1) * 20))
    : [[]];
  const results: EmbeddingBatchResult[] = [];
  for (const batch of batches) {
    results.push(await invokeAuthenticatedFunction<EmbeddingBatchResult>('embed-notes', {
      ...(batch.length ? { note_ids: batch } : {}),
      limit: options.limit ?? 25,
      retry_failed: options.retryFailed ?? false,
      retry_stale_processing: options.retryStaleProcessing ?? false,
    }));
  }
  return results;
}

export async function backfillSemanticEmbeddings(options: {
  batchSize?: number;
  maxBatches?: number;
  retryFailed?: boolean;
  retryStaleProcessing?: boolean;
  onBatch?: (completedBatches: number, latest: EmbeddingBatchResult) => void;
} = {}): Promise<{ batches: number; processed: number; failed: number }> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 25, 1), 50);
  const maxBatches = Math.min(Math.max(options.maxBatches ?? 20, 1), 100);
  let processed = 0;
  let failed = 0;
  let batches = 0;

  for (let index = 0; index < maxBatches; index += 1) {
    const [result] = await embedNotes([], {
      limit: batchSize,
      retryFailed: options.retryFailed,
      retryStaleProcessing: options.retryStaleProcessing,
    });
    batches += 1;
    processed += result.processed;
    failed += result.failed;
    options.onBatch?.(batches, result);
    if (result.results.length < batchSize || result.results.length === 0) break;
  }

  return { batches, processed, failed };
}

function startEmbeddingLifecycle(noteIds: string[]): void {
  if (!noteIds.length) return;
  void embedNotes(noteIds).catch((error) => {
    if (process.env.NODE_ENV !== 'production') console.error('Semantic embedding request failed:', error);
  });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const separator = value.indexOf(',');
      if (separator === -1) {
        reject(new Error(`Could not encode ${file.name}.`));
        return;
      }
      resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

export async function extractDocumentText(
  file: File,
  mimeType: string
): Promise<{ text: string; extractionMethod: DocumentExtractionMethod }> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (sessionError || !accessToken) {
    throw new Error('Your session has expired. Sign in again before extracting documents.');
  }

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/extract-document`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file_name: file.name,
        mime_type: mimeType,
        data: await fileToBase64(file),
      }),
    });
  } catch (error) {
    // Browsers report a missing Edge Function/CORS preflight as the opaque
    // "Failed to fetch" TypeError. Give the user a useful, safe message.
    if (process.env.NODE_ENV !== 'production') console.error('Document extraction request failed:', error);
    throw new Error('We couldn\'t process this document right now. Please try again.');
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('Document extraction service error:', { status: response.status, payload });
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Your session has expired. Sign in again before extracting documents.');
    }
    if (response.status === 413) throw new Error('This file is too large. Choose a file smaller than 10 MB.');
    if (response.status === 415) throw new Error('This file type isn\'t supported yet.');
    if (response.status === 400 || response.status === 422) {
      throw new Error('We couldn\'t read this document. Try another file or export it as PDF.');
    }
    throw new Error('We couldn\'t process this document right now. Please try again.');
  }
  if (typeof payload?.text !== 'string' || !payload.text.trim()) {
    throw new Error(`No readable note text was found in ${file.name}.`);
  }
  const extractionMethod: DocumentExtractionMethod = payload.extraction_method === 'ocr' ? 'ocr' : 'document';
  return { text: payload.text, extractionMethod };
}

/** The user's local calendar date (YYYY-MM-DD), not UTC — this is what "today"/"tomorrow" resolve against. */
export function getLocalDateString(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export async function getNotes(): Promise<Note[]> {
  const ownerId = await getAuthenticatedOwnerId();
  if (categoryColumnsAvailable !== false) {
    const result = await supabase.from('notes').select(CATEGORY_NOTE_FIELDS).eq('user_id', ownerId).order('created_at', { ascending: false });
    if (!result.error) {
      categoryColumnsAvailable = true;
      return normalizeNotes(result.data as Array<Record<string, unknown>> | null);
    }
    if (!isMissingCategoryColumn(result.error)) throw result.error;
    categoryColumnsAvailable = false;
  }

  const { data, error } = await supabase.from('notes').select(LEGACY_NOTE_FIELDS).eq('user_id', ownerId).order('created_at', { ascending: false });
  if (error) throw error;
  return normalizeNotes(data as Array<Record<string, unknown>> | null);
}

/** Save from the dedicated note editor without running question/note classification. */
export async function createNote(rawText: string, category: string | null = null): Promise<Note> {
  const ownerId = await getAuthenticatedOwnerId();
  if (categoryColumnsAvailable !== false) {
    const result = await supabase.from('notes').insert({
      user_id: ownerId,
      raw_text: rawText,
      category,
      category_updated_at: category ? new Date().toISOString() : null,
    }).select(CATEGORY_NOTE_FIELDS).single();
    if (!result.error) {
      categoryColumnsAvailable = true;
      const note = normalizeNote(result.data as Record<string, unknown>);
      startEmbeddingLifecycle([note.id]);
      return note;
    }
    if (!isMissingCategoryColumn(result.error)) throw result.error;
    categoryColumnsAvailable = false;
  }

  const { data, error } = await supabase.from('notes').insert({ user_id: ownerId, raw_text: rawText }).select(LEGACY_NOTE_FIELDS).single();
  if (error) throw error;
  const note = normalizeNote(data as Record<string, unknown>);
  startEmbeddingLifecycle([note.id]);
  return note;
}

const NOTE_IMPORT_BATCH_SIZE = 50;

/**
 * Import plain-text notes without summarizing, rewriting, or otherwise
 * transforming their contents. Inserts are batched to keep large exports
 * within practical PostgREST request sizes.
 */
export async function importNotes(
  rawTexts: string[],
  onProgress?: (completed: number, total: number) => void
): Promise<Note[]> {
  if (rawTexts.length === 0) return [];

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    throw new Error('Your session has expired. Sign in again before importing notes.');
  }

  const imported: Note[] = [];
  const importedIds: string[] = [];
  onProgress?.(0, rawTexts.length);

  try {
    for (let start = 0; start < rawTexts.length; start += NOTE_IMPORT_BATCH_SIZE) {
      const batch = rawTexts.slice(start, start + NOTE_IMPORT_BATCH_SIZE);
      const { data, error } = await supabase
        .from('notes')
        .insert(batch.map((rawText) => ({ user_id: authData.user.id, raw_text: rawText })))
        .select(categoryColumnsAvailable === true ? CATEGORY_NOTE_FIELDS : LEGACY_NOTE_FIELDS);

      if (error) throw error;

      const savedBatch = normalizeNotes(data as unknown as Array<Record<string, unknown>> | null);
      if (savedBatch.length !== batch.length) {
        throw new Error('Supabase did not confirm every imported note.');
      }

      imported.push(...savedBatch);
      importedIds.push(...savedBatch.map((note) => note.id));
      onProgress?.(Math.min(start + batch.length, rawTexts.length), rawTexts.length);
    }

    startEmbeddingLifecycle(importedIds);
    return imported;
  } catch (error) {
    if (importedIds.length > 0) {
      const { error: rollbackError } = await supabase.from('notes').delete().in('id', importedIds);
      if (rollbackError) {
        throw new Error(
          `Import stopped after ${importedIds.length} notes were saved, and automatic cleanup failed. Please review your notes before trying again.`
        );
      }
    }
    throw error;
  }
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
  existing_note_id: string;
}

export async function extractGuidedNotes(answers: string[], corpus: Note[]): Promise<GuidedNoteDraft[]> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/guided-notes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      answers,
      corpus: corpus.map((note) => ({
        id: note.id,
        title: note.raw_text.split('\n', 1)[0]?.trim() || 'Untitled',
        body: note.raw_text,
      })),
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  const corpusIds = new Set(corpus.map((note) => note.id));
  if (!Array.isArray(data.notes)) throw new Error('Invalid guided retrieval response');
  const notes = data.notes.filter((note: unknown): note is GuidedNoteDraft => {
    if (!note || typeof note !== 'object') return false;
    const value = note as Record<string, unknown>;
    return typeof value.existing_note_id === 'string' &&
      corpusIds.has(value.existing_note_id) &&
      typeof value.title === 'string' &&
      typeof value.body === 'string';
  });
  if (data.notes.length > 0 && notes.length === 0) throw new Error('Guided retrieval returned notes outside the corpus');
  return notes.slice(0, 3);
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

export async function updateNote(
  noteId: string,
  rawText: string,
  category?: string | null
): Promise<Note> {
  if (category !== undefined && categoryColumnsAvailable !== false) {
    const result = await supabase.from('notes').update({
      raw_text: rawText,
      category,
      category_updated_at: new Date().toISOString(),
    }).eq('id', noteId).select(CATEGORY_NOTE_FIELDS).single();
    if (!result.error) {
      categoryColumnsAvailable = true;
      const note = normalizeNote(result.data as Record<string, unknown>);
      startEmbeddingLifecycle([note.id]);
      return note;
    }
    if (!isMissingCategoryColumn(result.error)) throw result.error;
    categoryColumnsAvailable = false;
  }

  const { data, error } = await supabase.from('notes').update({ raw_text: rawText }).eq('id', noteId).select(LEGACY_NOTE_FIELDS).single();
  if (error) throw error;
  const note = normalizeNote(data as Record<string, unknown>);
  startEmbeddingLifecycle([note.id]);
  return note;
}

export async function moveNotesToCategory(
  noteIds: string[],
  category: string | null
): Promise<Note[]> {
  if (noteIds.length === 0) return [];
  const ownerId = await getAuthenticatedOwnerId();
  if (categoryColumnsAvailable !== false) {
    const result = await supabase.from('notes').update({ category, category_updated_at: new Date().toISOString() }).in('id', noteIds).eq('user_id', ownerId).select(CATEGORY_NOTE_FIELDS);
    if (!result.error) {
      categoryColumnsAvailable = true;
      return normalizeNotes(result.data as Array<Record<string, unknown>> | null);
    }
    if (!isMissingCategoryColumn(result.error)) throw result.error;
    categoryColumnsAvailable = false;
  }

  const { data, error } = await supabase.from('notes').select(LEGACY_NOTE_FIELDS).in('id', noteIds).eq('user_id', ownerId);
  if (error) throw error;
  return normalizeNotes(data as Array<Record<string, unknown>> | null).map((note) => ({ ...note, category, category_updated_at: new Date().toISOString() }));
}

export async function deleteNote(noteId: string): Promise<void> {
  const { error } = await supabase.from('notes').delete().eq('id', noteId);
  if (error) throw error;
}

/** Fire-and-forget after a note is saved: finds related notes. */
export async function processNote(noteId: string): Promise<{ relations_count: number }> {
  return invokeAuthenticatedFunction<{ relations_count: number }>('process-note', { note_id: noteId });
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
  const result = await invokeAuthenticatedFunction<
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
  >('handle-message', { raw_text: rawText, local_date: getLocalDateString() });
  if (result.type === 'note' && typeof result.note?.id === 'string') startEmbeddingLifecycle([result.note.id]);
  return result;
}

export type SemanticRetrievalExperimentRequest =
  | { experiment: 'q1_subset'; entry_text: string; target_note_ids: string[]; subset_size?: number; seed?: string }
  | {
      experiment: 'q1_record_result';
      experiment_id: string;
      provider: string;
      model: string;
      run_label?: string;
      response_text: string;
      selected_note_ids?: string[];
      metrics?: Record<string, unknown>;
    }
  | { experiment: 'q2_full_rank'; entry_text: string; target_note_ids?: string[] }
  | {
      experiment: 'q5_short_note';
      note_id: string;
      entry_texts: string[];
      variants?: Array<{ name: string; context_note_ids?: string[]; context_text?: string }>;
    };

export async function runSemanticRetrievalExperiment<T = Record<string, unknown>>(
  request: SemanticRetrievalExperimentRequest
): Promise<T> {
  return invokeAuthenticatedFunction<T>('semantic-retrieval-experiment', request);
}

export interface SemanticRetrievalCandidate {
  note_id: string;
  similarity: number;
  raw_rank: number;
  diversified_rank: number;
  mmr_score: number;
  note_length: number;
  token_count: number;
  raw_text: string;
}

export async function retrieveSemanticNotes(
  pageText: string,
  options: { candidateLimit?: number; similarityFloor?: number; duplicateThreshold?: number; diversityLambda?: number } = {}
): Promise<{ candidates: SemanticRetrievalCandidate[]; near_duplicates: SemanticRetrievalCandidate[] }> {
  return invokeAuthenticatedFunction('semantic-retrieval', {
    page_text: pageText,
    candidate_limit: options.candidateLimit ?? 60,
    similarity_floor: options.similarityFloor ?? 0,
    duplicate_threshold: options.duplicateThreshold ?? 0.95,
    diversity_lambda: options.diversityLambda ?? 0.72,
  });
}

export async function getNoteRelations(
  noteId: string
): Promise<Array<{ id: string; related_note_id: string; reason: string | null; confidence?: number; weight?: number; related_note: { id: string; summary: string | null; raw_text: string } }>> {
  // Query only columns available in both the current preview schema and the
  // connection-learning migration. Requesting newer columns against an older
  // preview database creates noisy 400 responses before a fallback can run.
  const { data, error } = await supabase
    .from('note_relations')
    .select('id, related_note_id, reason, related_note:notes!related_note_id(id, summary, raw_text)')
    .eq('note_id', noteId);
  if (error) throw error;
  type RelationNote = { id: string; summary: string | null; raw_text: string };
  type RelationRow = {
    id: string;
    related_note_id: string;
    reason: string | null;
    confidence?: number;
    weight?: number;
    related_note: RelationNote | RelationNote[];
  };
  const rows = (data ?? []) as unknown as RelationRow[];
  return rows.map((r) => ({
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

export async function saveConnectionSuggestion(noteId: string, relatedNoteId: string, reason: string): Promise<void> {
  const { error } = await supabase.from('note_relations').upsert([
    { note_id: noteId, related_note_id: relatedNoteId, reason },
    { note_id: relatedNoteId, related_note_id: noteId, reason },
  ], { onConflict: 'note_id,related_note_id' });
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
  return invokeAuthenticatedFunction('chat-message', {
    question_id: questionId,
    message,
    local_date: getLocalDateString(),
  });
}
