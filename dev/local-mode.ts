/**
 * Local development mode: runs the app with no Supabase at all.
 *
 * Enabled with NEXT_PUBLIC_LOCAL_MODE=1 in .env.local. Notes live in the
 * browser, the user is faked, and relevance search goes to a Next.js route
 * handler instead of the Edge Function. Everything here is a development
 * convenience — the Supabase path remains the real one, and nothing in this
 * file runs unless the flag is set.
 */

import { DomainGoal, Note, NoteImportInput, RelevanceProgress, RelevantNotesResponse } from '@/lib/types';
import { readRelevanceResponse } from '@/lib/relevance-stream';
import { getAiMode } from '@/lib/ai-mode';
import { getSampleMode } from '@/lib/sample-mode';

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

function newNote(rawText: string, category: string | null, isSample = getSampleMode(LOCAL_USER_ID)): Note {
  return {
    id: crypto.randomUUID(),
    user_id: LOCAL_USER_ID,
    raw_text: rawText,
    is_sample: isSample,
    summary: null,
    target_date: null,
    time_of_day: null,
    category,
    category_updated_at: category ? new Date().toISOString() : null,
    created_at: new Date().toISOString(),
  };
}

/**
 * Only one set at a time, as on the server: the sample notes while exploring
 * them, otherwise your own. Notes shared with you live in vaults, apart.
 */
export function localGetNotes(): Note[] {
  const samples = getSampleMode(LOCAL_USER_ID);
  return readAll()
    .filter((note) => Boolean(note.is_sample) === samples && !note.vault_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ── Vaults: notes shared with you, one vault per person who shared ───────────

export type LocalVault = {
  id: string;
  /** Who shared. Local mode has one account, so links name the sharer instead. */
  sharerKey: string;
  name: string;
  useInRetrieval: boolean;
  linkId: string | null;
  linkCreatedAt: string | null;
  acceptedAt: string;
};

const VAULTS_KEY = 'ocreda-local-vaults';

export function localReadVaults(): LocalVault[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(VAULTS_KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as LocalVault[]) : [];
  } catch {
    return [];
  }
}

function writeVaults(vaults: LocalVault[]): void {
  localStorage.setItem(VAULTS_KEY, JSON.stringify(vaults));
}

/** Every vault's notes, newest first, each marked with who shared it. */
export function localVaultNotes(): Note[] {
  const names = new Map(localReadVaults().map((vault) => [vault.id, vault.name]));
  return readAll()
    .filter((note) => note.vault_id && names.has(note.vault_id))
    .map((note) => ({ ...note, shared_by: names.get(note.vault_id!) ?? null, category: null }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function localSetVaultInRetrieval(vaultId: string, on: boolean): void {
  writeVaults(localReadVaults().map((vault) => vault.id === vaultId ? { ...vault, useInRetrieval: on } : vault));
}

export function localRemoveVault(vaultId: string): void {
  writeVaults(localReadVaults().filter((vault) => vault.id !== vaultId));
  writeAll(readAll().filter((note) => note.vault_id !== vaultId));
}

/** As accept_shared_link does on the server: added, updated, already, or older. */
export function localAcceptIntoVault(link: { id: string; createdAt: string; sharerKey: string; sharerName: string; notes: Array<{ rawText: string; notedAt: string }> }): { vaultId: string; vaultName: string; status: 'added' | 'updated' | 'already' | 'older'; notes: number } {
  const vaults = localReadVaults();
  const existing = vaults.find((vault) => vault.sharerKey === link.sharerKey);
  if (existing && existing.linkId === link.id) return { vaultId: existing.id, vaultName: existing.name, status: 'already', notes: 0 };
  if (existing && existing.linkCreatedAt && existing.linkCreatedAt > link.createdAt) return { vaultId: existing.id, vaultName: existing.name, status: 'older', notes: 0 };
  const vault: LocalVault = existing
    ? { ...existing, name: link.sharerName, linkId: link.id, linkCreatedAt: link.createdAt, acceptedAt: new Date().toISOString() }
    : { id: crypto.randomUUID(), sharerKey: link.sharerKey, name: link.sharerName, useInRetrieval: true, linkId: link.id, linkCreatedAt: link.createdAt, acceptedAt: new Date().toISOString() };
  writeVaults([...vaults.filter((item) => item.id !== vault.id), vault]);
  const texts = new Set(link.notes.map((note) => note.rawText));
  // Notes no longer shared go; unchanged ones keep their id.
  const kept = readAll().filter((note) => note.vault_id !== vault.id || texts.has(note.raw_text));
  const have = new Set(kept.filter((note) => note.vault_id === vault.id).map((note) => note.raw_text));
  const added: Note[] = [];
  link.notes.forEach((shared) => {
    if (have.has(shared.rawText)) return;
    have.add(shared.rawText);
    added.push({ ...newNote(shared.rawText, null, false), vault_id: vault.id, created_at: shared.notedAt });
  });
  writeAll([...added, ...kept]);
  return { vaultId: vault.id, vaultName: vault.name, status: existing ? 'updated' : 'added', notes: added.length };
}

/** Saves the sample vault, with the dates it should appear to have been written on. */
export function localAddSampleNotes(inputs: Array<{ rawText: string; createdAt: string }>): Note[] {
  const created = inputs.map((input) => ({ ...newNote(input.rawText, null, true), created_at: input.createdAt }));
  writeAll([...created, ...readAll()]);
  return created;
}

export function localRemoveSampleNotes(): void {
  writeAll(readAll().filter((note) => !note.is_sample));
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
  if (notes[index].vault_id && rawText !== notes[index].raw_text) throw new Error('Shared notes cannot be changed');
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
/**
 * The choices made on cards in this browser, as lib/card-decisions.ts keeps
 * them in local mode. Read here directly, since importing that module would
 * make the two import each other.
 */
function localCardDecisionRows(): unknown[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(`ocreda-card-decisions:v2:${LOCAL_USER_ID}`) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function localFindRelevantNotes(
  draftText: string,
  excludeNoteId?: string | null,
  onProgress?: (progress: RelevanceProgress) => void,
  domain?: DomainGoal | null,
  signal?: AbortSignal,
): Promise<RelevantNotesResponse> {
  // Your own notes first, then the vaults you use in retrieval, as on the server.
  const inRetrieval = new Set(localReadVaults().filter((vault) => vault.useInRetrieval).map((vault) => vault.id));
  const shared = localVaultNotes().filter((note) => note.vault_id && inRetrieval.has(note.vault_id));
  const notes = [...localGetNotes(), ...(getSampleMode(LOCAL_USER_ID) ? [] : shared)]
    .filter((note) => note.id !== excludeNoteId)
    .map((note) => ({
      id: note.id,
      raw_text: note.raw_text,
      summary: note.summary,
      created_at: note.created_at,
      category: note.category,
      shared_by: note.shared_by ?? null,
    }));

  const response = await fetch('/api/find-relevant-notes', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      draft_text: draftText, notes, exclude_note_id: excludeNoteId ?? null, card_decisions: localCardDecisionRows(),
      domain: domain ?? null, model_tier: getAiMode(), stream: true,
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const message = typeof payload?.error === 'string' ? payload.error : null;
    throw new Error(message ?? "We couldn't search your notes right now. Please try again.");
  }

  return readRelevanceResponse(response, "We couldn't search your notes right now. Please try again.", onProgress);
}
