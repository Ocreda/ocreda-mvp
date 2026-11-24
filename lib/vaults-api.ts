import { supabase } from './supabase';
import { Note } from './types';
import {
  IS_LOCAL_MODE,
  localReadVaults,
  localRemoveVault,
  localSetVaultInRetrieval,
  localVaultNotes,
} from '@/dev/local-mode';  // DEV-LOCAL-MODE

/**
 * Vaults: notes other people shared with you, one vault per person
 * (docs/shared-note-vaults-plan.md). They sit apart from your own notes. Your
 * drafts search the vaults that are used in retrieval (all of them unless
 * switched off), but a shared note is never searched itself and never edited.
 * Each vault is shown as a single Domain for now.
 */

export type Vault = {
  id: string;
  /** The name of the person who shared, as of the last accepted link. */
  name: string;
  useInRetrieval: boolean;
  acceptedAt: string;
  /** Newest first. Each is marked with `vault_id` and `shared_by`. */
  notes: Note[];
};

const NOTE_FIELDS = 'id, user_id, raw_text, summary, target_date, time_of_day, created_at, vault_id';
const PAGE_SIZE = 1000;

type SupabaseLikeError = { code?: string; message?: string };

/** Before the vaults migration is applied there is nothing to list, rather than an error. */
function isMissingVaults(error: SupabaseLikeError | null): boolean {
  const message = error?.message?.toLowerCase() ?? '';
  return error?.code === '42P01' || error?.code === 'PGRST205' || error?.code === '42703'
    || (message.includes('vault') && (message.includes('does not exist') || message.includes('schema cache')));
}

export async function listVaults(): Promise<Vault[]> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    const notes = localVaultNotes();
    return localReadVaults()
      .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))
      .map((vault) => ({ id: vault.id, name: vault.name, useInRetrieval: vault.useInRetrieval, acceptedAt: vault.acceptedAt, notes: notes.filter((note) => note.vault_id === vault.id) }));
  }
  const { data: rows, error } = await supabase.from('vaults')
    .select('id,name,use_in_retrieval,accepted_at')
    .order('accepted_at', { ascending: false });
  if (error) {
    if (isMissingVaults(error)) return [];
    throw error;
  }
  if (!rows?.length) return [];
  const names = new Map(rows.map((row) => [row.id as string, row.name as string]));
  const notes: Note[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error: notesError } = await supabase.from('notes')
      .select(NOTE_FIELDS)
      .in('vault_id', Array.from(names.keys()))
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (notesError) throw notesError;
    (data ?? []).forEach((row) => {
      const note = row as unknown as Note;
      notes.push({ ...note, category: null, category_updated_at: null, shared_by: names.get(note.vault_id ?? '') ?? null });
    });
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows.map((row) => ({
    id: row.id, name: row.name, useInRetrieval: row.use_in_retrieval !== false, acceptedAt: row.accepted_at,
    notes: notes.filter((note) => note.vault_id === row.id),
  }));
}

/** Whether your drafts search this vault. */
export async function setVaultInRetrieval(vaultId: string, on: boolean): Promise<void> {
  if (IS_LOCAL_MODE) { localSetVaultInRetrieval(vaultId, on); return; }  // DEV-LOCAL-MODE
  const { error } = await supabase.from('vaults').update({ use_in_retrieval: on }).eq('id', vaultId);
  if (error) throw error;
}

/** Removes a vault and every note in it. The person can accept their link again to get them back. */
export async function removeVault(vaultId: string): Promise<void> {
  if (IS_LOCAL_MODE) { localRemoveVault(vaultId); return; }  // DEV-LOCAL-MODE
  const { error } = await supabase.from('vaults').delete().eq('id', vaultId);
  if (error) throw error;
}
