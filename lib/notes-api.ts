import { supabase } from './supabase';
import { getOwnerId } from './user';
import {
  IS_LOCAL_MODE,
  localCreateNote,
  localDeleteNote,
  localFindRelevantNotes,
  localGetNotes,
  localImportNotes,
  localMoveNotesToCategory,
  localUpdateNote,
} from '@/dev/local-mode';  // DEV-LOCAL-MODE
import {
  Note,
  NoteImportInput,
  Question,
  ConversationMessage,
  RelevanceProgress,
  RelevantNotesResponse,
} from './types';
import { readRelevanceResponse } from './relevance-stream';

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
  if (IS_LOCAL_MODE) return localGetNotes();  // DEV-LOCAL-MODE
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
  if (IS_LOCAL_MODE) return localCreateNote(rawText, category);  // DEV-LOCAL-MODE
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
      return normalizeNote(result.data as Record<string, unknown>);
    }
    if (!isMissingCategoryColumn(result.error)) throw result.error;
    categoryColumnsAvailable = false;
  }

  const { data, error } = await supabase.from('notes').insert({ user_id: ownerId, raw_text: rawText }).select(LEGACY_NOTE_FIELDS).single();
  if (error) throw error;
  return normalizeNote(data as Record<string, unknown>);
}

const NOTE_IMPORT_BATCH_SIZE = 50;

/**
 * Import prepared plain-text notes without summarizing or rewriting them.
 * Callers may add display metadata such as a generated title before this
 * storage step. Inserts are batched to keep large exports within practical
 * PostgREST request sizes.
 */
export async function importNotes(
  inputs: NoteImportInput[],
  onProgress?: (completed: number, total: number) => void
): Promise<Note[]> {
  if (inputs.length === 0) return [];
  if (IS_LOCAL_MODE) return localImportNotes(inputs, onProgress);  // DEV-LOCAL-MODE

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    throw new Error('Your session has expired. Sign in again before importing notes.');
  }

  const imported: Note[] = [];
  const importedIds: string[] = [];
  onProgress?.(0, inputs.length);

  try {
    for (let start = 0; start < inputs.length; start += NOTE_IMPORT_BATCH_SIZE) {
      const batch = inputs.slice(start, start + NOTE_IMPORT_BATCH_SIZE);
      const includeCategories = categoryColumnsAvailable !== false;
      let categoriesSaved = includeCategories;
      let result = await supabase
        .from('notes')
        .insert(batch.map((input) => ({
          user_id: authData.user.id,
          raw_text: input.rawText,
          ...(includeCategories ? {
            category: input.category,
            category_updated_at: new Date().toISOString(),
          } : {}),
        })))
        .select(includeCategories ? CATEGORY_NOTE_FIELDS : LEGACY_NOTE_FIELDS);

      if (result.error && includeCategories && isMissingCategoryColumn(result.error)) {
        categoryColumnsAvailable = false;
        categoriesSaved = false;
        result = await supabase
          .from('notes')
          .insert(batch.map((input) => ({ user_id: authData.user.id, raw_text: input.rawText })))
          .select(LEGACY_NOTE_FIELDS);
      }

      if (result.error) throw result.error;
      if (categoriesSaved) categoryColumnsAvailable = true;

      const savedBatch = normalizeNotes(result.data as unknown as Array<Record<string, unknown>> | null)
        .map((note, index) => ({
          ...note,
          category: batch[index].category,
          category_updated_at: note.category_updated_at ?? new Date().toISOString(),
        }));
      if (savedBatch.length !== batch.length) {
        throw new Error('Supabase did not confirm every imported note.');
      }

      imported.push(...savedBatch);
      importedIds.push(...savedBatch.map((note) => note.id));
      onProgress?.(Math.min(start + batch.length, inputs.length), inputs.length);
    }

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
      corpus: corpus.map((note) => ({ id: note.id, title: note.summary, body: note.raw_text })),
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
  if (IS_LOCAL_MODE) return localUpdateNote(noteId, rawText, category);  // DEV-LOCAL-MODE
  if (category !== undefined && categoryColumnsAvailable !== false) {
    const result = await supabase.from('notes').update({
      raw_text: rawText,
      category,
      category_updated_at: new Date().toISOString(),
    }).eq('id', noteId).select(CATEGORY_NOTE_FIELDS).single();
    if (!result.error) {
      categoryColumnsAvailable = true;
      return normalizeNote(result.data as Record<string, unknown>);
    }
    if (!isMissingCategoryColumn(result.error)) throw result.error;
    categoryColumnsAvailable = false;
  }

  const { data, error } = await supabase.from('notes').update({ raw_text: rawText }).eq('id', noteId).select(LEGACY_NOTE_FIELDS).single();
  if (error) throw error;
  return normalizeNote(data as Record<string, unknown>);
}

export async function moveNotesToCategory(
  noteIds: string[],
  category: string | null
): Promise<Note[]> {
  if (noteIds.length === 0) return [];
  if (IS_LOCAL_MODE) return localMoveNotesToCategory(noteIds, category);  // DEV-LOCAL-MODE
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
  if (IS_LOCAL_MODE) { localDeleteNote(noteId); return; }  // DEV-LOCAL-MODE
  const { error } = await supabase.from('notes').delete().eq('id', noteId);
  if (error) throw error;
}

/** Fire-and-forget after a note is saved: finds related notes. */
export async function processNote(noteId: string): Promise<{ relations_count: number }> {
  // Background relation-building needs the Edge Function; local mode skips it.
  if (IS_LOCAL_MODE) return { relations_count: 0 };  // DEV-LOCAL-MODE
  const response = await fetch(`${SUPABASE_URL}/functions/v1/process-note`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ note_id: noteId, user_id: await getAuthenticatedOwnerId() }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

/** Below this the draft is too thin for relevance scoring to mean anything. */
export const MIN_RELEVANCE_DRAFT_CHARS = 40;

type SemanticCandidate = { note_id: string; similarity: number };
type EmbeddingOutcome = { status?: string; embedding_status?: string };

const EMBEDDING_BATCH_SIZE = 20;
const EMBEDDING_BATCH_CONCURRENCY = 2;
const EMBEDDING_QUERY_PAGE_SIZE = 1000;
// Candidate retrieval stays wide; the user-facing note list should not display
// every positive cosine score as though it were a meaningful match.
const MIN_VISIBLE_NOTE_SIMILARITY = 0.68;
const MAX_VISIBLE_SCORE_GAP = 0.10;
const MAX_VISIBLE_RELATED_NOTES = 8;

/** Finish pending note embeddings before ranking them, including older notes. */
async function prepareNotesForSemanticSearch(accessToken: string): Promise<number> {
  const pendingIds: string[] = [];
  for (let offset = 0; ; offset += EMBEDDING_QUERY_PAGE_SIZE) {
    const { data, error } = await supabase.from('notes')
      .select('id')
      .neq('embedding_status', 'ready')
      .order('created_at', { ascending: false })
      .range(offset, offset + EMBEDDING_QUERY_PAGE_SIZE - 1);
    if (error) throw new Error('Could not check which notes are ready for semantic search.');
    pendingIds.push(...(data ?? []).map((note) => note.id));
    if ((data ?? []).length < EMBEDDING_QUERY_PAGE_SIZE) break;
  }

  const batches: string[][] = [];
  for (let start = 0; start < pendingIds.length; start += EMBEDDING_BATCH_SIZE) {
    batches.push(pendingIds.slice(start, start + EMBEDDING_BATCH_SIZE));
  }
  let nextBatch = 0;
  let unprepared = 0;
  const processBatches = async () => {
    while (nextBatch < batches.length) {
      const noteIds = batches[nextBatch++];
      let response: Response;
      try {
        response = await fetch(`${SUPABASE_URL}/functions/v1/embed-notes`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ note_ids: noteIds, retry_failed: true, retry_stale_processing: true }),
        });
      } catch {
        throw new Error('Could not prepare your notes for semantic search. Please try again.');
      }
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || payload?.success !== true || !Array.isArray(payload.results)) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('Your session has expired. Sign in again to search your notes.');
        }
        if (typeof payload?.error === 'string' && payload.error.includes('GEMINI_API_KEY is not configured')) {
          throw new Error('Semantic search is not configured on the server yet.');
        }
        throw new Error('Could not prepare your notes for semantic search. Please try again.');
      }
      unprepared += (payload.results as EmbeddingOutcome[]).filter((result) =>
        result.status !== 'ready' && !(result.status === 'skipped' && result.embedding_status === 'ready')
      ).length;
    }
  };
  await Promise.all(Array.from({ length: Math.min(EMBEDDING_BATCH_CONCURRENCY, batches.length) }, processBatches));
  return unprepared;
}

/**
 * Embedding search: ranks notes by cosine similarity with their own JWT and RLS.
 * Cheap and sub-second, so this is what runs on its own when a note is opened.
 * It returns similarity only; nothing here classifies the relationship or
 * explains it. Use findRelevantNotes for that.
 */
export async function findSimilarNotes(
  draftText: string,
  excludeNoteId?: string | null,
  onProgress?: (progress: RelevanceProgress) => void,
  notePool: Note[] = [],
): Promise<RelevantNotesResponse> {
  // Local mode has no embedding stand-in, so it falls back to the AI readers.
  if (IS_LOCAL_MODE) return localFindRelevantNotes(draftText, excludeNoteId, onProgress);  // DEV-LOCAL-MODE
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (sessionError || !accessToken) {
    throw new Error('Your session has expired. Sign in again to search your notes.');
  }

  const unpreparedCount = await prepareNotesForSemanticSearch(accessToken);

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/semantic-retrieval`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ page_text: draftText }),
    });
  } catch (error) {
    // Browser CORS/network failures do not expose an HTTP response.
    if (process.env.NODE_ENV !== 'production') console.error('Relevance search request failed:', error);
    throw new Error("We couldn't search your notes right now. Please try again.");
  }

  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Your session has expired. Sign in again to search your notes.');
    }
    const message = typeof payload?.error === 'string' ? payload.error : null;
    if (message?.includes('GEMINI_API_KEY is not configured')) {
      throw new Error('Semantic search is not configured on the server yet.');
    }
    throw new Error("We couldn't search your notes right now. Please try again.");
  }

  if (payload?.success !== true || !Array.isArray(payload.candidates)) {
    throw new Error("We couldn't search your notes right now. Please try again.");
  }
  // The retrieval endpoint keeps near-duplicates out of generated connection
  // slots, but a note search must still find another copy of the same text.
  const nearDuplicates = Array.isArray(payload.near_duplicates)
    ? payload.near_duplicates as SemanticCandidate[] : [];
  const rankedCandidates = payload.candidates as SemanticCandidate[];
  const strongestScore = Math.max(0, ...rankedCandidates.map((candidate) => Number(candidate.similarity) || 0));
  const visibleFloor = Math.max(MIN_VISIBLE_NOTE_SIMILARITY, strongestScore - MAX_VISIBLE_SCORE_GAP);
  const candidates = [
    ...nearDuplicates,
    ...rankedCandidates.filter((candidate) => candidate.similarity >= visibleFloor),
  ];
  const exactMatches = notePool
    .filter((note) => note.id !== excludeNoteId && note.raw_text.trim() === draftText.trim())
    .map((note) => ({ note_id: note.id, similarity: 1 }));
  const uniqueCandidates = new Map<string, SemanticCandidate>();
  for (const candidate of [...exactMatches, ...candidates]) {
    if (!candidate || typeof candidate.note_id !== 'string' ||
        candidate.note_id === excludeNoteId || !Number.isFinite(candidate.similarity)) continue;
    if (!uniqueCandidates.has(candidate.note_id)) uniqueCandidates.set(candidate.note_id, candidate);
  }
  const results = [...uniqueCandidates.values()]
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, MAX_VISIBLE_RELATED_NOTES)
    .map((candidate) => ({
      note_id: candidate.note_id,
      relevance_score: Math.max(0, Math.min(1, candidate.similarity)),
      relation_type: null,
      gist: '',
      explanation: '',
    }));
  if (results.length === 0 && unpreparedCount > 0) {
    throw new Error('Some notes are not searchable yet. Please try again.');
  }
  return {
    results,
    coverage: {
      notes_searched: Math.max(0, notePool.length - unpreparedCount),
      notes_total: notePool.length,
      complete: unpreparedCount === 0,
    },
  };
}

/**
 * AI reader search: every note is read against the draft by a model that scores
 * the strength of the connection, names the relationship, and explains it. Slower
 * and far more expensive than findSimilarNotes, so this runs only when the user
 * asks for it.
 *
 * Sends the user's own access token rather than the anon key so the function
 * derives the account from a verified session instead of trusting the caller.
 */
export async function findRelevantNotes(
  draftText: string,
  excludeNoteId?: string | null,
  onProgress?: (progress: RelevanceProgress) => void
): Promise<RelevantNotesResponse> {
  if (IS_LOCAL_MODE) return localFindRelevantNotes(draftText, excludeNoteId, onProgress);  // DEV-LOCAL-MODE
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (sessionError || !accessToken) {
    throw new Error('Your session has expired. Sign in again to search your notes.');
  }

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/find-relevant-notes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ draft_text: draftText, exclude_note_id: excludeNoteId ?? null, stream: true }),
    });
  } catch (error) {
    // A missing Edge Function or failed CORS preflight surfaces as an opaque
    // "Failed to fetch" TypeError, which is useless to show a user.
    if (process.env.NODE_ENV !== 'production') console.error('Relevance search request failed:', error);
    throw new Error("We couldn't search your notes right now. Please try again.");
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Your session has expired. Sign in again to search your notes.');
    }
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    const message = typeof payload?.error === 'string' ? payload.error : null;
    throw new Error(message ?? "We couldn't search your notes right now. Please try again.");
  }

  return readRelevanceResponse(response, "We couldn't search your notes right now. Please try again.", onProgress);
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
  if (IS_LOCAL_MODE) return [];  // DEV-LOCAL-MODE
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
