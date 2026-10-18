import { supabase } from './supabase';
import { getNotes } from './notes-api';
import { clearSampleWorkspace, setSampleMode } from './sample-mode';
import { Note } from './types';
import { IS_LOCAL_MODE, localAddSampleNotes, localGetNotes, localRemoveSampleNotes } from '@/dev/local-mode';  // DEV-LOCAL-MODE

/**
 * The sample vault lives in each person's own notes table, flagged is_sample,
 * so it is searched exactly as their own notes are. It is copied in the first
 * time they choose to explore it, and only then.
 */

export type SampleDomain = { title: string; description: string };

export type SampleVault = {
  notes: Note[];
  domains: ReadonlyArray<SampleDomain>;
  /** The sample Domain a note was written for, or null for one the person added. */
  domainOf: (note: Note) => string | null;
  /** Always shown pinned, so it is the first thing anyone opens. */
  pinnedDomain: string;
  /** True when this load copied the vault in, so its notes have no Domains yet. */
  copied: boolean;
};

const START_HERE = 'Start here';
const INSERT_BATCH_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function titleOf(text: string): string {
  return text.trim().split('\n')[0].trim();
}

/** A small stable hash, so the spread of dates is the same for everyone. */
function hash(value: string): number {
  let result = 0;
  for (const character of value) result = (result * 31 + character.charCodeAt(0)) >>> 0;
  return result;
}

/**
 * Gives the notes the look of a vault built up over five months: Start here
 * is the newest, and the rest are spread out with the Domains mixed together.
 */
function datedSampleNotes(notes: ReadonlyArray<{ domain: string; text: string }>): Array<{ rawText: string; createdAt: string }> {
  const now = Date.now();
  const startHere = notes.filter((note) => note.domain === START_HERE);
  const rest = notes.filter((note) => note.domain !== START_HERE)
    .slice()
    .sort((left, right) => hash(titleOf(left.text)) - hash(titleOf(right.text)));
  return [
    ...startHere.map((note) => ({ rawText: note.text, createdAt: new Date(now).toISOString() })),
    ...rest.map((note, index) => ({
      rawText: note.text,
      createdAt: new Date(now - (index + 1) * 2.3 * DAY_MS - (hash(note.text) % 12) * 60 * 60 * 1000).toISOString(),
    })),
  ];
}

async function hasSampleNotes(): Promise<boolean> {
  if (IS_LOCAL_MODE) return localGetNotes().some((note) => note.is_sample);  // DEV-LOCAL-MODE
  const { count, error } = await supabase.from('notes').select('id', { count: 'exact', head: true }).eq('is_sample', true);
  if (error) throw error;
  return (count ?? 0) > 0;
}

async function addSampleNotes(inputs: Array<{ rawText: string; createdAt: string }>): Promise<void> {
  if (IS_LOCAL_MODE) { localAddSampleNotes(inputs); return; }  // DEV-LOCAL-MODE
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) throw new Error('Your session has expired. Sign in again to load the sample notes.');
  const insertedIds: string[] = [];
  try {
    for (let start = 0; start < inputs.length; start += INSERT_BATCH_SIZE) {
      const { data, error } = await supabase.from('notes')
        .insert(inputs.slice(start, start + INSERT_BATCH_SIZE).map((input) => ({
          user_id: authData.user.id,
          raw_text: input.rawText,
          is_sample: true,
          created_at: input.createdAt,
        })))
        .select('id');
      if (error) throw error;
      insertedIds.push(...(data ?? []).map((row) => row.id as string));
    }
  } catch (error) {
    // Half a vault is worse than none: the next attempt starts clean.
    if (insertedIds.length) await supabase.from('notes').delete().in('id', insertedIds);
    throw error;
  }
}

/** The sample vault's "Start here" note: a guide to the app, so it is never searched. */
export function isSampleGuide(note: Note): boolean {
  return Boolean(note.is_sample) && titleOf(note.raw_text) === START_HERE;
}

let pendingLoad: Promise<{ notes: Note[]; copied: boolean }> | null = null;

/**
 * The sample notes, copying the vault in first if this account has none.
 * Call it only while sample mode is on. Concurrent calls share one load, so
 * the vault is never copied twice.
 */
export async function loadSampleVault(): Promise<SampleVault> {
  const { SAMPLE_DOMAINS, SAMPLE_NOTES } = await import('./sample-vault-data');
  pendingLoad ??= (async () => {
    const copied = !(await hasSampleNotes());
    if (copied) await addSampleNotes(datedSampleNotes(SAMPLE_NOTES));
    return { notes: await getNotes(), copied };
  })().finally(() => { pendingLoad = null; });
  const { notes, copied } = await pendingLoad;
  const domainByTitle = new Map(SAMPLE_NOTES.map((note) => [titleOf(note.text).toLowerCase(), note.domain]));
  return {
    notes,
    domains: SAMPLE_DOMAINS,
    domainOf: (note) => domainByTitle.get(titleOf(note.raw_text).toLowerCase()) ?? null,
    pinnedDomain: START_HERE,
    copied,
  };
}

/**
 * Deletes every sample note, including any the person wrote while exploring,
 * forgets the sample Domains, and returns them to their own notes.
 */
export async function removeSampleNotes(userId: string): Promise<void> {
  if (IS_LOCAL_MODE) {  // DEV-LOCAL-MODE
    localRemoveSampleNotes();
  } else {
    const { error } = await supabase.from('notes').delete().eq('user_id', userId).eq('is_sample', true);
    if (error) throw error;
  }
  clearSampleWorkspace(userId);
  setSampleMode(userId, false);
}
