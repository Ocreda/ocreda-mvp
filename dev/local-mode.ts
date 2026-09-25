/**
 * Local development mode: runs the app with no Supabase at all.
 *
 * Enabled with NEXT_PUBLIC_LOCAL_MODE=1 in .env.local. Notes live in the
 * browser, the user is faked, and relevance search goes to a Next.js route
 * handler instead of the Edge Function. Everything here is a development
 * convenience — the Supabase path remains the real one, and nothing in this
 * file runs unless the flag is set.
 */

import { Note, NoteImportInput, RelevanceProgress, RelevantNotesResponse } from '@/lib/types';
import { readRelevanceResponse } from '@/lib/relevance-stream';

export const IS_LOCAL_MODE = process.env.NEXT_PUBLIC_LOCAL_MODE === '1';

/** A stable fake account, so localStorage keys scoped by user id still work. */
export const LOCAL_USER_ID = '00000000-0000-4000-8000-000000000001';

export const LOCAL_USER = {
  id: LOCAL_USER_ID,
  email: 'local@ocreda.test',
  user_metadata: { full_name: 'Local' },
  app_metadata: {},
  aud: 'authenticated',
  created_at: new Date(0).toISOString(),
};

const STORAGE_KEY = 'ocreda-local-notes';

function readAll(): Note[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as Note[]) : [];
  } catch {
    return [];
  }
}

function writeAll(notes: Note[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch (error) {
    // Quota is the realistic failure here, and silently losing an import would
    // be worse than a visible error.
    throw new Error('Could not save notes locally — your browser storage may be full.');
  }
}

function newNote(rawText: string, category: string | null): Note {
  return {
    id: crypto.randomUUID(),
    user_id: LOCAL_USER_ID,
    raw_text: rawText,
    summary: null,
    target_date: null,
    time_of_day: null,
    category,
    category_updated_at: category ? new Date().toISOString() : null,
    created_at: new Date().toISOString(),
  };
}

export function localGetNotes(): Note[] {
  return readAll().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function localCreateNote(rawText: string, category: string | null): Note {
  const note = newNote(rawText, category);
  writeAll([note, ...readAll()]);
  return note;
}

export function localImportNotes(
  inputs: NoteImportInput[],
  onProgress?: (completed: number, total: number) => void
): Note[] {
  const created = inputs.map((input) => newNote(input.rawText, input.category));
  writeAll([...created, ...readAll()]);
  onProgress?.(inputs.length, inputs.length);
  return created;
}

export function localUpdateNote(noteId: string, rawText: string, category?: string | null): Note {
  const notes = readAll();
  const index = notes.findIndex((note) => note.id === noteId);
  if (index === -1) throw new Error('Note not found');
  const updated: Note = {
    ...notes[index],
    raw_text: rawText,
    ...(category !== undefined ? { category, category_updated_at: new Date().toISOString() } : {}),
  };
  notes[index] = updated;
  writeAll(notes);
  return updated;
}

export function localDeleteNote(noteId: string): void {
  writeAll(readAll().filter((note) => note.id !== noteId));
}

export function localMoveNotesToCategory(noteIds: string[], category: string | null): Note[] {
  const ids = new Set(noteIds);
  const stamp = new Date().toISOString();
  const notes = readAll().map((note) =>
    ids.has(note.id) ? { ...note, category, category_updated_at: stamp } : note
  );
  writeAll(notes);
  return notes.filter((note) => ids.has(note.id));
}

/**
 * Posts the browser's notes to the local route handler, which runs the same
 * fan-out the Edge Function does. The notes travel in the request because
 * there is no database for the server to read them from.
 */
export async function localFindRelevantNotes(
  draftText: string,
  excludeNoteId?: string | null,
  onProgress?: (progress: RelevanceProgress) => void
): Promise<RelevantNotesResponse> {
  const notes = localGetNotes()
    .filter((note) => note.id !== excludeNoteId)
    .map((note) => ({
      id: note.id,
      raw_text: note.raw_text,
      summary: note.summary,
      created_at: note.created_at,
    }));

  const response = await fetch('/api/find-relevant-notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft_text: draftText, notes, stream: true }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const message = typeof payload?.error === 'string' ? payload.error : null;
    throw new Error(message ?? "We couldn't search your notes right now. Please try again.");
  }

  return readRelevanceResponse(response, "We couldn't search your notes right now. Please try again.", onProgress);
}
