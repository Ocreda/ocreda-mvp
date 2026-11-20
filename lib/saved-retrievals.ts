import { supabase } from './supabase';
import { IS_LOCAL_MODE } from '@/dev/local-mode';  // DEV-LOCAL-MODE

/**
 * The last retrieval run for a note, kept in Supabase (note_retrievals) so it
 * follows the person to every device: a note searched on one device opens
 * with the same results on another, without running the AI calls again.
 * The browser keeps its own copy for instant display; this is the shared one.
 * In local mode, or before the table exists, nothing is shared.
 */

export type SharedRetrieval = {
  signature: string;
  mode: 'similar' | 'relevant';
  /** Checked by the caller, which knows the shape of a search. */
  search: unknown;
  /** When it was saved, to tell which of two copies is newer. */
  savedAt: string;
};

const TABLE = 'note_retrievals';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A slow answer should not hold up the note: past this, the caller goes on without it. */
const LOAD_TIMEOUT_MS = 4000;

/** Set once the table is found missing, so later calls skip the round trip. */
let tableMissing = false;

function isMissingTable(error: { code?: string; message?: string }): boolean {
  const message = (error.message ?? '').toLowerCase();
  return error.code === '42P01' || error.code === 'PGRST205' || (message.includes(TABLE) && (message.includes('does not exist') || message.includes('schema cache')));
}

function usable(noteId: string): boolean {
  return !IS_LOCAL_MODE && !tableMissing && UUID.test(noteId);
}

/** The saved retrieval for a note in this format version, or null when there is none (or it can't be reached in time). */
export async function loadSharedRetrieval(noteId: string, version: string): Promise<SharedRetrieval | null> {
  if (!usable(noteId)) return null;
  const query = supabase
    .from(TABLE)
    .select('signature,mode,search,updated_at')
    .eq('note_id', noteId)
    .eq('version', version)
    .maybeSingle()
    .then(({ data, error }) => {
      if (error) {
        if (isMissingTable(error)) tableMissing = true;
        return null;
      }
      if (!data || (data.mode !== 'similar' && data.mode !== 'relevant') || typeof data.signature !== 'string') return null;
      return { signature: data.signature, mode: data.mode, search: data.search, savedAt: data.updated_at } as SharedRetrieval;
    });
  const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), LOAD_TIMEOUT_MS));
  return Promise.race([query, timeout]).catch(() => null);
}

/**
 * The notes whose saved retrieval used this one, as a related note or in a
 * card, on any device. Empty when the database can't be reached.
 */
export async function loadNotesUsing(noteId: string, version: string): Promise<string[]> {
  if (!usable(noteId)) return [];
  try {
    const select = () => supabase.from(TABLE).select('note_id').eq('version', version).neq('note_id', noteId);
    const [asResult, inCard] = await Promise.all([
      select().contains('search', { results: [{ note_id: noteId }] }),
      select().contains('search', { insights: [{ note_ids: [noteId] }] }),
    ]);
    for (const { error } of [asResult, inCard]) if (error && isMissingTable(error)) tableMissing = true;
    const rows = [...(asResult.data ?? []), ...(inCard.data ?? [])] as { note_id: string }[];
    return Array.from(new Set(rows.map((row) => row.note_id)));
  } catch {
    return [];
  }
}

/** Saves a note's retrieval for every device. Failures are ignored: the browser copy still works. */
export function storeSharedRetrieval(noteId: string, version: string, entry: Omit<SharedRetrieval, 'savedAt'>): void {
  if (!usable(noteId)) return;
  void (async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) return;
    const { error } = await supabase.from(TABLE).upsert(
      { user_id: data.user.id, note_id: noteId, version, signature: entry.signature, mode: entry.mode, search: entry.search },
      { onConflict: 'user_id,note_id' },
    );
    if (error && isMissingTable(error)) tableMissing = true;
  })().catch(() => undefined);
}
